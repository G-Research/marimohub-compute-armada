package main

import (
	"bytes"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
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
