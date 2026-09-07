package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// request sends one authenticated request and returns the response.
func request(t *testing.T, server *httptest.Server, method, path string, body any) *http.Response {
	t.Helper()
	var reader io.Reader
	switch value := body.(type) {
	case nil:
	case []byte:
		reader = bytes.NewReader(value)
	default:
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(context.Background(), method, server.URL+path, reader)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+testToken)
	response, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func decode[T any](t *testing.T, response *http.Response) T {
	t.Helper()
	defer func() { _ = response.Body.Close() }()
	var value T
	if err := json.NewDecoder(response.Body).Decode(&value); err != nil {
		t.Fatal(err)
	}
	return value
}

func start(t *testing.T, server *httptest.Server, req startProcessRequest) int {
	t.Helper()
	response := request(t, server, http.MethodPost, "/process/start", req)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("start: status %d", response.StatusCode)
	}
	started := decode[struct {
		Pid int `json:"pid"`
	}](t, response)
	if started.Pid == 0 {
		t.Fatal("start returned no pid")
	}
	return started.Pid
}

// statusOf polls until the process has exited or the deadline passes.
func statusOf(t *testing.T, server *httptest.Server, pid int) processStatusResponse {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		response := request(t, server, http.MethodGet, "/process/status?pid="+strconv.Itoa(pid), nil)
		status := decode[processStatusResponse](t, response)
		if !status.Running || time.Now().After(deadline) {
			return status
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func logsOf(t *testing.T, server *httptest.Server, pid int) string {
	t.Helper()
	response := request(t, server, http.MethodGet, "/process/logs?pid="+strconv.Itoa(pid), nil)
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("logs: status %d", response.StatusCode)
	}
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestStartsADetachedProcessAndCollectsExitAndOutput(t *testing.T) {
	server := testServer(t)
	pid := start(t, server, startProcessRequest{Cmd: []string{"sh", "-c", "echo out; echo err 1>&2; exit 3"}})

	status := statusOf(t, server, pid)
	if status.Running || status.ExitCode == nil || *status.ExitCode != 3 {
		t.Fatalf("status %+v, want exited with code 3", status)
	}
	// Both streams land in the one log, as the shell's `>log 2>&1` did.
	logs := logsOf(t, server, pid)
	if !strings.Contains(logs, "out\n") || !strings.Contains(logs, "err\n") {
		t.Errorf("logs %q, want both streams", logs)
	}
}

func TestStartRunsInTheRequestedDirectory(t *testing.T) {
	server := testServer(t)
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	pid := start(t, server, startProcessRequest{Cmd: []string{"sh", "-c", "pwd"}, Cwd: dir})

	statusOf(t, server, pid)
	if logs := logsOf(t, server, pid); strings.TrimSpace(logs) != dir {
		t.Errorf("pwd printed %q, want %q", logs, dir)
	}
}

func TestStartReportsACommandThatCannotStart(t *testing.T) {
	server := testServer(t)
	response := request(t, server, http.MethodPost, "/process/start", startProcessRequest{Cmd: []string{"/no/such/binary"}})
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status %d, want 500", response.StatusCode)
	}
}

func TestSignalStopsAProcess(t *testing.T) {
	server := testServer(t)
	pid := start(t, server, startProcessRequest{Cmd: []string{"sleep", "30"}})

	response := request(t, server, http.MethodPost, "/process/signal", signalRequest{Pid: pid, Signal: "SIGTERM"})
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("signal: status %d", response.StatusCode)
	}
	if status := statusOf(t, server, pid); status.Running {
		t.Error("the process survived a TERM")
	}
}

func TestSignalReachesAForkedChild(t *testing.T) {
	server := testServer(t)
	// The parent shell forks the sleep and waits on it, so the pid the agent
	// holds is the shell, not the sleep. Signalling only that pid would leave
	// the sleep running; signalling the group takes both. The child records
	// its own pid so the test can check it directly.
	childFile := filepath.Join(t.TempDir(), "child.pid")
	pid := start(t, server, startProcessRequest{
		Cmd: []string{"sh", "-c", "sleep 30 & echo $! > " + childFile + "; wait"},
	})

	var child int
	deadline := time.Now().Add(2 * time.Second)
	for child == 0 && time.Now().Before(deadline) {
		if data, err := os.ReadFile(childFile); err == nil {
			child, _ = strconv.Atoi(strings.TrimSpace(string(data)))
		}
		if child == 0 {
			time.Sleep(20 * time.Millisecond)
		}
	}
	if child == 0 {
		t.Fatal("the child never recorded its pid")
	}

	response := request(t, server, http.MethodPost, "/process/signal", signalRequest{Pid: pid})
	_ = response.Body.Close()
	if status := statusOf(t, server, pid); status.Running {
		t.Error("the shell survived a group TERM")
	}
	// The forked child, addressed only through the group, is gone too.
	assertGone(t, child)
}

func TestSignalRefusesWhatItCannotSend(t *testing.T) {
	server := testServer(t)
	pid := start(t, server, startProcessRequest{Cmd: []string{"sh", "-c", "true"}})
	statusOf(t, server, pid)

	unknown := request(t, server, http.MethodPost, "/process/signal", signalRequest{Pid: pid, Signal: "WAT"})
	_ = unknown.Body.Close()
	if unknown.StatusCode != http.StatusBadRequest {
		t.Errorf("unknown signal: status %d, want 400", unknown.StatusCode)
	}
	missing := request(t, server, http.MethodPost, "/process/signal", signalRequest{Pid: 999999})
	_ = missing.Body.Close()
	if missing.StatusCode != http.StatusNotFound {
		t.Errorf("unknown pid: status %d, want 404", missing.StatusCode)
	}
	// A pid that exited is still known, and signalling it is a quiet success.
	gone := request(t, server, http.MethodPost, "/process/signal", signalRequest{Pid: pid})
	_ = gone.Body.Close()
	if gone.StatusCode != http.StatusOK {
		t.Errorf("exited pid: status %d, want 200", gone.StatusCode)
	}
}

func TestWaitPortSeesAPortOpen(t *testing.T) {
	server := testServer(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = listener.Close() }()
	port := listener.Addr().(*net.TCPAddr).Port

	response := request(t, server, http.MethodPost, "/process/waitport", waitPortRequest{Port: port, TimeoutMs: 2000})
	wait := decode[waitPortResponse](t, response)
	if !wait.Open {
		t.Errorf("got %+v, want open", wait)
	}
}

// closedPort reserves a port and closes it, so nothing answers there.
func closedPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	return port
}

func TestWaitPortTimesOut(t *testing.T) {
	server := testServer(t)
	response := request(t, server, http.MethodPost, "/process/waitport", waitPortRequest{Port: closedPort(t), TimeoutMs: 300})
	wait := decode[waitPortResponse](t, response)
	if wait.Open || wait.Exited {
		t.Errorf("got %+v, want a plain timeout", wait)
	}
}

func TestWaitPortReportsTheWatchedProcessExiting(t *testing.T) {
	server := testServer(t)
	pid := start(t, server, startProcessRequest{Cmd: []string{"sh", "-c", "exit 7"}})

	began := time.Now()
	response := request(t, server, http.MethodPost, "/process/waitport", waitPortRequest{Port: closedPort(t), TimeoutMs: 10_000, Pid: pid})
	wait := decode[waitPortResponse](t, response)
	if wait.Open || !wait.Exited || wait.ExitCode == nil || *wait.ExitCode != 7 {
		t.Errorf("got %+v, want exited with code 7", wait)
	}
	// The exit, not the deadline, is what ended the wait.
	if time.Since(began) > 3*time.Second {
		t.Errorf("took %s, the wait sat out the timeout", time.Since(began))
	}
}

func TestEveryEndpointRefusesWithoutTheToken(t *testing.T) {
	server := testServer(t)
	routes := []struct{ method, path string }{
		{http.MethodPost, "/exec"},
		{http.MethodPost, "/process/start"},
		{http.MethodGet, "/process/status?pid=1"},
		{http.MethodGet, "/process/logs?pid=1"},
		{http.MethodPost, "/process/signal"},
		{http.MethodPost, "/process/waitport"},
		{http.MethodPut, "/files?path=/tmp/x"},
		{http.MethodGet, "/files?path=/tmp/x"},
		{http.MethodGet, "/files/list?path=/tmp"},
	}
	for _, route := range routes {
		req, err := http.NewRequestWithContext(context.Background(), route.method, server.URL+route.path, strings.NewReader("{}"))
		if err != nil {
			t.Fatal(err)
		}
		response, err := server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		if response.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s %s: status %d, want 401", route.method, route.path, response.StatusCode)
		}
	}
}
