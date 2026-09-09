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
	"spool/internal/server"
	"spool/internal/store"
)

// webDist は build:pc 出力 (npm run build:pc → ui → pc/web/dist) を binary へ埋め込む
// (DESIGN-v2 §6.9)。dist は commit 済みであり、clean checkout から go build できる。
//
//go:embed all:web/dist
var webDist embed.FS

func main() {
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
