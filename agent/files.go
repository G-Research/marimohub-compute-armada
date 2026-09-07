package main

import (
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
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
