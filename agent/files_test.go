package main

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

func fileURL(endpoint string, path string, recursive bool) string {
	query := url.Values{"path": []string{path}}
	if recursive {
		query.Set("recursive", "true")
	}
	return endpoint + "?" + query.Encode()
}

func TestWritesAndReadsBytesRawThroughParentsItCreated(t *testing.T) {
	server := testServer(t)
	// A quote, a space, a NUL and invalid UTF-8: nothing is quoted for a shell
	// or decoded as text anywhere on the way.
	path := filepath.Join(t.TempDir(), "sub dir", "it's.bin")
	content := []byte{0x00, 0x9f, 0x92, 0x96, '\n'}

	wrote := request(t, server, http.MethodPut, fileURL("/files", path, false), content)
	_ = wrote.Body.Close()
	if wrote.StatusCode != http.StatusOK {
		t.Fatalf("write: status %d", wrote.StatusCode)
	}

	read := request(t, server, http.MethodGet, fileURL("/files", path, false), nil)
	defer func() { _ = read.Body.Close() }()
	if read.StatusCode != http.StatusOK {
		t.Fatalf("read: status %d", read.StatusCode)
	}
	data, err := io.ReadAll(read.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(data, content) {
		t.Errorf("read %v, wrote %v", data, content)
	}
}

func TestOverwritesAnExistingFile(t *testing.T) {
	server := testServer(t)
	path := filepath.Join(t.TempDir(), "notebook.py")
	for _, content := range []string{"first, and the longer of the two\n", "second\n"} {
		response := request(t, server, http.MethodPut, fileURL("/files", path, false), []byte(content))
		_ = response.Body.Close()
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "second\n" {
		t.Errorf("read %q, want the second write alone", data)
	}
}

func TestReadTellsAbsentFromUnreadable(t *testing.T) {
	server := testServer(t)
	dir := t.TempDir()

	absent := request(t, server, http.MethodGet, fileURL("/files", filepath.Join(dir, "missing.py"), false), nil)
	if absent.StatusCode != http.StatusNotFound {
		t.Errorf("absent: status %d, want 404", absent.StatusCode)
	}
	if refusal := decode[apiError](t, absent); refusal.Code != "not_found" {
		t.Errorf("absent: code %q, want not_found", refusal.Code)
	}

	// A directory exists, so reading it is a read failure, not a missing file.
	unreadable := request(t, server, http.MethodGet, fileURL("/files", dir, false), nil)
	if unreadable.StatusCode != http.StatusInternalServerError {
		t.Errorf("directory: status %d, want 500", unreadable.StatusCode)
	}
	if refusal := decode[apiError](t, unreadable); refusal.Code != "read_failed" {
		t.Errorf("directory: code %q, want read_failed", refusal.Code)
	}

	// A dangling symlink exists too, per the old probe's `[ -L ]`.
	dangling := filepath.Join(dir, "dangling")
	if err := os.Symlink(filepath.Join(dir, "nowhere"), dangling); err != nil {
		t.Fatal(err)
	}
	broken := request(t, server, http.MethodGet, fileURL("/files", dangling, false), nil)
	if refusal := decode[apiError](t, broken); broken.StatusCode != http.StatusInternalServerError || refusal.Code != "read_failed" {
		t.Errorf("dangling symlink: status %d code %q, want 500 read_failed", broken.StatusCode, refusal.Code)
	}
}

// tree builds a directory with one of everything the listing reports.
func tree(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "notebook.py"), []byte("print(1)\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".env"), []byte("A=1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "data"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "data", "nested.csv"), []byte("a,b\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("notebook.py", filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	return root
}

func entriesByPath(entries []fileEntry) map[string]fileEntry {
	byPath := map[string]fileEntry{}
	for _, entry := range entries {
		byPath[entry.Path] = entry
	}
	return byPath
}

func TestListsADirectoryWithTypesAndSizes(t *testing.T) {
	server := testServer(t)
	root := tree(t)

	flat := decode[listFilesResponse](t, request(t, server, http.MethodGet, fileURL("/files/list", root, false), nil))
	if len(flat.Entries) != 4 {
		t.Fatalf("flat: %d entries, want 4: %+v", len(flat.Entries), flat.Entries)
	}
	byPath := entriesByPath(flat.Entries)
	notebook := byPath[filepath.Join(root, "notebook.py")]
	if notebook.Type != "file" || notebook.Size != 9 {
		t.Errorf("notebook: %+v, want a 9-byte file", notebook)
	}
	if byPath[filepath.Join(root, "data")].Type != "directory" {
		t.Errorf("data: %+v, want a directory", byPath[filepath.Join(root, "data")])
	}
	// The symlink itself, never its target.
	if byPath[filepath.Join(root, "link")].Type != "symlink" {
		t.Errorf("link: %+v, want a symlink", byPath[filepath.Join(root, "link")])
	}
	// Hiding is the caller's choice, so the listing reports dotfiles.
	if _, found := byPath[filepath.Join(root, ".env")]; !found {
		t.Error("the flat listing hid .env")
	}
	if _, found := byPath[filepath.Join(root, "data", "nested.csv")]; found {
		t.Error("the flat listing descended")
	}

	deep := decode[listFilesResponse](t, request(t, server, http.MethodGet, fileURL("/files/list", root, true), nil))
	if _, found := entriesByPath(deep.Entries)[filepath.Join(root, "data", "nested.csv")]; !found {
		t.Errorf("the recursive listing missed the nested file: %+v", deep.Entries)
	}
}

func TestListsAnEmptyDirectoryAsNoEntries(t *testing.T) {
	server := testServer(t)
	listed := decode[listFilesResponse](t, request(t, server, http.MethodGet, fileURL("/files/list", t.TempDir(), false), nil))
	if listed.Entries == nil || len(listed.Entries) != 0 {
		t.Errorf("got %+v, want an empty list, not null", listed.Entries)
	}
}

func TestListTellsAFileFromAMissingDirectory(t *testing.T) {
	server := testServer(t)
	root := tree(t)

	file := request(t, server, http.MethodGet, fileURL("/files/list", filepath.Join(root, "notebook.py"), false), nil)
	if refusal := decode[apiError](t, file); file.StatusCode != http.StatusConflict || refusal.Code != "not_a_directory" {
		t.Errorf("file: status %d code %q, want 409 not_a_directory", file.StatusCode, refusal.Code)
	}

	absent := request(t, server, http.MethodGet, fileURL("/files/list", filepath.Join(root, "missing"), false), nil)
	if refusal := decode[apiError](t, absent); absent.StatusCode != http.StatusNotFound || refusal.Code != "not_found" {
		t.Errorf("absent: status %d code %q, want 404 not_found", absent.StatusCode, refusal.Code)
	}
}

func boundedURL(path string, maxBytes string, timeoutMs string) string {
	query := url.Values{"path": []string{path}, "maxBytes": []string{maxBytes}, "timeoutMs": []string{timeoutMs}}
	return "/files/bounded?" + query.Encode()
}

// boundedDir is a directory for bounded reads, with no symlink on the way to
// it, so a TMPDIR that runs through one does not fail every read.
func boundedDir(t *testing.T) string {
	t.Helper()
	if runtime.GOOS != "linux" {
		t.Skip("bounded reads open with openat, which only the Linux build has")
	}
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

// readBoundedFile asks for a bounded read with a generous deadline.
func readBoundedFile(t *testing.T, server *httptest.Server, path string, maxBytes int) *http.Response {
	t.Helper()
	return request(t, server, http.MethodGet, boundedURL(path, strconv.Itoa(maxBytes), "5000"), nil)
}

// wantRefusal checks a bounded read was refused with the code, and returns the message.
func wantRefusal(t *testing.T, response *http.Response, status int, code string) string {
	t.Helper()
	refusal := decode[apiError](t, response)
	if response.StatusCode != status || refusal.Code != code {
		t.Errorf("status %d code %q (%s), want %d %s", response.StatusCode, refusal.Code, refusal.Error, status, code)
	}
	return refusal.Error
}

func TestBoundedReadReturnsAFileAtTheCapByteForByte(t *testing.T) {
	server := testServer(t)
	path := filepath.Join(boundedDir(t), "notebook.py")
	content := []byte{0x00, 0x9f, 'a', '\n'}
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatal(err)
	}

	read := readBoundedFile(t, server, path, len(content))
	defer func() { _ = read.Body.Close() }()
	if read.StatusCode != http.StatusOK {
		t.Fatalf("status %d, want 200", read.StatusCode)
	}
	data, err := io.ReadAll(read.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(data, content) {
		t.Errorf("read %v, want %v", data, content)
	}
}

func TestBoundedReadRefusesAFileOneByteOverTheCap(t *testing.T) {
	server := testServer(t)
	path := filepath.Join(boundedDir(t), "notebook.py")
	if err := os.WriteFile(path, []byte("12345"), 0o644); err != nil {
		t.Fatal(err)
	}
	message := wantRefusal(t, readBoundedFile(t, server, path, 4), http.StatusInternalServerError, "read_failed")
	if !strings.Contains(message, "budget of 4") {
		t.Errorf("message %q does not name the budget", message)
	}
}

func TestBoundedReadReadsAnEmptyFileWithAZeroBudget(t *testing.T) {
	server := testServer(t)
	path := filepath.Join(boundedDir(t), "empty.py")
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	read := readBoundedFile(t, server, path, 0)
	_ = read.Body.Close()
	if read.StatusCode != http.StatusOK {
		t.Errorf("status %d, want 200", read.StatusCode)
	}
}

func TestBoundedReadRefusesASymlinkedFile(t *testing.T) {
	server := testServer(t)
	dir := boundedDir(t)
	target := filepath.Join(dir, "target.py")
	if err := os.WriteFile(target, []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "notebook.py")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	wantRefusal(t, readBoundedFile(t, server, link, 100), http.StatusInternalServerError, "read_failed")

	// Dangling, it still exists: a read failure, as plain reads count it.
	if err := os.Remove(target); err != nil {
		t.Fatal(err)
	}
	wantRefusal(t, readBoundedFile(t, server, link, 100), http.StatusInternalServerError, "read_failed")
}

func TestBoundedReadRefusesAPathThroughASymlinkedDirectory(t *testing.T) {
	server := testServer(t)
	dir := boundedDir(t)
	real := filepath.Join(dir, "real")
	if err := os.Mkdir(real, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(real, "notebook.py"), []byte("print(1)\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, filepath.Join(dir, "workspace")); err != nil {
		t.Fatal(err)
	}
	wantRefusal(t, readBoundedFile(t, server, filepath.Join(dir, "workspace", "notebook.py"), 100), http.StatusInternalServerError, "read_failed")
}

func TestBoundedReadRefusesADirectoryAndAFIFO(t *testing.T) {
	server := testServer(t)
	dir := boundedDir(t)
	wantRefusal(t, readBoundedFile(t, server, dir, 100), http.StatusInternalServerError, "read_failed")

	// Nothing writes to the FIFO, so a blocking open or read would hang the
	// request until the deadline instead of answering at once.
	fifo := filepath.Join(dir, "notebook.py")
	if err := syscall.Mkfifo(fifo, 0o644); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	message := wantRefusal(t, readBoundedFile(t, server, fifo, 100), http.StatusInternalServerError, "read_failed")
	if !strings.Contains(message, "not a regular file") {
		t.Errorf("message %q, want the file type refused", message)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Errorf("took %s: the FIFO blocked", elapsed)
	}
}

func TestBoundedReadTellsAbsentFromRefused(t *testing.T) {
	server := testServer(t)
	dir := boundedDir(t)
	wantRefusal(t, readBoundedFile(t, server, filepath.Join(dir, "missing.py"), 100), http.StatusNotFound, "not_found")
	wantRefusal(t, readBoundedFile(t, server, filepath.Join(dir, "gone", "missing.py"), 100), http.StatusNotFound, "not_found")
}

func TestBoundedReadRefusesABadPathOrBudgetBeforeOpening(t *testing.T) {
	a := testAgent()
	var opened atomic.Bool
	a.openBounded = func(path string) (*os.File, error) {
		opened.Store(true)
		return openNoFollow(path)
	}
	server := testAgentServer(t, a)

	for _, target := range []string{
		boundedURL("notebook.py", "100", "5000"),
		boundedURL("/workspace/../etc/passwd", "100", "5000"),
		boundedURL("/workspace/notebook.py", "-1", "5000"),
		boundedURL("/workspace/notebook.py", "9007199254740992", "5000"),
		boundedURL("/workspace/notebook.py", "1.5", "5000"),
		boundedURL("/workspace/notebook.py", "", "5000"),
		boundedURL("/workspace/notebook.py", "100", "0"),
		boundedURL("/workspace/notebook.py", "100", "2147483648"),
		boundedURL("/workspace/notebook.py", "100", ""),
	} {
		response := request(t, server, http.MethodGet, target, nil)
		if refusal := decode[apiError](t, response); response.StatusCode != http.StatusBadRequest || refusal.Code != "read_failed" {
			t.Errorf("%s: status %d code %q, want 400 read_failed", target, response.StatusCode, refusal.Code)
		}
	}
	if opened.Load() {
		t.Error("a refused request still opened its path")
	}
}

func TestBoundedReadAnswersAtTheDeadlineWhileTheOpenStalls(t *testing.T) {
	a, release := stalledAgent(t, maxBoundedReads)
	server := testAgentServer(t, a)

	started := time.Now()
	response := request(t, server, http.MethodGet, boundedURL("/workspace/notebook.py", "100", "200"), nil)
	message := wantRefusal(t, response, http.StatusInternalServerError, "read_failed")
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Errorf("answered after %s, want about 200ms", elapsed)
	}
	if !strings.Contains(message, "deadline of 200ms") {
		t.Errorf("message %q does not name the deadline", message)
	}
	release()
}

func TestBoundedReadsStuckOnAStalledFilesystemAreCapped(t *testing.T) {
	a, release := stalledAgent(t, 1)
	server := testAgentServer(t, a)

	// The first read times out but stays stuck in its open, holding the slot.
	wantRefusal(t, request(t, server, http.MethodGet, boundedURL("/workspace/notebook.py", "100", "50"), nil), http.StatusInternalServerError, "read_failed")
	message := wantRefusal(t, request(t, server, http.MethodGet, boundedURL("/workspace/notebook.py", "100", "5000"), nil), http.StatusServiceUnavailable, "read_failed")
	if !strings.Contains(message, "already running") {
		t.Errorf("message %q, want the cap named", message)
	}

	// Once the stuck read ends, its slot is free again.
	release()
	deadline := time.Now().Add(2 * time.Second)
	for len(a.boundedReads) > 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if len(a.boundedReads) != 0 {
		t.Error("the stalled read never gave its slot back")
	}
}

// stalledAgent has room for `slots` bounded reads, each of which blocks in its
// open until release is called, as on a hung network filesystem.
func stalledAgent(t *testing.T, slots int) (*agent, func()) {
	t.Helper()
	a := testAgent()
	a.boundedReads = make(chan struct{}, slots)
	stalled := make(chan struct{})
	a.openBounded = func(string) (*os.File, error) {
		<-stalled
		return nil, errors.New("released")
	}
	var once sync.Once
	release := func() { once.Do(func() { close(stalled) }) }
	t.Cleanup(release)
	return a, release
}
