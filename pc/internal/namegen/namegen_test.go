package namegen

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// vectors は共有 fixture (spool2/test/vectors/filename.json)。
// TS 側 (ui/src/filename.test.ts) が同じ file を読む。capturedAtGenerationCases は TS のみ消費する。
type vectors struct {
	Title []struct {
		Text string `json:"text"`
		Want string `json:"want"`
	} `json:"titleCases"`
	Building []struct {
		Prefix      string `json:"prefix"`
		Title       string `json:"title"`
		Suffix      int    `json:"suffix"`
		Name        string `json:"name"`
		WithinLimit bool   `json:"withinLimit"`
	} `json:"nameBuildingCases"`
	Generated []struct {
		Name     string `json:"name"`
		Captured bool   `json:"captured"`
	} `json:"generatedFilenameCases"`
	RootDirect []struct {
		Name string `json:"name"`
		Safe bool   `json:"safe"`
	} `json:"rootDirectChildCases"`
	CapturedAtGeneration []struct {
		Year   int    `json:"year"`
		Month  int    `json:"month"`
		Day    int    `json:"day"`
		Hour   int    `json:"hour"`
		Minute int    `json:"minute"`
		Iso    string `json:"iso"`
		Prefix string `json:"prefix"`
	} `json:"capturedAtGenerationCases"`
	CapturedAtParsing []struct {
		Input  string `json:"input"`
		Ok     bool   `json:"ok"`
		Prefix string `json:"prefix"`
	} `json:"capturedAtParsingCases"`
	TitleRoundTrip []struct {
		Prefix string `json:"prefix"`
		Text   string `json:"text"`
	} `json:"titleRoundTripCases"`
}

func loadVectors(t *testing.T) vectors {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "test", "vectors", "filename.json"))
	if err != nil {
		t.Fatalf("load fixture: %v", err)
	}
	var v vectors
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	return v
}

func TestDeriveTitle(t *testing.T) {
	for i, c := range loadVectors(t).Title {
		t.Run(fmt.Sprintf("%d", i), func(t *testing.T) {
			if got := DeriveTitle(c.Text); got != c.Want {
				t.Fatalf("DeriveTitle(%q) = %q, want %q", c.Text, got, c.Want)
			}
		})
	}
}

func TestCandidateName(t *testing.T) {
	for i, c := range loadVectors(t).Building {
		t.Run(fmt.Sprintf("%d", i), func(t *testing.T) {
			got := CandidateName(c.Prefix, c.Title, c.Suffix)
			if got != c.Name {
				t.Fatalf("CandidateName(%q, %q, %d) = %q, want %q", c.Prefix, c.Title, c.Suffix, got, c.Name)
			}
			if limit := IsNameWithinLimit(got); limit != c.WithinLimit {
				t.Fatalf("IsNameWithinLimit(%q) = %v, want %v", got, limit, c.WithinLimit)
			}
		})
	}
}

func TestValidateGeneratedFilename(t *testing.T) {
	for i, c := range loadVectors(t).Generated {
		t.Run(fmt.Sprintf("%d", i), func(t *testing.T) {
			if got := ValidateGeneratedFilename(c.Name); got != c.Captured {
				t.Fatalf("ValidateGeneratedFilename(%q) = %v, want %v", c.Name, got, c.Captured)
			}
		})
	}
}

func TestIsValidRootDirectChildName(t *testing.T) {
	for i, c := range loadVectors(t).RootDirect {
		t.Run(fmt.Sprintf("%d", i), func(t *testing.T) {
			if got := IsValidRootDirectChildName(c.Name); got != c.Safe {
				t.Fatalf("IsValidRootDirectChildName(%q) = %v, want %v", c.Name, got, c.Safe)
			}
		})
	}
}

// TestGeneratedAreSafeRootDirectChildren は fixture の分類整合 invariant (§3.6):
// captured と判定される name は、常に safe root-direct-child でもあること。
func TestGeneratedAreSafeRootDirectChildren(t *testing.T) {
	for _, c := range loadVectors(t).Generated {
		if c.Captured && !IsValidRootDirectChildName(c.Name) {
			t.Fatalf("captured name %q is not a safe root-direct-child name", c.Name)
		}
	}
}

func TestParseCapturedAt(t *testing.T) {
	for i, c := range loadVectors(t).CapturedAtParsing {
		t.Run(fmt.Sprintf("%d", i), func(t *testing.T) {
			prefix, ok := ParseCapturedAt(c.Input)
			if ok != c.Ok {
				t.Fatalf("ParseCapturedAt(%q) ok = %v, want %v (prefix %q)", c.Input, ok, c.Ok, prefix)
			}
			if ok && prefix != c.Prefix {
				t.Fatalf("ParseCapturedAt(%q) = %q, want %q", c.Input, prefix, c.Prefix)
			}
		})
	}
}

// TestTitleRoundTrip は生成 → 検証の閉包 (§3.6): deriveTitle の出力は
// suffix 0 の candidate として必ず ValidateGeneratedFilename を通る。
func TestTitleRoundTrip(t *testing.T) {
	for i, c := range loadVectors(t).TitleRoundTrip {
		t.Run(fmt.Sprintf("%d", i), func(t *testing.T) {
			title := DeriveTitle(c.Text)
			name := CandidateName(c.Prefix, title, 0)
			if !ValidateGeneratedFilename(name) {
				t.Fatalf("generated name %q (from %q) does not validate", name, c.Text)
			}
		})
	}
}
