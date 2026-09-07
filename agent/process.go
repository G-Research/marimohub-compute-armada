package main

import (
	"encoding/json"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// dialPause is how long the port waiter rests between failed connects.
const dialPause = 50 * time.Millisecond

// dialTimeout bounds one connect attempt against a blackholed port, so the
// final attempt cannot run far past the caller's deadline.
const dialTimeout = 500 * time.Millisecond

// startedProcess is one detached process this agent started and still answers
// for: the kernel, usually. The agent is its parent, so liveness and the exit
// status come from Wait itself rather than from reading /proc.
type startedProcess struct {
	pid     int
	logPath string
	// Closed once Wait has collected the exit status.
	done     chan struct{}
	exitCode int
}

func (p *startedProcess) exited() (int, bool) {
	select {
	case <-p.done:
		return p.exitCode, true
	default:
		return 0, false
	}
}

type startProcessRequest struct {
	Cmd []string `json:"cmd"`
	// Empty means the agent's own working directory, the image's WORKDIR.
	Cwd string `json:"cwd"`
}

// startProcess launches a command that outlives its request: its own session,
// stdin closed, output to a log file the agent owns. The response names the
// pid, which is the handle every other process endpoint takes.
func (a *agent) startProcess(w http.ResponseWriter, r *http.Request) {
	var req startProcessRequest
	body := http.MaxBytesReader(w, r.Body, maxRequestBytes)
	if err := json.NewDecoder(body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "bad request: "+err.Error())
		return
	}
	if len(req.Cmd) == 0 {
		writeError(w, http.StatusBadRequest, "cmd must not be empty")
		return
	}
	logFile, err := os.CreateTemp("", "mh-proc-*.log")
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	cmd := exec.Command(req.Cmd[0], req.Cmd[1:]...)
	// Its own session, like every /exec command, so a signal to the negated
	// pid reaches the whole tree it starts.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.Dir = req.Cwd
	if err := cmd.Start(); err != nil {
		_ = logFile.Close()
		_ = os.Remove(logFile.Name())
		writeError(w, http.StatusInternalServerError, "cannot start "+req.Cmd[0]+": "+err.Error())
		return
	}
	// The child holds its own descriptor to the log from here.
	_ = logFile.Close()

	proc := &startedProcess{pid: cmd.Process.Pid, logPath: logFile.Name(), done: make(chan struct{})}
	a.children.Store(proc.pid, struct{}{})
	a.mu.Lock()
	a.started[proc.pid] = proc
	a.mu.Unlock()
	go func() {
		// The error is the exit status, which ProcessState reports either way.
		_ = cmd.Wait()
		proc.exitCode = cmd.ProcessState.ExitCode()
		a.children.Delete(proc.pid)
		close(proc.done)
	}()

	writeJSON(w, struct {
		Pid int `json:"pid"`
	}{Pid: proc.pid})
}

type processStatusResponse struct {
	Running  bool `json:"running"`
	ExitCode *int `json:"exitCode,omitempty"`
}

func (a *agent) processStatus(w http.ResponseWriter, r *http.Request) {
	proc, ok := a.startedByQuery(w, r)
	if !ok {
		return
	}
	if code, exited := proc.exited(); exited {
		writeJSON(w, processStatusResponse{Running: false, ExitCode: &code})
		return
	}
	writeJSON(w, processStatusResponse{Running: true})
}

// processLogs returns everything the process printed, on either stream. A log
// that cannot be read is an empty one: the file goes with the pod, so the only
// ordinary reason is that nothing was written yet.
func (a *agent) processLogs(w http.ResponseWriter, r *http.Request) {
	proc, ok := a.startedByQuery(w, r)
	if !ok {
		return
	}
	data, err := os.ReadFile(proc.logPath)
	if err != nil {
		data = nil
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write(data)
}

// signals names the signals a caller may send. marimohub's adapters only ever
// send TERM and KILL; the rest cost nothing and a name outside the map is a
// caller error worth reporting.
var signals = map[string]syscall.Signal{
	"TERM": syscall.SIGTERM,
	"KILL": syscall.SIGKILL,
	"INT":  syscall.SIGINT,
	"HUP":  syscall.SIGHUP,
	"QUIT": syscall.SIGQUIT,
	"USR1": syscall.SIGUSR1,
	"USR2": syscall.SIGUSR2,
}

type signalRequest struct {
	Pid int `json:"pid"`
	// TERM when empty. `SIGTERM` and `term` are accepted spellings of it.
	Signal string `json:"signal"`
}

// signalProcess signals the whole process group, the negated pid, not the one
// process. Every process is started as its own session leader (Setsid), so its
// pid is its group id, and the `sh -lc` wrapper the adapter launches may fork
// the real command rather than exec it: signalling only the leader would then
// leave the kernel, and anything a notebook spawned, orphaned and running in
// the pod until it is destroyed. A TERM to the group is what a stop means.
func (a *agent) signalProcess(w http.ResponseWriter, r *http.Request) {
	var req signalRequest
	body := http.MaxBytesReader(w, r.Body, maxRequestBytes)
	if err := json.NewDecoder(body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "bad request: "+err.Error())
		return
	}
	name := req.Signal
	if name == "" {
		name = "TERM"
	}
	sig, known := signals[strings.TrimPrefix(strings.ToUpper(name), "SIG")]
	if !known {
		writeError(w, http.StatusBadRequest, "unknown signal: "+req.Signal)
		return
	}
	a.mu.Lock()
	proc := a.started[req.Pid]
	a.mu.Unlock()
	if proc == nil {
		writeError(w, http.StatusNotFound, "unknown pid: "+strconv.Itoa(req.Pid))
		return
	}
	// A group that is already gone is not an error: killing is best effort,
	// as the shell's `kill ... || true` was.
	_ = syscall.Kill(-proc.pid, sig)
	writeJSON(w, struct{}{})
}

type waitPortRequest struct {
	Port      int   `json:"port"`
	TimeoutMs int64 `json:"timeoutMs"`
	// When set, the wait also ends if this process exits: a kernel that died
	// will never open its port, and its caller should hear "crashed", not
	// "timed out".
	Pid int `json:"pid"`
}

type waitPortResponse struct {
	Open     bool `json:"open"`
	Exited   bool `json:"exited,omitempty"`
	ExitCode *int `json:"exitCode,omitempty"`
}

// waitPort connects to 127.0.0.1:port until it answers, the deadline passes,
// or the watched process exits. In-pod for the reason the old in-pod waiter
// was: polling from outside pays a round trip per probe.
func (a *agent) waitPort(w http.ResponseWriter, r *http.Request) {
	var req waitPortRequest
	body := http.MaxBytesReader(w, r.Body, maxRequestBytes)
	if err := json.NewDecoder(body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "bad request: "+err.Error())
		return
	}
	if req.Port < 1 || req.Port > 65535 {
		writeError(w, http.StatusBadRequest, "port must be between 1 and 65535")
		return
	}
	var proc *startedProcess
	if req.Pid != 0 {
		a.mu.Lock()
		proc = a.started[req.Pid]
		a.mu.Unlock()
		if proc == nil {
			writeError(w, http.StatusNotFound, "unknown pid: "+strconv.Itoa(req.Pid))
			return
		}
	}

	deadline := time.Now().Add(time.Duration(req.TimeoutMs) * time.Millisecond)
	address := net.JoinHostPort("127.0.0.1", strconv.Itoa(req.Port))
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			writeJSON(w, waitPortResponse{Open: false})
			return
		}
		conn, err := net.DialTimeout("tcp", address, min(remaining, dialTimeout))
		if err == nil {
			_ = conn.Close()
			writeJSON(w, waitPortResponse{Open: true})
			return
		}
		// Checked after the connect, so a process that opened the port and then
		// exited still reports the port it managed to open.
		if proc != nil {
			if code, exited := proc.exited(); exited {
				writeJSON(w, waitPortResponse{Open: false, Exited: true, ExitCode: &code})
				return
			}
		}
		select {
		case <-r.Context().Done():
			// The caller is gone; there is nobody to answer.
			return
		case <-time.After(dialPause):
		}
	}
}

// startedByQuery resolves the `pid` query parameter to a process this agent
// started, writing the error itself when it cannot.
func (a *agent) startedByQuery(w http.ResponseWriter, r *http.Request) (*startedProcess, bool) {
	pid, err := strconv.Atoi(r.URL.Query().Get("pid"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "pid must be a number")
		return nil, false
	}
	a.mu.Lock()
	proc := a.started[pid]
	a.mu.Unlock()
	if proc == nil {
		writeError(w, http.StatusNotFound, "unknown pid: "+strconv.Itoa(pid))
		return nil, false
	}
	return proc, true
}
