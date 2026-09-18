//go:build windows

// terminal_windows.go — terminal 判定 (Windows)。
// GetConsoleMode が成功するのは console handle のみ。redirected / piped stdin や
// NUL device は失敗するため terminal と誤判定しない。
package main

import (
	"os"

	"golang.org/x/sys/windows"
)

func isTerminal(f *os.File) bool {
	var mode uint32
	return windows.GetConsoleMode(windows.Handle(f.Fd()), &mode) == nil
}
