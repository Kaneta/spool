// Command spool-clipboard は Windows clipboard の plain text を既存 `spool add`
// へ渡すだけの thin adapter (docs/spool-windows-launcher.md)。
//
// 責務境界は Linux/KDE の spool-clipboard と同じ:
//
//	clipboard (CF_UNICODETEXT のみ) → UTF-8 bytes
//	→ sibling spool.exe add (stdin pipe, shell 経由なし)
//	→ child の exit code (0/1/2) をそのまま透過
//
// filename 生成・title 導出・衝突処理・text 検証・filesystem store は spool 本体の
// 責務であり、adapter は一切再実装しない。
package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

func main() {
	os.Exit(run())
}

func run() int {
	text, err := readClipboardText()
	if err != nil {
		fmt.Fprintf(os.Stderr, "spool-clipboard: %v\n", err)
		return 1
	}

	exe, err := resolveSpoolExe()
	if err != nil {
		fmt.Fprintf(os.Stderr, "spool-clipboard: %v\n", err)
		return 1
	}

	code, err := runChild(exe, []string{"add"}, text)
	if err != nil {
		fmt.Fprintf(os.Stderr, "spool-clipboard: %v\n", err)
		return 1
	}
	return code
}

// resolveSpoolExe は起動に使う spool 実行文件を返す (sibling 優先、PATH fallback)。
func resolveSpoolExe() (string, error) {
	if self, err := os.Executable(); err == nil {
		return siblingOrPath(filepath.Dir(self))
	}
	return siblingOrPath(".")
}

func siblingOrPath(dir string) (string, error) {
	sibling := filepath.Join(dir, "spool.exe")
	if fi, err := os.Stat(sibling); err == nil && !fi.IsDir() {
		return sibling, nil
	}
	if p, err := exec.LookPath("spool.exe"); err == nil {
		return p, nil
	}
	return "", fmt.Errorf("spool.exe not found next to spool-clipboard or on PATH")
}

// runChild は spool add を child process として起動し、data を stdin に渡す。
// shell / pipeline は介さない。child が起動できた後はその exit code を返す
// (0 saved / 1 failed / 2 uncertain)。起動自体の失敗は error。
func runChild(exe string, args []string, data []byte) (int, error) {
	cmd := exec.Command(exe, args...)
	cmd.Stdin = bytes.NewReader(data)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return exitErr.ExitCode(), nil
		}
		return 0, fmt.Errorf("start %s: %w", exe, err)
	}
	return 0, nil
}
