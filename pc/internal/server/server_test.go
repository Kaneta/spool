package server

// HTTP 境界 test (DESIGN-v2 §13.3, §15 Unit 3)。httptest + t.TempDir + 実 store。
// fake filesystem は作らない。security negative では store 操作が起きないことも実 file で確認する。

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"spool/internal/store"
	"spool/internal/textcheck"
)

const (
	testToken  = "unit3-test-token"
	testHost   = "127.0.0.1:54321"
	testOrigin = "http://" + testHost
	// testPrefix は captured_at "2026-09-09T07:05:00" に対応する filename prefix。
	testPrefix = "20260909-0705"
)

func newTestServer(t *testing.T) (*Server, *store.Store, string) {
	t.Helper()
	root := t.TempDir()
	st, err := store.Open(root)
	if err != nil {
		t.Fatalf("open store %q: %v", root, err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return New(st, testToken, testHost, nil), st, root
}

// do は token を付け、state-changing なら Origin も付けて request を投げる。
// mutate で header / host を上書きする (negative test 用)。
func do(t *testing.T, s *Server, method, target, body string, mutate func(*http.Request)) *httptest.ResponseRecorder {
	t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, target, rd)
	req.Header.Set("X-Spool-Token", testToken)
	if method == http.MethodPost || method == http.MethodDelete {
		req.Header.Set("Origin", testOrigin)
	}
	if mutate != nil {
		mutate(req)
	}
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec
}

type errEnvelope struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

type saveEnvelope struct {
	Result string `json:"result"`
	Code   string `json:"code"`
	Name   string `json:"name"`
}

type listEnvelope struct {
	Records []struct {
		Name string `json:"name"`
		Size int64  `json:"size"`
		Kind string `json:"kind"`
	} `json:"records"`
}

func decode(t *testing.T, rec *httptest.ResponseRecorder, v any) {
	t.Helper()
	if err := json.Unmarshal(rec.Body.Bytes(), v); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
}

func requireSavedOnDisk(t *testing.T, root, name, text string) {
	t.Helper()
	got, err := os.ReadFile(filepath.Join(root, name))
	if err != nil {
		t.Fatalf("read %q directly: %v", name, err)
	}
	if string(got) != text {
		t.Fatalf("file %q content mismatch: %q", name, got)
	}
}

func rootEntries(t *testing.T, root string) []string {
	t.Helper()
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("read root: %v", err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

// A: health success。
func TestHealthSuccess(t *testing.T) {
	s, _, _ := newTestServer(t)
	rec := do(t, s, "GET", "http://"+testHost+"/api/health", "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %q", rec.Code, rec.Body.String())
	}
	if got := rec.Body.String(); got != `{"ok":true}` {
		t.Fatalf("body = %q", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("unexpected CORS header: %q", got)
	}
}

// B: token negative (missing / wrong) → 401。store 操作も起きない。
func TestTokenNegative(t *testing.T) {
	s, st, root := newTestServer(t)
	keep := testPrefix + "-keep.txt"
	if res := st.Save(keep, []byte("keep")); res.State != store.SaveSaved {
		t.Fatalf("setup save: %v", res.Err)
	}
	rec := do(t, s, "GET", "http://"+testHost+"/api/health", "", func(req *http.Request) {
		req.Header.Del("X-Spool-Token")
	})
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("missing token: status = %d", rec.Code)
	}

	rec = do(t, s, "POST", "http://"+testHost+"/api/records",
		`{"text":"x","captured_at":"2026-09-09T07:05:00"}`, func(req *http.Request) {
			req.Header.Set("X-Spool-Token", "wrong-token")
		})
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong token: status = %d", rec.Code)
	}
	// POST 拒否は save result 契約で応答する (§10.5)。Store 未到達 = 未保存確定 → failed。
	var save saveEnvelope
	decode(t, rec, &save)
	if save.Result != "failed" || save.Code != "forbidden" {
		t.Fatalf("POST wrong token: result = %q code = %q", save.Result, save.Code)
	}

	// store 操作が起きていないこと: 追加 file がなく、既存 file も消えていない。
	names := rootEntries(t, root)
	if len(names) != 1 || names[0] != keep {
		t.Fatalf("store touched on security failure: %v", names)
	}
	rec = do(t, s, "DELETE", "http://"+testHost+"/api/records/"+keep, "", func(req *http.Request) {
		req.Header.Set("X-Spool-Token", "wrong-token")
	})
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("delete wrong token: status = %d", rec.Code)
	}
	requireSavedOnDisk(t, root, keep, "keep")
}

// C: Host negative (localhost / wrong port / empty) → 403。
func TestHostNegative(t *testing.T) {
	s, _, _ := newTestServer(t)
	for _, host := range []string{"localhost:54321", "127.0.0.1:9999", "", "[::1]:54321", "example.com:54321"} {
		rec := do(t, s, "GET", "http://"+testHost+"/api/health", "", func(req *http.Request) {
			req.Host = host
		})
		if rec.Code != http.StatusForbidden {
			t.Fatalf("host %q: status = %d", host, rec.Code)
		}
	}
}

// C2: POST save の Host 拒否 → 403 + save contract (result=failed)。file は作られない。
func TestHostNegativeSaveContract(t *testing.T) {
	s, _, root := newTestServer(t)
	for _, host := range []string{"localhost:54321", "127.0.0.1:9999", ""} {
		rec := do(t, s, "POST", "http://"+testHost+"/api/records",
			`{"text":"x","captured_at":"2026-09-09T07:05:00"}`, func(req *http.Request) {
				req.Host = host
			})
		if rec.Code != http.StatusForbidden {
			t.Fatalf("POST host %q: status = %d", host, rec.Code)
		}
		var env saveEnvelope
		decode(t, rec, &env)
		if env.Result != "failed" || env.Code != "forbidden" {
			t.Fatalf("POST host %q: result = %q code = %q", host, env.Result, env.Code)
		}
	}
	if names := rootEntries(t, root); len(names) != 0 {
		t.Fatalf("store touched on host rejection: %v", names)
	}
}

// C3 (旧 C の tail): GET health Host negative は taxonomy envelope のまま (save result を付けない)。
func TestHostNegativeGetEnvelope(t *testing.T) {
	s, _, _ := newTestServer(t)
	for _, host := range []string{"localhost:54321", "127.0.0.1:9999", "", "[::1]:54321", "example.com:54321"} {
		rec := do(t, s, "GET", "http://"+testHost+"/api/health", "", func(req *http.Request) {
			req.Host = host
		})
		if rec.Code != http.StatusForbidden {
			t.Fatalf("host %q: status = %d", host, rec.Code)
		}
		var env errEnvelope
		decode(t, rec, &env)
		if env.Error.Code != "forbidden" || env.Error.Code == "" {
			t.Fatalf("GET host %q: envelope code = %q", host, env.Error.Code)
		}
	}
}

// D: Origin negative (POST / DELETE: missing / wrong / localhost origin) → 403。
// GET は Origin なしで成功する。
func TestOriginNegative(t *testing.T) {
	s, st, _ := newTestServer(t)
	name := testPrefix + "-del.txt"
	if res := st.Save(name, []byte("bye")); res.State != store.SaveSaved {
		t.Fatalf("setup save: %v", res.Err)
	}
	for _, origin := range []string{"", "http://localhost:54321", "https://127.0.0.1:54321", testOrigin + "/"} {
		rec := do(t, s, "POST", "http://"+testHost+"/api/records",
			`{"text":"x","captured_at":"2026-09-09T07:05:00"}`, func(req *http.Request) {
				req.Header.Set("Origin", origin)
			})
		if rec.Code != http.StatusForbidden {
			t.Fatalf("POST origin %q: status = %d", origin, rec.Code)
		}
		// POST 拒否は save result 契約。DELETE 拒否は taxonomy envelope のまま。
		var env saveEnvelope
		decode(t, rec, &env)
		if env.Result != "failed" || env.Code != "forbidden" {
			t.Fatalf("POST origin %q: result = %q code = %q", origin, env.Result, env.Code)
		}
		rec = do(t, s, "DELETE", "http://"+testHost+"/api/records/"+name, "", func(req *http.Request) {
			req.Header.Set("Origin", origin)
		})
		if rec.Code != http.StatusForbidden {
			t.Fatalf("DELETE origin %q: status = %d", origin, rec.Code)
		}
		var errEnv errEnvelope
		decode(t, rec, &errEnv)
		if errEnv.Error.Code != "forbidden" {
			t.Fatalf("DELETE origin %q: envelope code = %q", origin, errEnv.Error.Code)
		}
	}
	rec := do(t, s, "GET", "http://"+testHost+"/api/records", "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET without Origin: status = %d", rec.Code)
	}
}

// E: POST save → result saved、最終名、root に実 file、byte 一致。
func TestPostSaveWritesRealFile(t *testing.T) {
	s, _, root := newTestServer(t)
	text := "hello spool\n日本語\n"
	body := fmt.Sprintf(`{"text":%q,"captured_at":"2026-09-09T07:05:00"}`, text)
	rec := do(t, s, "POST", "http://"+testHost+"/api/records", body, nil)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %q", rec.Code, rec.Body.String())
	}
	var env saveEnvelope
	decode(t, rec, &env)
	if env.Result != "saved" || env.Name != testPrefix+"-hello spool.txt" {
		t.Fatalf("response = %+v", env)
	}
	requireSavedOnDisk(t, root, env.Name, text)
}

// E2: JSON escape で wire 上で膨らむ正当な decoded text (≤256 KiB) が HTTP body limit で
// 拒否されないこと。decoded ≤ 256 KiB → accepted、> 256 KiB → too_large を分けて固定する。
func TestPostWireLimitVsDecodedLimit(t *testing.T) {
	s, _, root := newTestServer(t)
	// 引用符のみの text: JSON.stringify で全 byte が \" に escape され 2 倍になる。
	quoted := strings.Repeat(`"`, 140*1024) // decoded 143,360 byte ≤ 262,144
	body := fmt.Sprintf(`{"text":%q,"captured_at":"2026-09-09T07:05:00"}`, quoted)
	rec := do(t, s, "POST", "http://"+testHost+"/api/records", body, nil)
	if rec.Code != http.StatusCreated {
		t.Fatalf("escaped 140 KiB text: status = %d body = %s", rec.Code, rec.Body.String())
	}
	var env saveEnvelope
	decode(t, rec, &env)
	if env.Result != "saved" {
		t.Fatalf("escaped 140 KiB text: result = %q", env.Result)
	}
	// decoded 256 KiB + 1 byte → too_large (wire limit に余裕があっても decoded 上限は維持)。
	over := strings.Repeat("a", textcheck.MaxTextBytes+1)
	body = fmt.Sprintf(`{"text":%q,"captured_at":"2026-09-09T07:05:00"}`, over)
	rec = do(t, s, "POST", "http://"+testHost+"/api/records", body, nil)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("decoded over limit: status = %d", rec.Code)
	}
	decode(t, rec, &env)
	if env.Result != "failed" || env.Code != "too_large" {
		t.Fatalf("decoded over limit: result = %q code = %q", env.Result, env.Code)
	}
	if names := rootEntries(t, root); len(names) != 1 {
		t.Fatalf("store contents: %v", names)
	}
}

// F: 同一 captured_at / 同一 title で複数 POST → base / ~01 / ~02。overwrite なし。
func TestPostCollisionSuffixRetry(t *testing.T) {
	s, _, root := newTestServer(t)
	bodies := []string{"dup\nv1", "dup\nv2", "dup\nv3"}
	want := []string{testPrefix + "-dup.txt", testPrefix + "-dup~01.txt", testPrefix + "-dup~02.txt"}
	for i, text := range bodies {
		rec := do(t, s, "POST", "http://"+testHost+"/api/records",
			fmt.Sprintf(`{"text":%q,"captured_at":"2026-09-09T07:05:00"}`, text), nil)
		if rec.Code != http.StatusCreated {
			t.Fatalf("post %d: status = %d, body = %q", i, rec.Code, rec.Body.String())
		}
		var env saveEnvelope
		decode(t, rec, &env)
		if env.Result != "saved" || env.Name != want[i] {
			t.Fatalf("post %d: response = %+v, want name %q", i, env, want[i])
		}
		requireSavedOnDisk(t, root, want[i], text)
	}
	// 4 件目は ~03 へ進む (suffix は必要桁数まで続く)。
	rec := do(t, s, "POST", "http://"+testHost+"/api/records",
		`{"text":"dup\nv4","captured_at":"2026-09-09T07:05:00"}`, nil)
	var env saveEnvelope
	decode(t, rec, &env)
	if env.Name != testPrefix+"-dup~03.txt" {
		t.Fatalf("4th name = %q", env.Name)
	}
	requireSavedOnDisk(t, root, env.Name, "dup\nv4")
}

// G: POST invalid (malformed JSON / invalid captured_at / missing / wrong type / too large)
// → failed + 正しい code。file は 1 つも作らない。
func TestPostInvalidInput(t *testing.T) {
	s, _, root := newTestServer(t)
	tooBig := strings.Repeat("a", textcheck.MaxTextBytes+1)
	cases := []struct {
		name string
		body string
		code string
	}{
		{"malformed", `{`, "invalid_input"},
		{"empty object", `{}`, "invalid_input"},
		{"missing captured_at", `{"text":"x"}`, "invalid_input"},
		{"missing text", `{"captured_at":"2026-09-09T07:05:00"}`, "invalid_input"},
		{"text not string", `{"text":123,"captured_at":"2026-09-09T07:05:00"}`, "invalid_input"},
		{"captured_at not string", `{"text":"x","captured_at":123}`, "invalid_input"},
		{"impossible date", `{"text":"x","captured_at":"2026-02-30T10:00:00"}`, "invalid_input"},
		{"bad hour", `{"text":"x","captured_at":"2026-09-09T25:00:00"}`, "invalid_input"},
		{"with Z", `{"text":"x","captured_at":"2026-09-09T10:00:00Z"}`, "invalid_input"},
		{"with offset", `{"text":"x","captured_at":"2026-09-09T10:00:00+09:00"}`, "invalid_input"},
		{"no seconds", `{"text":"x","captured_at":"2026-09-09T10:00"}`, "invalid_input"},
		{"too large", fmt.Sprintf(`{"text":%q,"captured_at":"2026-09-09T07:05:00"}`, tooBig), "too_large"},
		{"empty text is valid", `{"text":"","captured_at":"2026-09-09T07:05:00"}`, ""}, // control: 空文字は有効
	}
	for _, c := range cases {
		rec := do(t, s, "POST", "http://"+testHost+"/api/records", c.body, nil)
		var env saveEnvelope
		decode(t, rec, &env)
		if c.code == "" {
			if env.Result != "saved" {
				t.Fatalf("%s: expected control save, got %+v (%d)", c.name, env, rec.Code)
			}
			requireSavedOnDisk(t, root, env.Name, "")
			continue
		}
		if env.Result != "failed" || env.Code != c.code {
			t.Fatalf("%s: result = %q code = %q (%d)", c.name, env.Result, env.Code, rec.Code)
		}
	}
	// file は control の 1 件のみ。
	if names := rootEntries(t, root); len(names) != 1 {
		t.Fatalf("unexpected files after invalid posts: %v", names)
	}
}

// H: store.Save の結果 → saved / failed / uncertain body mapping (§10.5)。
// store の fault hook は Unit 2 の test で固定済みのため、server 側 mapping を直接検証する。
func TestSaveOutcomeMapping(t *testing.T) {
	cases := []struct {
		name       string
		res        store.SaveResult
		wantStatus int
		wantResult string
		wantCode   string
		wantName   string
	}{
		{
			name:       "saved",
			res:        store.SaveResult{State: store.SaveSaved},
			wantStatus: http.StatusCreated,
			wantResult: "saved",
			wantName:   "20260909-0705-a.txt",
		},
		{
			name: "uncertain after publish",
			res: store.SaveResult{State: store.SaveUncertain,
				Err: fmt.Errorf("%w: sync dir: boom", store.ErrIO)},
			wantStatus: http.StatusInternalServerError,
			wantResult: "uncertain",
			wantCode:   "io_error",
			wantName:   "20260909-0705-b.txt",
		},
		{
			name: "failed root_changed before publish",
			res: store.SaveResult{State: store.SaveFailed,
				Err: fmt.Errorf("%w: root replaced", store.ErrRootChanged)},
			wantStatus: http.StatusServiceUnavailable,
			wantResult: "failed",
			wantCode:   "root_changed",
		},
		{
			name: "failed io before publish",
			res: store.SaveResult{State: store.SaveFailed,
				Err: fmt.Errorf("%w: write temp: boom", store.ErrIO)},
			wantStatus: http.StatusInternalServerError,
			wantResult: "failed",
			wantCode:   "io_error",
		},
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		writeSaveOutcome(rec, c.wantName, c.res)
		if rec.Code != c.wantStatus {
			t.Fatalf("%s: status = %d body = %q", c.name, rec.Code, rec.Body.String())
		}
		var env saveEnvelope
		decode(t, rec, &env)
		if env.Result != c.wantResult || env.Code != c.wantCode {
			t.Fatalf("%s: result = %q code = %q", c.name, env.Result, env.Code)
		}
		if env.Name != c.wantName {
			t.Fatalf("%s: name = %q", c.name, env.Name)
		}
	}
}

// I: list。captured + external .txt → name 昇順 / size / kind。
func TestList(t *testing.T) {
	s, st, root := newTestServer(t)
	if res := st.Save(testPrefix+"-cap.txt", []byte("c")); res.State != store.SaveSaved {
		t.Fatalf("setup save: %v", res.Err)
	}
	if err := os.WriteFile(filepath.Join(root, "my notes.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatalf("write external: %v", err)
	}
	rec := do(t, s, "GET", "http://"+testHost+"/api/records", "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var env listEnvelope
	decode(t, rec, &env)
	if len(env.Records) != 2 {
		t.Fatalf("records = %+v", env.Records)
	}
	first, second := env.Records[0], env.Records[1]
	if first.Name != testPrefix+"-cap.txt" || first.Size != 1 || first.Kind != "captured" {
		t.Fatalf("first = %+v", first)
	}
	if second.Name != "my notes.txt" || second.Size != 5 || second.Kind != "external" {
		t.Fatalf("second = %+v", second)
	}
	// 昇順を明示確認 (name 比較)。
	if !(first.Name < second.Name) {
		t.Fatalf("not ascending: %q >= %q", first.Name, second.Name)
	}
}

// J: read exact bytes。保存 byte をそのまま返し、改行追加なし。
func TestReadExactBytes(t *testing.T) {
	s, _, _ := newTestServer(t)
	text := "line1\nline2\n日本語\n"
	rec := do(t, s, "POST", "http://"+testHost+"/api/records",
		fmt.Sprintf(`{"text":%q,"captured_at":"2026-09-09T07:05:00"}`, text), nil)
	var env saveEnvelope
	decode(t, rec, &env)

	target := "http://" + testHost + "/api/records/" + strings.ReplaceAll(env.Name, " ", "%20")
	rec = do(t, s, "GET", target, "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %q", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); got != "text/plain; charset=utf-8" {
		t.Fatalf("Content-Type = %q", got)
	}
	if got := rec.Body.String(); got != text {
		t.Fatalf("body mismatch: %q != %q", got, text)
	}
	// 不在は not_found。
	rec = do(t, s, "GET", "http://"+testHost+"/api/records/"+testPrefix+"-missing.txt", "", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing: status = %d", rec.Code)
	}
	var env2 errEnvelope
	decode(t, rec, &env2)
	if env2.Error.Code != "not_found" {
		t.Fatalf("missing: code = %q", env2.Error.Code)
	}
}

// K: delete。有効な security で file が消え、list にも出ない。不在は not_found。
func TestDelete(t *testing.T) {
	s, st, root := newTestServer(t)
	name := testPrefix + "-bye.txt"
	if res := st.Save(name, []byte("gone")); res.State != store.SaveSaved {
		t.Fatalf("setup save: %v", res.Err)
	}
	rec := do(t, s, "DELETE", "http://"+testHost+"/api/records/"+name, "", nil)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, body = %q", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, name)); !os.IsNotExist(err) {
		t.Fatalf("file still exists: %v", err)
	}
	rec = do(t, s, "GET", "http://"+testHost+"/api/records", "", nil)
	var env listEnvelope
	decode(t, rec, &env)
	if len(env.Records) != 0 {
		t.Fatalf("records after delete = %+v", env.Records)
	}
	rec = do(t, s, "DELETE", "http://"+testHost+"/api/records/"+name, "", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("second delete: status = %d", rec.Code)
	}
}

// L: traversal / encoded name が root 外へ到達しない。
func TestTraversalNames(t *testing.T) {
	s, _, root := newTestServer(t)
	// root の外に読まれてはいけない / 消されてはいけない file を置く。
	secret := filepath.Join(filepath.Dir(root), "spool-unit3-secret.txt")
	if err := os.WriteFile(secret, []byte("secret"), 0o644); err != nil {
		t.Fatalf("write secret: %v", err)
	}
	t.Cleanup(func() { _ = os.Remove(secret) })

	// literal "../" は mux が clean path して /secret.txt へ redirect する (307)。
	rec := do(t, s, "GET", "http://"+testHost+"/api/records/../spool-unit3-secret.txt", "", nil)
	if rec.Code != http.StatusTemporaryRedirect {
		t.Fatalf("literal dotdot: status = %d", rec.Code)
	}
	rec = do(t, s, "GET", "http://"+testHost+"/secret.txt", "", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("redirect target: status = %d", rec.Code)
	}

	// encoded traversal / slash / backslash / NUL → invalid_name。
	for _, n := range []string{
		"%2e%2e%2fspool-unit3-secret.txt", "a%2fb.txt", "a%5cb.txt", "%00.txt", "..%2Fspool-unit3-secret.txt",
	} {
		rec := do(t, s, "GET", "http://"+testHost+"/api/records/"+n, "", nil)
		if rec.Code == http.StatusOK {
			t.Fatalf("GET %q: reached a file", n)
		}
		var env errEnvelope
		decode(t, rec, &env)
		if env.Error.Code != "invalid_name" {
			t.Fatalf("GET %q: status = %d code = %q", n, rec.Code, env.Error.Code)
		}
		rec = do(t, s, "DELETE", "http://"+testHost+"/api/records/"+n, "", nil)
		if rec.Code == http.StatusOK || rec.Code == http.StatusNoContent {
			t.Fatalf("DELETE %q: accepted", n)
		}
	}
	// secret が外で無傷、root も無傷。
	if got, err := os.ReadFile(secret); err != nil || string(got) != "secret" {
		t.Fatalf("secret touched: %q %v", got, err)
	}
	if names := rootEntries(t, root); len(names) != 0 {
		t.Fatalf("root touched: %v", names)
	}
}

// M: root path 置換後 → GET / POST / DELETE が root_changed へ mapping。自動 fallback なし。
func TestRootChangedMapping(t *testing.T) {
	s, st, root := newTestServer(t)
	name := testPrefix + "-rc.txt"
	if res := st.Save(name, []byte("x")); res.State != store.SaveSaved {
		t.Fatalf("setup save: %v", res.Err)
	}
	moved := root + ".moved"
	if err := os.Rename(root, moved); err != nil {
		t.Fatalf("rename root: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(moved) })
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatalf("recreate root: %v", err)
	}

	rec := do(t, s, "GET", "http://"+testHost+"/api/records", "", nil)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("GET list: status = %d body = %q", rec.Code, rec.Body.String())
	}
	var env errEnvelope
	decode(t, rec, &env)
	if env.Error.Code != "root_changed" {
		t.Fatalf("GET list: code = %q", env.Error.Code)
	}

	rec = do(t, s, "POST", "http://"+testHost+"/api/records",
		`{"text":"x","captured_at":"2026-09-09T07:05:00"}`, nil)
	var save saveEnvelope
	decode(t, rec, &save)
	if save.Result != "failed" || save.Code != "root_changed" {
		t.Fatalf("POST: %+v (%d)", save, rec.Code)
	}

	rec = do(t, s, "DELETE", "http://"+testHost+"/api/records/"+name, "", nil)
	decode(t, rec, &env)
	if rec.Code != http.StatusServiceUnavailable || env.Error.Code != "root_changed" {
		t.Fatalf("DELETE: %d %q", rec.Code, env.Error.Code)
	}
}

// static は token 不要。API は token 必須。API path と static path は衝突しない。
func TestStaticNoToken(t *testing.T) {
	_, st, _ := newTestServer(t)
	s := New(st, testToken, testHost, http.NotFoundHandler())
	rec := do(t, s, "GET", "http://"+testHost+"/index.html", "", func(req *http.Request) {
		req.Header.Del("X-Spool-Token")
	})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("static: status = %d", rec.Code)
	}
	rec = do(t, s, "GET", "http://"+testHost+"/api/health", "", func(req *http.Request) {
		req.Header.Del("X-Spool-Token")
	})
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("api without token: status = %d", rec.Code)
	}
	rec = do(t, s, "POST", "http://"+testHost+"/api/records",
		`{"text":"x","captured_at":"2026-09-09T07:05:00"}`, nil)
	if rec.Code != http.StatusCreated {
		t.Fatalf("api routing over static: status = %d", rec.Code)
	}
}

// 並行 POST でも非上書き (linkat 原子性) が保たれる。-race で mux + store を走査する。
func TestConcurrentPostSamePayload(t *testing.T) {
	s, _, root := newTestServer(t)
	const body = `{"text":"race\nv","captured_at":"2026-09-09T07:05:00"}`
	const n = 4
	results := make([]saveEnvelope, n)
	var wg sync.WaitGroup
	for i := range n {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			req := httptest.NewRequest(http.MethodPost, "http://"+testHost+"/api/records", strings.NewReader(body))
			req.Header.Set("X-Spool-Token", testToken)
			req.Header.Set("Origin", testOrigin)
			rec := httptest.NewRecorder()
			s.ServeHTTP(rec, req)
			_ = json.Unmarshal(rec.Body.Bytes(), &results[i])
		}(i)
	}
	wg.Wait()
	seen := map[string]bool{}
	for i, env := range results {
		if env.Result != "saved" {
			t.Fatalf("post %d: %+v", i, env)
		}
		if seen[env.Name] {
			t.Fatalf("duplicate name %q (overwrite risk)", env.Name)
		}
		seen[env.Name] = true
		requireSavedOnDisk(t, root, env.Name, "race\nv")
	}
	if len(seen) != n {
		t.Fatalf("saved %d distinct names, want %d", len(seen), n)
	}
}
