//go:build !windows

package main

import "fmt"

// readClipboardText は Windows 以外では起動しない (command 自体は Windows 専用)。
// Linux での go build ./... / go test ./... を成立させるための stub。
func readClipboardText() ([]byte, error) {
	return nil, fmt.Errorf("spool-clipboard is Windows only")
}
