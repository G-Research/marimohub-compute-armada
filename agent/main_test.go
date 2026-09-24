package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

const testToken = "not-very-secret"

func testServer(t *testing.T) *httptest.Server {
	t.Helper()
	return testAgentServer(t, testAgent())
}

func testAgent() *agent {
	sum := sha256.Sum256([]byte(testToken))
	return newAgent(sum[:])
}

func testAgentServer(t *testing.T, a *agent) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(a.routes())
	t.Cleanup(server.Close)
	return server
}

func post(t *testing.T, ctx context.Context, server *httptest.Server, token string, req execRequest) *http.Response {
	t.Helper()
	body, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+"/exec", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

// run posts a command and collects every event.
func run(t *testing.T, server *httptest.Server, req execRequest) []execEvent {
	t.Helper()
	response := post(t, context.Background(), server, testToken, req)
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status %d", response.StatusCode)
	}
	var events []execEvent
	scanner := bufio.NewScanner(response.Body)
	for scanner.Scan() {
		var event execEvent
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			t.Fatalf("bad line %q: %v", scanner.Text(), err)
		}
		events = append(events, event)
	}
	return events
}

func collect(events []execEvent) (stdout, stderr string, exit int, timedOut bool) {
	exit = -999
	for _, event := range events {
		stdout += string(event.Stdout)
		stderr += string(event.Stderr)
		if event.Exit != nil {
			exit = *event.Exit
			timedOut = event.TimedOut
		}
	}
	return
}

func TestRefusesWithoutTheToken(t *testing.T) {
	server := testServer(t)
	for _, token := range []string{"", "wrong"} {
		response := post(t, context.Background(), server, token, execRequest{Cmd: []string{"true"}})
		_ = response.Body.Close()
		if response.StatusCode != http.StatusUnauthorized {
			t.Errorf("token %q: status %d, want 401", token, response.StatusCode)
		}
	}
}

func TestRunsACommandAndReportsEverything(t *testing.T) {
	events := run(t, testServer(t), execRequest{Cmd: []string{"sh", "-c", "echo out; echo err 1>&2; exit 3"}})
	stdout, stderr, exit, timedOut := collect(events)
	if stdout != "out\n" || stderr != "err\n" || exit != 3 || timedOut {
		t.Errorf("got stdout %q stderr %q exit %d timedOut %v", stdout, stderr, exit, timedOut)
	}
	if events[0].Pid == 0 {
		t.Error("the first event should name the pid")
	}
}

func TestPassesStdinAsBytes(t *testing.T) {
	content := base64.StdEncoding.EncodeToString([]byte("hello \x00 world\n"))
	stdout, _, exit, _ := collect(run(t, testServer(t), execRequest{Cmd: []string{"cat"}, Stdin: &content}))
	if exit != 0 || stdout != "hello \x00 world\n" {
		t.Errorf("got %q exit %d", stdout, exit)
	}
}

func TestReportsACommandThatCannotStart(t *testing.T) {
	response := post(t, context.Background(), testServer(t), testToken, execRequest{Cmd: []string{"/no/such/interpreter"}})
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status %d, want 500", response.StatusCode)
	}
	var event execEvent
	if err := json.NewDecoder(response.Body).Decode(&event); err != nil || event.Error == "" {
		t.Errorf("want an error line, got %+v (%v)", event, err)
	}
}

func TestKillsTheGroupWhenTheDeadlinePasses(t *testing.T) {
	started := time.Now()
	events := run(t, testServer(t), execRequest{Cmd: []string{"sh", "-c", "sleep 30; echo late"}, TimeoutMs: 200})
	stdout, _, exit, timedOut := collect(events)
	if !timedOut || exit == 0 || stdout != "" {
		t.Errorf("got stdout %q exit %d timedOut %v", stdout, exit, timedOut)
	}
	if time.Since(started) > killGrace+2*time.Second {
		t.Errorf("took %s, the kill did not take", time.Since(started))
	}
	assertGone(t, events[0].Pid)
}

func TestKillsTheGroupWhenTheCallerGoesAway(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	response := post(t, ctx, testServer(t), testToken, execRequest{Cmd: []string{"sh", "-c", "echo started; sleep 30"}})
	scanner := bufio.NewScanner(response.Body)
	var pid int
	for scanner.Scan() {
		var event execEvent
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			t.Fatal(err)
		}
		if event.Pid != 0 {
			pid = event.Pid
		}
		if string(event.Stdout) == "started\n" {
			break
		}
	}
	cancel()
	_ = response.Body.Close()
	assertGone(t, pid)
}

func TestStreamsOutputAsItIsProduced(t *testing.T) {
	response := post(t, context.Background(), testServer(t), testToken, execRequest{Cmd: []string{"sh", "-c", "echo one; sleep 1; echo two"}})
	defer func() { _ = response.Body.Close() }()
	started := time.Now()
	scanner := bufio.NewScanner(response.Body)
	for scanner.Scan() {
		var event execEvent
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			t.Fatal(err)
		}
		if string(event.Stdout) == "one\n" {
			if time.Since(started) > 700*time.Millisecond {
				t.Errorf("first chunk arrived after %s, it was buffered", time.Since(started))
			}
			return
		}
	}
	t.Error("never saw the first chunk")
}

func TestInstallCopiesItselfExecutable(t *testing.T) {
	dest := filepath.Join(t.TempDir(), "shared", "agent")
	if err := install(dest); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(dest)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o111 == 0 {
		t.Errorf("mode %v is not executable", info.Mode())
	}
	self, _ := os.Executable()
	if original, _ := os.Stat(self); original.Size() != info.Size() {
		t.Errorf("copied %d bytes of %d", info.Size(), original.Size())
	}
}

// assertGone waits briefly for the process group to disappear.
func assertGone(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(killGrace + 2*time.Second)
	for time.Now().Before(deadline) {
		// The process may linger as a zombie until Wait collects it, which is
		// not the same as still running. A signal to the group answers that.
		if err := syscall.Kill(-pid, 0); err == syscall.ESRCH {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Errorf("process group %d is still alive", pid)
}
