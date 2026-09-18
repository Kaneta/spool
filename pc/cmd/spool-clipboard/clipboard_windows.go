//go:build windows

// clipboard_windows.go — CF_UNICODETEXT の読み取りのみ。画像 / HTML / RTF は対象外。
// x/sys/windows は clipboard API を export しないため user32 / kernel32 を
// NewLazySystemDLL で直接呼ぶ (新 dependency なし)。
package main

import (
	"fmt"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const cfUnicodeText = 13

var (
	modUser32   = windows.NewLazySystemDLL("user32.dll")
	procIsFmt   = modUser32.NewProc("IsClipboardFormatAvailable")
	procOpen    = modUser32.NewProc("OpenClipboard")
	procGet     = modUser32.NewProc("GetClipboardData")
	procClose   = modUser32.NewProc("CloseClipboard")
	modKernel32 = windows.NewLazySystemDLL("kernel32.dll")
	procLock    = modKernel32.NewProc("GlobalLock")
	procUnlock  = modKernel32.NewProc("GlobalUnlock")
	procGSize   = modKernel32.NewProc("GlobalSize")
	procReadMem = modKernel32.NewProc("ReadProcessMemory")
)

// syscall2 は直接 syscall.SyscallN を呼ぶ。GlobalLock の戻り値を unsafe.Pointer へ
// 変換する際、vet が許容するのは syscall.SyscallN の結果のみであるため
// (LazyProc.Call は uintptr を経由するため不可)。
func syscall2(proc *windows.LazyProc, arg uintptr) uintptr {
	r, _, _ := syscall.SyscallN(proc.Addr(), arg)
	return r
}

// openClipboard は他 process が clipboard を open 中だと失敗しうるため、短い bounded
// retry を行う (10 回 × 50ms ≒ 0.5s、合計 1 秒未満)。枯渇したら error。
func openClipboard() error {
	const attempts, delay = 10, 50 * time.Millisecond
	for i := 0; ; i++ {
		if syscall2(procOpen, 0) != 0 { // NULL hwnd で開ける
			return nil
		}
		if i == attempts-1 {
			return fmt.Errorf("OpenClipboard failed (clipboard busy?)")
		}
		time.Sleep(delay)
	}
}

// readClipboardText は clipboard の plain text を UTF-8 bytes として返す。
// 読み出しは GlobalSize を上限とする (NUL 終端まで無制限に読まない)。
// 先頭が NUL の場合は empty clipboard text として 0 byte を返す (既存 spool
// semantics: empty record を保存する)。CF_UNICODETEXT 自体が無い場合は
// spool add を起動せず error。
func readClipboardText() ([]byte, error) {
	r, _, _ := procIsFmt.Call(cfUnicodeText)
	if r == 0 {
		return nil, fmt.Errorf("clipboard does not contain plain text (CF_UNICODETEXT)")
	}
	if err := openClipboard(); err != nil {
		return nil, err
	}
	// 以降、CloseClipboard までのどの path でも必ず close する。
	text, err := getClipboardText()
	procClose.Call()
	if err != nil {
		return nil, err
	}
	return text, nil
}

func getClipboardText() ([]byte, error) {
	h := syscall2(procGet, cfUnicodeText)
	if h == 0 {
		return nil, fmt.Errorf("GetClipboardData failed")
	}
	size := syscall2(procGSize, h)
	if size == 0 {
		return nil, fmt.Errorf("GlobalSize failed or empty allocation")
	}
	p := syscall2(procLock, h)
	if p == 0 {
		return nil, fmt.Errorf("GlobalLock failed")
	}
	defer syscall2(procUnlock, h)
	// GlobalLock の戻り値は uintptr のみで保持し、unsafe.Pointer へ変換しない
	// (vet: possible misuse of unsafe.Pointer)。自 process への copy は
	// ReadProcessMemory (current process pseudo-handle は自 process に対して有効)
	// で行い、Go buffer 側の pointer 変換は Pointer→uintptr 方向のみで安全。
	data := make([]byte, size)
	var read uintptr
	r, _, _ := syscall.SyscallN(procReadMem.Addr(),
		uintptr(windows.CurrentProcess()), p,
		uintptr(unsafe.Pointer(&data[0])), size,
		uintptr(unsafe.Pointer(&read)))
	if r == 0 || read != size {
		return nil, fmt.Errorf("ReadProcessMemory failed")
	}
	// GlobalSize で得た byte 数を上限に読み終えたので、NUL 判定は utf16ToUTF8 側。
	return utf16ToUTF8(data)
}
