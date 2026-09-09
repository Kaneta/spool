// Package server は Browser と store の間の HTTP 境界 (DESIGN-v2 §6.2–§6.8)。
// 5 endpoints、token / Host / Origin 検証 (§6.3)、error taxonomy mapping (§6.5)、
// POST の suffix collision retry (§3.5)。routing framework は使わず stdlib net/http のみ。
// token / Host は Server 構築時に外から受け取り、server は生成しない (Unit 4 main の責務)。
package server

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"unicode/utf8"

	"spool/internal/namegen"
	"spool/internal/store"
	"spool/internal/textcheck"
)

// maxRequestBody は POST body の HTTP レベル上限 (DoS 防止用の実装上の値。製品
// contract は decoded text ≤ textcheck.MaxTextBytes であり、wire limit は外へ露出しない)。
// JSON string の最悪 case は全 byte が escape で 6 倍になる ("\u007f" 等) ので、
// decoded 上限と wire 上限は分離する (正当な 256 KiB 本文を escape 量で拒否しない)。
const maxRequestBody = 6*textcheck.MaxTextBytes + 8*1024

// save result 区分 (§6.4, §10.5) と error taxonomy (§6.5)。
// taxonomy 外の code は追加しない。unavailable は client 側分類であり server は発行しない。
const (
	resultSaved     = "saved"
	resultFailed    = "failed"
	resultUncertain = "uncertain"

	codeInvalidInput = "invalid_input"
	codeInvalidName  = "invalid_name"
	codeNotFound     = "not_found"
	codeNameConflict = "name_conflict"
	codeTooLarge     = "too_large"
	codeRootMissing  = "root_missing"
	codeRootChanged  = "root_changed"
	codeIOError      = "io_error"
	codeForbidden    = "forbidden"
)

// Server は store への限定 API。state を増やさず、各 request を store の操作へ写像するだけ。
type Server struct {
	st     *store.Store
	token  string
	host   string // 例: "127.0.0.1:54321"。Host header と完全一致で比較 (§6.3)
	origin string // 例: "http://127.0.0.1:54321"。Origin header と完全一致で比較 (§6.3)
	static http.Handler
	mux    *http.ServeMux
}

// New は API server を組み立てる。token / host は外から受け取る (生成しない)。
// static は token 不要の静的配信 handler (nil なら配信しない。embed.FS 本番組み込みは Unit 5)。
func New(st *store.Store, token, host string, static http.Handler) *Server {
	s := &Server{st: st, token: token, host: host, origin: "http://" + host, static: static}
	mux := http.NewServeMux()
	// API 共通 security check は handler 本体の前に一箇所で適用する (§6.3, §10)。
	mux.HandleFunc("GET /api/health", s.secure(s.handleHealth))
	mux.HandleFunc("GET /api/records", s.secure(s.handleList))
	mux.HandleFunc("GET /api/records/{name}", s.secure(s.handleRead))
	mux.HandleFunc("POST /api/records", s.secure(s.handleSave))
	mux.HandleFunc("DELETE /api/records/{name}", s.secure(s.handleDelete))
	if static != nil {
		// 静的配信は token 不要 (§6.3)。API path は上の 5 pattern が優先される。
		mux.Handle("/", static)
	}
	s.mux = mux
	return s
}

// ServeHTTP は routing も含めて mux に委譲する。
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mux.ServeHTTP(w, r)
}

// secure は API 共通 security check (§6.3, §10)。Host 完全一致 → token 完全一致 →
// state-changing request (POST / DELETE) の Origin 完全一致。
// いずれかの失敗で handler 本体 (したがって store) には到達させない。
// POST の拒否は保存結果契約 (§6.4, §10.5) に合わせる: security check で handler に
// 到達していない時点で「保存未成立が確定」であるため、client は result=failed を
// uncertain ではなく確定失敗として分類する。status (401/403) は §6.3 のまま維持。
func (s *Server) secure(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Host != s.host {
			s.writeRejection(w, r, http.StatusForbidden, "host mismatch")
			return
		}
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Spool-Token")), []byte(s.token)) != 1 {
			// 401 は token mismatch 専用 (§6.3)。code は taxonomy の forbidden。
			s.writeRejection(w, r, http.StatusUnauthorized, "token missing or mismatch")
			return
		}
		if r.Method == http.MethodPost || r.Method == http.MethodDelete {
			if r.Header.Get("Origin") != s.origin {
				s.writeRejection(w, r, http.StatusForbidden, "origin mismatch")
				return
			}
		}
		h(w, r)
	}
}

// writeRejection は taxonomy envelope を書くが、POST /api/records の拒否のみ
// save contract (result=failed) で応答する。GET / DELETE の契約は変更しない。
func (s *Server) writeRejection(w http.ResponseWriter, r *http.Request, status int, message string) {
	if r.Method == http.MethodPost && r.URL.Path == "/api/records" {
		writeJSON(w, status, saveResponse{Result: resultFailed, Code: codeForbidden, Message: message})
		return
	}
	writeAPIError(w, status, codeForbidden, message)
}

// handleHealth は最小の JSON 応答 (§6.4)。
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// recordJSON は list 1 件分。kind は store 由来の derived 分類で永続 metadata ではない。
type recordJSON struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
	Kind string `json:"kind"`
}

type listResponse struct {
	Records []recordJSON `json:"records"`
}

// handleList は root 直下の対象 record を name 昇順で返す (§6.4)。
func (s *Server) handleList(w http.ResponseWriter, r *http.Request) {
	infos, err := s.st.List()
	if err != nil {
		writeStoreError(w, err)
		return
	}
	records := make([]recordJSON, 0, len(infos))
	for _, in := range infos {
		records = append(records, recordJSON{Name: in.Name, Size: in.Size, Kind: in.Kind})
	}
	writeJSON(w, http.StatusOK, listResponse{Records: records})
}

// handleRead は本文を保存 byte のまま返す (§6.4)。trim / 改行追加 / 正規化はしない。
func (s *Server) handleRead(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !namegen.IsValidRootDirectChildName(name) {
		writeAPIError(w, http.StatusBadRequest, codeInvalidName, fmt.Sprintf("invalid record name %q", name))
		return
	}
	text, err := s.st.Read(name)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	setAPIHeaders(w)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(text)
}

// handleDelete は直接削除 (§6.8)。Trash / soft delete / undo は存在しない。
func (s *Server) handleDelete(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !namegen.IsValidRootDirectChildName(name) {
		writeAPIError(w, http.StatusBadRequest, codeInvalidName, fmt.Sprintf("invalid record name %q", name))
		return
	}
	if err := s.st.Delete(name); err != nil {
		writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// saveRequest の field は pointer にし、missing と空文字を区別する (§6.4: 両 field 必須)。
type saveRequest struct {
	Text       *string `json:"text"`
	CapturedAt *string `json:"captured_at"`
}

// saveResponse は POST 応答の body contract (§6.4, §10.5)。
// client は HTTP status ではなく result を保存結果の正として扱う。
type saveResponse struct {
	Result  string `json:"result"`
	Code    string `json:"code,omitempty"`
	Name    string `json:"name,omitempty"`
	Message string `json:"message,omitempty"`
}

// handleSave は validate → derive (prefix / title は 1 度だけ決定) → suffix retry →
// store へ create-only publish (§3, §6.6)。retry で captured_at / title を変えず、
// server 時刻を使わず、random suffix へ逃げず、overwrite しない。
func (s *Server) handleSave(w http.ResponseWriter, r *http.Request) {
	body, ok := readBody(w, r)
	if !ok {
		return
	}
	var req saveRequest
	if err := json.Unmarshal(body, &req); err != nil {
		failSave(w, http.StatusBadRequest, codeInvalidInput, "malformed JSON: "+err.Error())
		return
	}
	if req.Text == nil || req.CapturedAt == nil {
		failSave(w, http.StatusBadRequest, codeInvalidInput, "text and captured_at are required")
		return
	}
	if err := textcheck.Check([]byte(*req.Text)); err != nil {
		code, status := classify(err)
		failSave(w, status, code, err.Error())
		return
	}
	prefix, ok := namegen.ParseCapturedAt(*req.CapturedAt)
	if !ok {
		failSave(w, http.StatusBadRequest, codeInvalidInput, "invalid captured_at: "+*req.CapturedAt)
		return
	}
	// 1 回の POST で prefix と title は 1 度だけ決定する (§3)。以後の retry で変えない。
	title := namegen.DeriveTitle(*req.Text)
	for suffix := 0; ; suffix++ {
		name := namegen.CandidateName(prefix, title, suffix)
		if !namegen.IsNameWithinLimit(name) {
			// §3.5: suffix を付けると 255 byte を超えるなら確定衝突で終了。
			// 無制限 loop は存在しない (byte limit 優先)。
			failSave(w, http.StatusConflict, codeNameConflict, "no suffix fits 255 byte name limit")
			return
		}
		res := s.st.Save(name, []byte(*req.Text))
		if res.State == store.SaveFailed && errors.Is(res.Err, store.ErrNameConflict) {
			continue // 既存名との確定衝突のみ次の suffix へ。他の失敗は retry しない (§3)
		}
		writeSaveOutcome(w, name, res)
		return
	}
}

// writeSaveOutcome は store.Save の結果を §6.4 / §10.5 の body contract へ写像する。
// publish (linkat) 前の確認済み失敗が failed、publish 後の障害が uncertain。
func writeSaveOutcome(w http.ResponseWriter, name string, res store.SaveResult) {
	switch res.State {
	case store.SaveSaved:
		writeJSON(w, http.StatusCreated, saveResponse{Result: resultSaved, Name: name})
	case store.SaveUncertain:
		code, _ := classify(res.Err)
		writeJSON(w, http.StatusInternalServerError, saveResponse{
			Result: resultUncertain, Code: code, Name: name, Message: res.Err.Error(),
		})
	default: // store.SaveFailed
		code, status := classify(res.Err)
		writeJSON(w, status, saveResponse{Result: resultFailed, Code: code, Message: res.Err.Error()})
	}
}

// readBody は POST body を上限付きで読み、生 byte の UTF-8 有効性を確認する。
// 失敗時は応答済みで false を返す。Go の JSON decoder は不正 UTF-8 を U+FFFD へ
// 置換するため、decode 前の生 body 検証が必要 (§6.4: 不正入力を黙って置換しない)。
func readBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBody))
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			failSave(w, http.StatusRequestEntityTooLarge, codeTooLarge, "request body too large")
		} else {
			failSave(w, http.StatusBadRequest, codeInvalidInput, "cannot read request body")
		}
		return nil, false
	}
	if !utf8.Valid(body) {
		failSave(w, http.StatusBadRequest, codeInvalidInput, "request body is not valid UTF-8")
		return nil, false
	}
	return body, true
}

// classify は store / textcheck の error を §6.5 taxonomy へ mapping する。
// status は参考値であり、client は body の code で分岐する。
func classify(err error) (code string, status int) {
	switch {
	case errors.Is(err, store.ErrRootMissing):
		return codeRootMissing, http.StatusServiceUnavailable
	case errors.Is(err, store.ErrRootChanged):
		return codeRootChanged, http.StatusServiceUnavailable
	case errors.Is(err, store.ErrInvalidName):
		return codeInvalidName, http.StatusBadRequest
	case errors.Is(err, store.ErrNotFound):
		return codeNotFound, http.StatusNotFound
	case errors.Is(err, store.ErrNameConflict):
		return codeNameConflict, http.StatusConflict
	case errors.Is(err, textcheck.ErrNotUTF8):
		return codeInvalidInput, http.StatusBadRequest
	case errors.Is(err, textcheck.ErrTooLarge):
		return codeTooLarge, http.StatusRequestEntityTooLarge
	case errors.Is(err, store.ErrIO):
		return codeIOError, http.StatusInternalServerError
	default:
		return codeIOError, http.StatusInternalServerError
	}
}

// setAPIHeaders は API 共通 response header (§6.4)。CORS header は発行しない (§6.3)。
func setAPIHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		// v は固定の構造体のみであり到達しない。到達したら内部不変条件違反として隠さない。
		http.Error(w, "response marshal failure", http.StatusInternalServerError)
		return
	}
	setAPIHeaders(w)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(b)
}

// errBody / apiError は taxonomy error の envelope (§6.5)。GET / DELETE の失敗で使う。
type errBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type apiError struct {
	Error errBody `json:"error"`
}

func writeAPIError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, apiError{Error: errBody{Code: code, Message: message}})
}

// writeStoreError は store / textcheck error を taxonomy envelope へ写像する (§6.5)。
func writeStoreError(w http.ResponseWriter, err error) {
	code, status := classify(err)
	writeAPIError(w, status, code, err.Error())
}

// failSave は POST の publish 前確認済み失敗 (§10.5)。
func failSave(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, saveResponse{Result: resultFailed, Code: code, Message: message})
}
