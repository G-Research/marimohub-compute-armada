package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
)

// The file endpoints carry bytes raw, in the request or response body, which
// is what retired the shell channel's base64 and quoting: a path travels as a
// query parameter and content never enters a command line. A relative path is
// relative to the agent's working directory, the image's WORKDIR, exactly as
// it is for a command run through /exec.

func pathParam(w http.ResponseWriter, r *http.Request) (string, bool) {
	path := r.URL.Query().Get("path")
	if path == "" {
		writeError(w, http.StatusBadRequest, "path is required")
		return "", false
	}
	return path, true
}

// writeFile writes the request body to the path, creating parent directories,
// as the shell's `mkdir -p && cat > path` did.
func (a *agent) writeFile(w http.ResponseWriter, r *http.Request) {
	path, ok := pathParam(w, r)
	if !ok {
		return
	}
	body := http.MaxBytesReader(w, r.Body, maxRequestBytes)
	content, err := io.ReadAll(body)
	if err != nil {
		writeCodedError(w, http.StatusBadRequest, "write_failed", err.Error())
		return
	}
	if dir := filepath.Dir(path); dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			writeCodedError(w, http.StatusInternalServerError, "write_failed", err.Error())
			return
		}
	}
	if err := os.WriteFile(path, content, 0o644); err != nil {
		writeCodedError(w, http.StatusInternalServerError, "write_failed", err.Error())
		return
	}
	writeJSON(w, struct{}{})
}

// readFile returns the file's bytes raw. The probe order preserves the shell
// channel's answers: a path that is not there at all, dangling symlinks
// excepted, is `not_found`, and anything that exists but cannot be read (a
// directory, a dangling symlink, a permission) is `read_failed`.
func (a *agent) readFile(w http.ResponseWriter, r *http.Request) {
	path, ok := pathParam(w, r)
	if !ok {
		return
	}
	if _, err := os.Lstat(path); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			writeCodedError(w, http.StatusNotFound, "not_found", "no such file: "+path)
			return
		}
		writeCodedError(w, http.StatusInternalServerError, "read_failed", err.Error())
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		writeCodedError(w, http.StatusInternalServerError, "read_failed", err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	_, _ = w.Write(data)
}

// maxSafeInteger is JavaScript's Number.MAX_SAFE_INTEGER, the largest byte
// budget the caller can name exactly.
const maxSafeInteger = 1<<53 - 1

// maxPreallocBytes caps how much of a file's reported size a bounded read
// allocates before reading. It covers marimohub's own per-file budget, 25 MB,
// so a file it captures is still read into one buffer.
const maxPreallocBytes = 32 << 20

// maxTimeoutMs is the largest delay a JavaScript timer honours, and the
// largest deadline marimohub's bounded-read contract allows.
const maxTimeoutMs = 1<<31 - 1

// readFileBounded is the read marimohub's `readFileBounded` port method asks
// for, on a route of its own so an agent that predates it answers 404 rather
// than an unbounded read. It answers the bytes only when the path is absolute,
// has no `..`, runs through no symlink (`openNoFollow`), and names a regular
// file of at most `maxBytes` bytes that is read within `timeoutMs`. The size
// is checked twice, by `fstat` and by reading one byte past the budget, so a
// file that grows between the two still fails. `not_found` means a component
// is absent; anything else refused is `read_failed`.
func (a *agent) readFileBounded(w http.ResponseWriter, r *http.Request) {
	path, ok := pathParam(w, r)
	if !ok {
		return
	}
	query := r.URL.Query()
	maxBytes, err := strconv.ParseInt(query.Get("maxBytes"), 10, 64)
	if err != nil || maxBytes < 0 || maxBytes > maxSafeInteger {
		writeCodedError(w, http.StatusBadRequest, "read_failed", "maxBytes must be an integer from 0 to 2^53-1")
		return
	}
	timeoutMs, err := strconv.ParseInt(query.Get("timeoutMs"), 10, 64)
	if err != nil || timeoutMs <= 0 || timeoutMs > maxTimeoutMs {
		writeCodedError(w, http.StatusBadRequest, "read_failed", "timeoutMs must be an integer from 1 to 2^31-1")
		return
	}
	// The last component must name the file: `openNoFollow` skips empty and
	// `.` components, so `/a/file/` or `/a/file/.` would otherwise open
	// `/a/file` where the kernel would refuse the trailing part.
	names := strings.Split(path, "/")
	if last := names[len(names)-1]; !strings.HasPrefix(path, "/") || slices.Contains(names, "..") || last == "" || last == "." {
		writeCodedError(w, http.StatusBadRequest, "read_failed", "path must be absolute, name a file and have no ..: "+path)
		return
	}

	select {
	case a.boundedReads <- struct{}{}:
	default:
		writeCodedError(w, http.StatusServiceUnavailable, "read_failed", fmt.Sprintf("%d bounded reads are already running", maxBoundedReads))
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	type result struct {
		data []byte
		err  error
	}
	// The read runs aside so the deadline holds even while a syscall blocks,
	// on a stalled network filesystem say; the goroutine then finishes and
	// closes the file on its own, its answer is dropped, and only then does
	// it give its slot back.
	done := make(chan result, 1)
	go func() {
		defer func() { <-a.boundedReads }()
		data, err := a.readBounded(ctx, path, maxBytes)
		done <- result{data, err}
	}()
	var read result
	select {
	case read = <-done:
	case <-ctx.Done():
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			read = result{err: fmt.Errorf("reading %s: deadline of %dms passed", path, timeoutMs)}
		} else {
			read = result{err: fmt.Errorf("reading %s: the caller went away", path)}
		}
	}
	if read.err != nil {
		if errors.Is(read.err, fs.ErrNotExist) {
			writeCodedError(w, http.StatusNotFound, "not_found", "no such file: "+path)
			return
		}
		writeCodedError(w, http.StatusInternalServerError, "read_failed", read.err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	_, _ = w.Write(read.data)
}

func (a *agent) readBounded(ctx context.Context, path string, maxBytes int64) ([]byte, error) {
	file, err := a.openBounded(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()
	// The opened file itself, so nothing can be swapped in after the check.
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file", path)
	}
	if info.Size() > maxBytes {
		return nil, fmt.Errorf("%s is %d bytes, over the budget of %d", path, info.Size(), maxBytes)
	}
	// Sized from fstat, with room to see one byte past it and no regrowth, up
	// to a point: a sparse file can claim a size it never fills, so past that
	// the buffer grows with what is actually read.
	var data bytes.Buffer
	data.Grow(int(min(info.Size(), maxPreallocBytes)) + bytes.MinRead)
	if _, err := data.ReadFrom(io.LimitReader(contextReader{ctx, file}, maxBytes+1)); err != nil {
		return nil, err
	}
	if int64(data.Len()) > maxBytes {
		return nil, fmt.Errorf("%s grew past the budget of %d bytes while being read", path, maxBytes)
	}
	return data.Bytes(), nil
}

// contextReader stops a read between chunks once its context is done.
type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (c contextReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.reader.Read(p)
}

type fileEntry struct {
	Path string `json:"path"`
	// `file`, `directory`, `symlink` or `other`, from the entry's own mode:
	// symlinks are reported, never followed, as `find` reported them.
	Type string `json:"type"`
	Size int64  `json:"size"`
}

type listFilesResponse struct {
	Entries []fileEntry `json:"entries"`
}

// listFiles enumerates a directory, without the root itself. Whether the path
// is a directory is decided through symlinks, as the shell probe's `[ -d ]`
// was, so `not_a_directory` means "it exists and is something else".
func (a *agent) listFiles(w http.ResponseWriter, r *http.Request) {
	path, ok := pathParam(w, r)
	if !ok {
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			if _, lerr := os.Lstat(path); lerr == nil {
				// A dangling symlink exists but leads nowhere listable.
				writeCodedError(w, http.StatusConflict, "not_a_directory", path+" is not a directory")
				return
			}
			writeCodedError(w, http.StatusNotFound, "not_found", "no such directory: "+path)
			return
		}
		writeCodedError(w, http.StatusInternalServerError, "list_failed", err.Error())
		return
	}
	if !info.IsDir() {
		writeCodedError(w, http.StatusConflict, "not_a_directory", path+" is not a directory")
		return
	}
	entries, err := listEntries(path, r.URL.Query().Get("recursive") == "true")
	if err != nil {
		writeCodedError(w, http.StatusInternalServerError, "list_failed", err.Error())
		return
	}
	writeJSON(w, listFilesResponse{Entries: entries})
}

func listEntries(root string, recursive bool) ([]fileEntry, error) {
	// Non-nil, so an empty directory serialises as `[]` and not `null`.
	entries := []fileEntry{}
	if !recursive {
		found, err := os.ReadDir(root)
		if err != nil {
			return nil, err
		}
		for _, item := range found {
			// Info is an lstat: a symlink's own type and size, not its target's.
			info, err := item.Info()
			if err != nil {
				return nil, err
			}
			entries = append(entries, fileEntry{
				Path: filepath.Join(root, item.Name()),
				Type: typeName(info.Mode()),
				Size: info.Size(),
			})
		}
		return entries, nil
	}
	err := filepath.WalkDir(root, func(path string, item fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == root {
			return nil
		}
		info, err := item.Info()
		if err != nil {
			return err
		}
		entries = append(entries, fileEntry{Path: path, Type: typeName(info.Mode()), Size: info.Size()})
		return nil
	})
	if err != nil {
		return nil, err
	}
	return entries, nil
}

func typeName(mode fs.FileMode) string {
	switch {
	case mode.IsRegular():
		return "file"
	case mode.IsDir():
		return "directory"
	case mode&fs.ModeSymlink != 0:
		return "symlink"
	default:
		return "other"
	}
}
