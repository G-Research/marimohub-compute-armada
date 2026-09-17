//go:build !linux

package main

// reapOrphans is a Linux duty. Elsewhere the agent is only ever a test
// process, never PID 1 of a container.
func reapOrphans(_ func(pid int) bool) {}
