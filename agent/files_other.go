//go:build !linux

package main

import (
	"errors"
	"os"
)

// openNoFollow needs openat, which the syscall package offers on Linux alone.
// Elsewhere the agent is only ever a test process, so a bounded read refuses.
func openNoFollow(_ string) (*os.File, error) {
	return nil, errors.New("bounded reads need openat, which only the Linux build has")
}
