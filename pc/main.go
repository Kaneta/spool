// spool localhost process の起動 (DESIGN-v2 §6.1–§6.3)。
// flag 解析 → config file (root / port のみ、CLI 優先) → --init (root そのものだけ作成、
// 親は作らない) → store.Open (dirfd pinning は store の責務) → 128-bit token →
// 127.0.0.1 bind (actual port から Host / Origin / startup URL を確定) → server。
package main

import (
	"context"
	"crypto/rand"
	"embed"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"spool/internal/config"
	"spool/internal/namegen"
	"spool/internal/server"
	"spool/internal/store"
	"spool/internal/textcheck"

	"golang.org/x/sys/unix"
)

// webDist は build:pc 出力 (npm run build:pc → ui → pc/web/dist) を binary へ埋め込む
// (DESIGN-v2 §6.9)。dist は commit 済みであり、clean checkout から go build できる。
//
//go:embed all:web/dist
var webDist embed.FS

func main() {
	// `spool add` subcommand: stdin 全文を 1 件として保存する UI なし capture 経路。
	// それ以外の起動 (引数なし / flag のみ) は既存の localhost server 起動のまま。
	if len(os.Args) > 1 && os.Args[1] == "add" {
		os.Exit(runAdd(os.Args[2:], os.Stdin, os.Stdout, os.Stderr))
	}
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	var cli config.CLIOptions
	initRoot := flag.Bool("init", false, "create the root directory itself (parent must already exist)")
	flag.StringVar(&cli.Root, "root", "", "spool root directory")
	flag.IntVar(&cli.Port, "port", 0, "TCP port (0 = OS assigned)")
	flag.Parse()
	// 明示指定のみ precedence に載せる (--port 0 の OS assigned 指定を保持するため)。
	flag.Visit(func(f *flag.Flag) {
		switch f.Name {
		case "root":
			cli.RootSet = true
		case "port":
			cli.PortSet = true
		}
	})

	file := config.File{}
	if path, err := config.DefaultPath(); err == nil {
		file, err = config.LoadFrom(path)
		if err != nil {
			return err
		}
	} else {
		// HOME が解決できない環境では config file なしで続行 (root が決まらなければ後段で error)。
		log.Printf("config file unavailable: %v", err)
	}

	cfg, err := config.Resolve(cli, file)
	if err != nil {
		return err
	}
	if err := ensureRoot(cfg.Root, *initRoot); err != nil {
		return err
	}
	st, err := store.Open(cfg.Root)
	if err != nil {
		return err
	}
	token, err := newToken()
	if err != nil {
		_ = st.Close()
		return err
	}

	// bind は IPv4 loopback のみ (§6.2)。port 0 は kernel に割り当てさせる。
	ln, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(cfg.Port)))
	if err != nil {
		_ = st.Close()
		return fmt.Errorf("listen 127.0.0.1: %w", err)
	}
	hostPort := ln.Addr().String() // actual "127.0.0.1:<port>"。Host / Origin / URL はここから決める

	srv := server.New(st, token, hostPort, staticHandler())
	// request log は method + path のみ (§6.3)。token / query / body / 内容は出力しない。
	logged := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Printf("%s %s", r.Method, r.URL.Path)
		srv.ServeHTTP(w, r)
	})
	httpSrv := &http.Server{Handler: logged}

	fmt.Printf("http://%s/#token=%s\n", hostPort, token)

	errCh := make(chan error, 1)
	go func() { errCh <- httpSrv.Serve(ln) }()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sigCh)

	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			_ = st.Close()
			return err
		}
	case sig := <-sigCh:
		log.Printf("received %v, shutting down", sig)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := httpSrv.Shutdown(ctx); err != nil {
			_ = st.Close()
			return fmt.Errorf("shutdown: %w", err)
		}
	}
	return st.Close()
}

// ensureRoot は --init 契約 (M2 Unit 4 §4): 指定 root directory そのものだけを作る。
// 親 directory は暗黙に作らない (os.Mkdir。MkdirAll は使わない)。既存 directory は
// そのまま利用し、--init が付いていても破壊・再作成しない。root が file なら error。
func ensureRoot(root string, initRoot bool) error {
	st, err := os.Stat(root)
	if err == nil {
		if !st.IsDir() {
			return fmt.Errorf("root %q is not a directory", root)
		}
		return nil
	}
	if !os.IsNotExist(err) {
		return fmt.Errorf("stat root %q: %w", root, err)
	}
	if !initRoot {
		return fmt.Errorf("root %q does not exist (first run: pass --init)", root)
	}
	if err := os.Mkdir(root, 0o755); err != nil {
		return fmt.Errorf("create root %q: %w", root, err)
	}
	return nil
}

// newToken は 128-bit random token を base64url (padding なし) で返す (DESIGN §6.3)。
// process lifetime のみであり、config / file / persistent state には保存しない。
func newToken() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// staticHandler は embed した PC UI (web/dist) を same-origin で配信する (DESIGN-v2 §6.9)。
// token 不要 (§6.3: 静的資産は機密でない)。security header は静的応答に付与する:
// CSP / nosniff / Referrer-Policy。index.html は no-cache、hashed asset は immutable。
func staticHandler() http.Handler {
	dist, err := fs.Sub(webDist, "web/dist")
	if err != nil {
		// embed 構造は compile 時に固定されており到達しない。到達したら隠さない。
		panic("spool: embed web/dist: " + err.Error())
	}
	fileServer := http.FileServerFS(dist)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", "default-src 'self'; connect-src 'self'")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			h.Set("Cache-Control", "no-cache") // entry html は再読込で最新を得る
		} else {
			h.Set("Cache-Control", "public, max-age=31536000, immutable") // Vite content-hash 済み asset
		}
		fileServer.ServeHTTP(w, r)
	})
}

// `spool add` — UI なし capture (§3.6, §6.6)。stdin 全文を 1 件として、HTTP server を
// 経由せず store を直接使って root 直下の ordinary file へ保存する。成果は exit code
// で区別する: 0 = saved, 1 = failed, 2 = uncertain。

// taxonomy code (§6.5) は server (Unit 3) と同じ語彙を使う。CLI 固有の stdin_required
// のみ追加。共通 helper への抽出は server の suffix loop と同じく今回行わない。
const (
	codeInvalidInput  = "invalid_input"
	codeInvalidName   = "invalid_name"
	codeNameConflict  = "name_conflict"
	codeTooLarge      = "too_large"
	codeRootMissing   = "root_missing"
	codeRootChanged   = "root_changed"
	codeIOError       = "io_error"
	codeStdinRequired = "stdin_required"
)

// classifyAdd は store / textcheck の error を taxonomy code へ写像する。
// server の classify と同じ対応。
func classifyAdd(err error) string {
	switch {
	case errors.Is(err, store.ErrRootMissing):
		return codeRootMissing
	case errors.Is(err, store.ErrRootChanged):
		return codeRootChanged
	case errors.Is(err, store.ErrInvalidName):
		return codeInvalidName
	case errors.Is(err, store.ErrNameConflict):
		return codeNameConflict
	case errors.Is(err, textcheck.ErrNotUTF8):
		return codeInvalidInput
	case errors.Is(err, textcheck.ErrTooLarge):
		return codeTooLarge
	case errors.Is(err, store.ErrIO):
		return codeIOError
	default:
		return codeIOError
	}
}

// isTerminal は fd が terminal かを tcgetattr (TCGETS) で判定する。
// char device 判定 (ModeCharDevice) は /dev/null も terminal 扱いしてしまうため、
// terminal だけを正確に識別する ioctl を使う。非 terminal は error (ENOTTY 等) になる。
func isTerminal(f *os.File) bool {
	_, err := unix.IoctlGetTermios(int(f.Fd()), unix.TCGETS)
	return err == nil
}

// runAdd は `spool add` の本体。root は CLI --root > config file > (無ければ error) の
// 既存 config.Resolve で決める。port は add の概念に存在しない。
func runAdd(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("add", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var cli config.CLIOptions
	fs.StringVar(&cli.Root, "root", "", "spool root directory")
	if err := fs.Parse(args); err != nil {
		return 1 // usage 出力済み
	}
	if fs.NArg() > 0 {
		fmt.Fprintf(stderr, "failed: %s: unexpected argument %q\n", codeInvalidInput, fs.Arg(0))
		return 1
	}
	fs.Visit(func(f *flag.Flag) {
		if f.Name == "root" {
			cli.RootSet = true
		}
	})

	file := config.File{}
	if path, err := config.DefaultPath(); err == nil {
		file, err = config.LoadFrom(path)
		if err != nil {
			fmt.Fprintf(stderr, "failed: %s: %v\n", codeIOError, err)
			return 1
		}
	} else if !cli.RootSet {
		// HOME が解決できない環境では config file なしで続行 (root が決まらなければ後段で error)。
		log.Printf("config file unavailable: %v", err)
	}
	cfg, err := config.Resolve(cli, file)
	if err != nil {
		fmt.Fprintf(stderr, "failed: %s: %v\n", codeInvalidInput, err)
		return 1
	}

	// stdin が terminal なら入力待ちにしない。
	if f, ok := stdin.(*os.File); ok && isTerminal(f) {
		fmt.Fprintf(stderr, "failed: %s: stdin is a terminal\n", codeStdinRequired)
		return 1
	}
	text, err := io.ReadAll(stdin)
	if err != nil {
		fmt.Fprintf(stderr, "failed: %s: read stdin: %v\n", codeIOError, err)
		return 1
	}

	st, err := store.Open(cfg.Root)
	if err != nil {
		fmt.Fprintf(stderr, "failed: %s: %v\n", classifyAdd(err), err)
		return 1
	}
	defer st.Close()

	// captured_at は開始時に 1 度だけ取得し、suffix retry で時刻を進めない (§3.6)。
	// 秒は常に "00" (minute 精度)。UTC 変換・timezone 表記はしない。
	prefix, ok := namegen.ParseCapturedAt(time.Now().Format("2006-01-02T15:04:00"))
	if !ok {
		fmt.Fprintf(stderr, "failed: %s: internal: invalid captured_at\n", codeInvalidInput)
		return 1
	}
	title := namegen.DeriveTitle(string(text))

	// suffix loop は CLI command が所有 (§3.5)。store は EEXIST を ErrNameConflict で返す。
	// 確定衝突のみ次の suffix へ。他の失敗は retry しない。overwrite は構造的に存在しない。
	for suffix := 0; ; suffix++ {
		name := namegen.CandidateName(prefix, title, suffix)
		if !namegen.IsNameWithinLimit(name) {
			// suffix を付けると 255 byte を超えるなら確定衝突で終了。byte limit 優先。
			fmt.Fprintf(stderr, "failed: %s: no suffix fits 255 byte name limit\n", codeNameConflict)
			return 1
		}
		res := st.Save(name, text)
		if res.State == store.SaveFailed && errors.Is(res.Err, store.ErrNameConflict) {
			continue
		}
		switch res.State {
		case store.SaveSaved:
			fmt.Fprintln(stdout, name)
			return 0
		case store.SaveUncertain:
			fmt.Fprintf(stderr, "uncertain: save may have completed (%s)\n", classifyAdd(res.Err))
			return 2
		default: // SaveFailed
			fmt.Fprintf(stderr, "failed: %s: %v\n", classifyAdd(res.Err), res.Err)
			return 1
		}
	}
}
