//go:build !windows

// terminal_unix.go — terminal 判定 (Unix)。
// char device 判定 (ModeCharDevice) は /dev/null も terminal 扱いしてしまうため、
// terminal だけを正確に識別する ioctl (TCGETS) を使う。非 terminal は error (ENOTTY 等)。
package main

import (
	"os"

	"golang.org/x/sys/unix"
)

func isTerminal(f *os.File) bool {
	_, err := unix.IoctlGetTermios(int(f.Fd()), unix.TCGETS)
	return err == nil
}
