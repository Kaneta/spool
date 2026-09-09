// Package config は起動設定 (root / port) の純粋処理 (DESIGN-v2 §6.2)。
// config file は ~/.config/spool/config.json の読み込みのみ (書き込み・editor は作らない)。
// precedence は CLI > config file > 既定値。環境変数による第三の設定系統は追加しない。
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// File は config file の内容。field は root / port のみで、他は追加しない (§6.2)。
type File struct {
	Root string `json:"root"`
	Port int    `json:"port"`
}

// CLIOptions は CLI flag の値と明示区別。*Set は flag が明示指定されたかどうか
// (flag.Visit 由来)。明示 `--port 0` (OS assigned) を config 値と区別して保持するため。
type CLIOptions struct {
	Root    string
	RootSet bool
	Port    int
	PortSet bool
}

// Config は解決済みの起動設定。Port 0 は OS が選んだ空き port (§6.2)。
type Config struct {
	Root string
	Port int
}

// DefaultPath は config file の path (~/.config/spool/config.json)。
func DefaultPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "spool", "config.json"), nil
}

// LoadFrom は config file を読み込む。file が存在しない場合は空の File と nil error
// (config file は任意)。JSON の形が不正 / 型が違う場合は明示 error で、黙って無視しない。
// JSON decoding は encoding/json の既定に従う (未知 field は無視。小さい実装を選択し、
// test で方針を固定する)。
func LoadFrom(path string) (File, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return File{}, nil
		}
		return File{}, fmt.Errorf("read %s: %w", path, err)
	}
	var f File
	if err := json.Unmarshal(data, &f); err != nil {
		return File{}, fmt.Errorf("parse %s: %w", path, err)
	}
	return f, nil
}

// Resolve は precedence CLI > config file > 既定値を適用し、起動設定を確定させる。
// root は CLI / config のいずれでも決まらなければ error。port は範囲外 (負 / >65535)
// を起動前に拒否する。0 は既定 (OS assigned) として有効。
func Resolve(cli CLIOptions, file File) (Config, error) {
	cfg := Config{Root: file.Root, Port: file.Port}
	if cli.RootSet {
		cfg.Root = cli.Root
	}
	if cli.PortSet {
		cfg.Port = cli.Port
	}
	if cfg.Root == "" {
		return Config{}, errors.New("root is not set: use --root or root field in config file")
	}
	if cfg.Port < 0 || cfg.Port > 65535 {
		return Config{}, fmt.Errorf("port out of range: %d", cfg.Port)
	}
	return cfg, nil
}
