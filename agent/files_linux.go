package main

import (
	"io/fs"
	"os"
	"strings"
	"syscall"
)

// openNoFollow opens an absolute path one component at a time, each relative
// to the directory before it, with O_NOFOLLOW, so a symlink anywhere in the
// path fails the open rather than being followed, and a parent swapped for a
// symlink between two checks cannot redirect it. Every component but the last
// must be a directory. O_NONBLOCK keeps a FIFO swapped in for the file from
// blocking the open; the caller rejects it by fstat. This is the walk
// marimohub's reference reader does in Python (compute-commons boundedRead.ts).
func openNoFollow(path string) (*os.File, error) {
	fd, err := syscall.Open("/", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, &fs.PathError{Op: "open", Path: "/", Err: err}
	}
	var names []string
	for _, name := range strings.Split(path, "/") {
		if name != "" && name != "." {
			names = append(names, name)
		}
	}
	for i, name := range names {
		flags := syscall.O_RDONLY | syscall.O_NOFOLLOW | syscall.O_NONBLOCK | syscall.O_CLOEXEC
		if i < len(names)-1 {
			flags |= syscall.O_DIRECTORY
		}
		next, err := syscall.Openat(fd, name, flags, 0)
		_ = syscall.Close(fd)
		if err != nil {
			return nil, &fs.PathError{Op: "open", Path: path, Err: err}
		}
		fd = next
	}
	return os.NewFile(uintptr(fd), path), nil
}
