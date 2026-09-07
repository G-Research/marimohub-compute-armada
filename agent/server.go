package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
)

// maxRequestBytes bounds one request body. Files arrive raw in a PUT body, so
// this is the ceiling on one file write.
const maxRequestBytes = 1 << 30

// killGrace is how long a command gets between SIGTERM and SIGKILL once its
// caller is gone or its deadline has passed.
const killGrace = 5 * time.Second

// chunkSize bounds one stdout or stderr event.
const chunkSize = 32 * 1024

type agent struct {
	tokenHash []byte
	// Direct children still to be collected by their own Wait. The orphan
	// reaper leaves these alone, or it would steal their exit status.
	children sync.Map
	// Detached processes started through /process/start, by pid. Entries are
	// kept after exit, so a dead process still answers for its status and log.
	mu      sync.Mutex
	started map[int]*startedProcess
}

func newAgent(tokenHash []byte) *agent {
	return &agent{tokenHash: tokenHash, started: map[int]*startedProcess{}}
}

func (a *agent) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "ok\n")
	})
	mux.HandleFunc("POST /exec", a.authenticated(a.exec))
	mux.HandleFunc("POST /process/start", a.authenticated(a.startProcess))
	mux.HandleFunc("GET /process/status", a.authenticated(a.processStatus))
	mux.HandleFunc("GET /process/logs", a.authenticated(a.processLogs))
	mux.HandleFunc("POST /process/signal", a.authenticated(a.signalProcess))
	mux.HandleFunc("POST /process/waitport", a.authenticated(a.waitPort))
	mux.HandleFunc("PUT /files", a.authenticated(a.writeFile))
	mux.HandleFunc("GET /files", a.authenticated(a.readFile))
	mux.HandleFunc("GET /files/list", a.authenticated(a.listFiles))
	return mux
}

func (a *agent) owns(pid int) bool {
	_, ok := a.children.Load(pid)
	return ok
}

func (a *agent) authenticated(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok {
			writeError(w, http.StatusUnauthorized, "missing bearer token")
			return
		}
		sum := sha256.Sum256([]byte(token))
		if !tokenMatches(sum[:], a.tokenHash) {
			writeError(w, http.StatusUnauthorized, "wrong token")
			return
		}
		next(w, r)
	}
}

type execRequest struct {
	Cmd []string `json:"cmd"`
	// Base64. Absent means the command reads from /dev/null.
	Stdin *string `json:"stdin"`
	// Zero means no deadline.
	TimeoutMs int64 `json:"timeoutMs"`
}

// execEvent is one line of the response. Exactly one field is set per line,
// except the final line, which carries Exit and possibly TimedOut.
type execEvent struct {
	Pid      int    `json:"pid,omitempty"`
	Stdout   []byte `json:"stdout,omitempty"`
	Stderr   []byte `json:"stderr,omitempty"`
	Exit     *int   `json:"exit,omitempty"`
	TimedOut bool   `json:"timedOut,omitempty"`
	Error    string `json:"error,omitempty"`
}

func (a *agent) exec(w http.ResponseWriter, r *http.Request) {
	var req execRequest
	body := http.MaxBytesReader(w, r.Body, maxRequestBytes)
	if err := json.NewDecoder(body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "bad request: "+err.Error())
		return
	}
	if len(req.Cmd) == 0 {
		writeError(w, http.StatusBadRequest, "cmd must not be empty")
		return
	}
	var stdin []byte
	if req.Stdin != nil {
		decoded, err := base64.StdEncoding.DecodeString(*req.Stdin)
		if err != nil {
			writeError(w, http.StatusBadRequest, "stdin is not base64: "+err.Error())
			return
		}
		stdin = decoded
	}

	ctx := r.Context()
	if req.TimeoutMs > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(req.TimeoutMs)*time.Millisecond)
		defer cancel()
	}

	cmd := exec.Command(req.Cmd[0], req.Cmd[1:]...)
	// Its own session, so the whole tree it starts can be addressed as one
	// process group. A child that calls setsid itself, as the kernel launch
	// does, leaves the group on purpose and outlives the request.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := cmd.Start(); err != nil {
		// A missing interpreter is the usual reason, and it is worth telling
		// apart from a command that ran and failed.
		writeError(w, http.StatusInternalServerError, "cannot start "+req.Cmd[0]+": "+err.Error())
		return
	}
	pid := cmd.Process.Pid
	a.children.Store(pid, struct{}{})
	defer a.children.Delete(pid)

	w.Header().Set("Content-Type", "application/x-ndjson")
	w.WriteHeader(http.StatusOK)
	out := newEventWriter(w)
	out.send(execEvent{Pid: pid})

	// When the caller disconnects or the deadline passes, the group dies. The
	// output readers then reach EOF and the exit status follows as usual.
	exited := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			killGroup(pid, exited)
		case <-exited:
		}
	}()

	var readers sync.WaitGroup
	readers.Add(2)
	go func() {
		defer readers.Done()
		forward(stdout, func(chunk []byte) { out.send(execEvent{Stdout: chunk}) })
	}()
	go func() {
		defer readers.Done()
		forward(stderr, func(chunk []byte) { out.send(execEvent{Stderr: chunk}) })
	}()
	// Wait must not run before the pipes are drained, and the pipes only
	// close when the last process holding them exits. A background child that
	// kept them open holds the request open too, exactly as a Kubernetes exec
	// would, so a detached launch redirects them.
	readers.Wait()
	err = cmd.Wait()
	close(exited)

	code := cmd.ProcessState.ExitCode()
	if err != nil && code == 0 {
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) {
			out.send(execEvent{Error: err.Error()})
			return
		}
	}
	out.send(execEvent{Exit: &code, TimedOut: errors.Is(ctx.Err(), context.DeadlineExceeded)})
}

// killGroup asks a process group to stop, then insists.
func killGroup(pid int, exited <-chan struct{}) {
	// A group that has already gone is not an error worth reporting.
	_ = syscall.Kill(-pid, syscall.SIGTERM)
	select {
	case <-exited:
	case <-time.After(killGrace):
		_ = syscall.Kill(-pid, syscall.SIGKILL)
	}
}

func forward(pipe io.Reader, send func([]byte)) {
	buf := make([]byte, chunkSize)
	for {
		n, err := pipe.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			send(chunk)
		}
		if err != nil {
			return
		}
	}
}

// eventWriter serialises lines from the two output readers and flushes each
// one, so a chunk reaches the caller when it is produced, not when the
// response ends.
type eventWriter struct {
	mu      sync.Mutex
	w       http.ResponseWriter
	flusher http.Flusher
	encoder *json.Encoder
}

func newEventWriter(w http.ResponseWriter) *eventWriter {
	flusher, _ := w.(http.Flusher)
	return &eventWriter{w: w, flusher: flusher, encoder: json.NewEncoder(w)}
}

func (e *eventWriter) send(event execEvent) {
	e.mu.Lock()
	defer e.mu.Unlock()
	// A write to a caller that has gone is an error nobody can hear.
	_ = e.encoder.Encode(event)
	if e.flusher != nil {
		e.flusher.Flush()
	}
}

// apiError is the body of every refused request. `code` names the refusal for
// a caller that must tell them apart, such as `not_found` against a file that
// was never written; the message is for a human reading a log.
type apiError struct {
	Error string `json:"error"`
	Code  string `json:"code,omitempty"`
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeCodedError(w, status, "", message)
}

func writeCodedError(w http.ResponseWriter, status int, code string, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(apiError{Error: message, Code: code})
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}

// shutdown forwards SIGTERM to everything and waits for it to take.
//
// As PID 1, a signal to -1 reaches every process in the container, which
// includes the kernel that was launched detached and is no request's child.
// Outside a container, only the groups this agent started are signalled.
func (a *agent) shutdown(grace time.Duration) {
	if os.Getpid() == 1 {
		_ = syscall.Kill(-1, syscall.SIGTERM)
	} else {
		a.children.Range(func(pid, _ any) bool {
			_ = syscall.Kill(-pid.(int), syscall.SIGTERM)
			return true
		})
	}
	deadline := time.Now().Add(grace)
	for time.Now().Before(deadline) {
		if !a.hasChildren() {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	log.Printf("children still running after %s, exiting anyway", grace)
}

func (a *agent) hasChildren() bool {
	found := false
	a.children.Range(func(_, _ any) bool {
		found = true
		return false
	})
	return found
}
