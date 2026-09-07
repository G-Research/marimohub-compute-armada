//go:build linux

package main

import (
	"bytes"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

// reapOrphans does the one duty Linux gives PID 1: collect the exit
// status of children nobody else will.
//
// A detached kernel that crashes reparents to PID 1 and stays a zombie
// until something waits for it. `sleep infinity` never did, so a crashed
// kernel looked alive to `kill -0` and every crash read as a timeout. Only
// orphans are collected here: a request's own child is collected by that
// request's Wait, and a wait on it from here would steal its exit status.
//
// SIGCHLD says something may have exited, and the ticker covers a zombie
// that was behind a still-owned child when the signal arrived.
func reapOrphans(owned func(pid int) bool) {
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGCHLD)
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-sigs:
		case <-tick.C:
		}
		for _, pid := range zombiesOf(os.Getpid()) {
			if owned(pid) {
				continue
			}
			var status syscall.WaitStatus
			_, _ = syscall.Wait4(pid, &status, syscall.WNOHANG, nil)
		}
	}
}

// zombiesOf lists the zombie processes whose parent is parent, from /proc.
func zombiesOf(parent int) []int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	var zombies []int
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		stat, err := os.ReadFile(filepath.Join("/proc", entry.Name(), "stat"))
		if err != nil {
			continue
		}
		// The command name sits in parentheses and may contain spaces, so the
		// fields of interest are counted from the last closing one.
		close := bytes.LastIndexByte(stat, ')')
		if close < 0 {
			continue
		}
		fields := bytes.Fields(stat[close+1:])
		if len(fields) < 2 || fields[0][0] != 'Z' {
			continue
		}
		if ppid, err := strconv.Atoi(string(fields[1])); err == nil && ppid == parent {
			zombies = append(zombies, pid)
		}
	}
	return zombies
}
