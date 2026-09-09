package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 起動設定解決の contract test (M2 Unit 4 §13)。

// A: no config / no CLI root → error。
func TestResolveNoRoot(t *testing.T) {
	_, err := Resolve(CLIOptions{}, File{})
	if err == nil {
		t.Fatal("expected error when root is unset")
	}
	if !strings.Contains(err.Error(), "root") {
		t.Fatalf("error = %v", err)
	}
}

// B: config only → root / port を取得。
func TestResolveConfigOnly(t *testing.T) {
	cfg, err := Resolve(CLIOptions{}, File{Root: "/data/spool", Port: 54321})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if cfg.Root != "/data/spool" || cfg.Port != 54321 {
		t.Fatalf("cfg = %+v", cfg)
	}
}

// C: CLI が両方を override。
func TestResolveCLIOverridesConfig(t *testing.T) {
	cli := CLIOptions{Root: "/from/cli", RootSet: true, Port: 1, PortSet: true}
	cfg, err := Resolve(cli, File{Root: "/from/config", Port: 2})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if cfg.Root != "/from/cli" || cfg.Port != 1 {
		t.Fatalf("cfg = %+v", cfg)
	}
}

// D: partial override。config root + CLI port、CLI root + config port。
func TestResolvePartialMerge(t *testing.T) {
	cfg, err := Resolve(CLIOptions{Port: 7, PortSet: true}, File{Root: "/from/config", Port: 2})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if cfg.Root != "/from/config" || cfg.Port != 7 {
		t.Fatalf("cfg = %+v", cfg)
	}
	cfg, err = Resolve(CLIOptions{Root: "/from/cli", RootSet: true}, File{Root: "/from/config", Port: 2})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if cfg.Root != "/from/cli" || cfg.Port != 2 {
		t.Fatalf("cfg = %+v", cfg)
	}
	// config 未指定 port は既定 0 (OS assigned)。
	cfg, err = Resolve(CLIOptions{}, File{Root: "/from/config"})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if cfg.Port != 0 {
		t.Fatalf("default port = %d, want 0 (OS assigned)", cfg.Port)
	}
	// 明示 --port 0 は OS assigned の override として有効。
	cfg, err = Resolve(CLIOptions{PortSet: true}, File{Root: "/from/config", Port: 2})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if cfg.Port != 0 {
		t.Fatalf("explicit --port 0 = %d, want 0", cfg.Port)
	}
}

// E: malformed config → 明示 error。黙って無視しない。
func TestLoadFromMalformed(t *testing.T) {
	cases := []struct {
		name string
		data string
	}{
		{"broken JSON", `{"root":`},
		{"wrong type", `{"root":true,"port":1}`},
		{"port is string", `{"root":"/r","port":"123"}`},
		{"JSON array", `[]`},
	}
	for _, c := range cases {
		path := filepath.Join(t.TempDir(), "config.json")
		if err := os.WriteFile(path, []byte(c.data), 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}
		if _, err := LoadFrom(path); err == nil {
			t.Fatalf("%s: expected error", c.name)
		}
	}
}

// F: unknown field は無視する方針を固定 (encoding/json 既定。互換 framework は作らない)。
func TestLoadFromUnknownField(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	data := `{"root":"/r","port":1,"token":"x","extra":{"a":1}}`
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	f, err := LoadFrom(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if f.Root != "/r" || f.Port != 1 {
		t.Fatalf("f = %+v", f)
	}
}

// config file 不在は空の File と nil error (config は任意)。
func TestLoadFromMissing(t *testing.T) {
	f, err := LoadFrom(filepath.Join(t.TempDir(), "absent.json"))
	if err != nil {
		t.Fatalf("load missing: %v", err)
	}
	if f != (File{}) {
		t.Fatalf("f = %+v", f)
	}
}

// port 範囲: 負 / 65535 超は起動前に拒否 (§17)。CLI / config いずれ由来でも。
func TestResolvePortRange(t *testing.T) {
	if _, err := Resolve(CLIOptions{Port: -1, PortSet: true}, File{Root: "/r"}); err == nil {
		t.Fatal("expected error for negative port")
	}
	if _, err := Resolve(CLIOptions{Port: 65536, PortSet: true}, File{Root: "/r"}); err == nil {
		t.Fatal("expected error for port > 65535")
	}
	if _, err := Resolve(CLIOptions{}, File{Root: "/r", Port: -1}); err == nil {
		t.Fatal("expected error for negative config port")
	}
	if _, err := Resolve(CLIOptions{}, File{Root: "/r", Port: 65535}); err != nil {
		t.Fatalf("port 65535 must be valid: %v", err)
	}
}
