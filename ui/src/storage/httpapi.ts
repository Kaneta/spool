// httpapi.ts — PC storage backend (DESIGN-v2 §6.4)。小さな concrete module。
// token は location.hash 由来で呼び出し側が渡し、cookie / localStorage / sessionStorage / IndexedDB には保存しない。
// same-origin fetch のみ (CORS 処理なし)。Origin header は browser が state-changing request に自動送信する。
// 保存結果の正は HTTP status ではなく body の `result` (§6.4, §10.5)。

export class ApiError extends Error {
  constructor(readonly code: string) {
    super(`api error: ${code}`);
  }
}

/** startup URL fragment (#token=...) から token を取り出す。他の形は受けない。 */
export function tokenFromHash(hash: string): string | null {
  if (!hash.startsWith("#token=")) return null;
  const token = hash.slice("#token=".length);
  return token === "" ? null : token;
}

async function request(token: string, method: string, path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("X-Spool-Token", token);
  return fetch(path, { ...init, method, headers });
}

/** 障害監視用の最小 health check。応答したか (認証を通ったか) だけを返す。 */
export async function health(token: string): Promise<boolean> {
  try {
    const resp = await request(token, "GET", "/api/health");
    return resp.ok;
  } catch {
    return false;
  }
}

export type RecordEntry = {
  name: string;
  size: number;
  kind: "captured" | "external"; // store 由来の derived 分類。保存しない
};

/** GET /api/records。wire は name 昇順 (server 正)。表示順は呼び出し側が決める。 */
export async function listRecords(token: string): Promise<RecordEntry[]> {
  const resp = await request(token, "GET", "/api/records");
  if (!resp.ok) throw await apiError(resp);
  const data: unknown = await resp.json();
  if (!isListResponse(data)) throw new ApiError("invalid_response");
  return data.records.map((r) => ({ name: r.name, size: r.size, kind: r.kind }));
}

function isListResponse(data: unknown): data is { records: { name: string; size: number; kind: "captured" | "external" }[] } {
  if (typeof data !== "object" || data === null) return false;
  const records = (data as { records?: unknown }).records;
  if (!Array.isArray(records)) return false;
  return records.every((r) => {
    if (typeof r !== "object" || r === null) return false;
    const { name, size, kind } = r as Record<string, unknown>;
    return typeof name === "string" && typeof size === "number" && (kind === "captured" || kind === "external");
  });
}

/** GET /api/records/{name}。毎回 server から読む (本文の第二 cache を作らない)。 */
export async function readRecord(token: string, name: string): Promise<string> {
  const resp = await request(token, "GET", `/api/records/${encodeURIComponent(name)}`);
  if (!resp.ok) throw await apiError(resp);
  return resp.text();
}

/** DELETE /api/records/{name}。直接削除。undo は存在しない。 */
export async function deleteRecord(token: string, name: string): Promise<void> {
  const resp = await request(token, "DELETE", `/api/records/${encodeURIComponent(name)}`);
  if (!resp.ok) throw await apiError(resp);
}

export type SaveOutcome =
  | { kind: "saved"; name: string } // body result == saved
  | { kind: "failed"; code: string } // publish 前の確認済み失敗 (contract 通りの応答のみ)
  | { kind: "uncertain" }; // commit した可能性があるが確認できない。自動 retry しない

/** POST /api/records。collision suffix loop は server 側の所有であり client には存在しない (§3.3)。
 * transport 失敗・body 解析不能・result field 不在は uncertain (§13)。status だけで判定しない (§14)。 */
export async function saveRecord(token: string, text: string, capturedAt: string): Promise<SaveOutcome> {
  let resp: Response;
  try {
    resp = await request(token, "POST", "/api/records", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, captured_at: capturedAt }),
    });
  } catch {
    return { kind: "uncertain" }; // network error / connection closed
  }
  let data: unknown;
  try {
    data = await resp.json();
  } catch {
    return { kind: "uncertain" }; // response body 解析不能
  }
  if (typeof data !== "object" || data === null || !("result" in data)) {
    return { kind: "uncertain" }; // 期待する result field が無い
  }
  const { result, name, code } = data as { result: unknown; name?: unknown; code?: unknown };
  if (result === "saved" && typeof name === "string") return { kind: "saved", name };
  if (result === "uncertain") return { kind: "uncertain" };
  if (result === "failed" && typeof code === "string") return { kind: "failed", code };
  return { kind: "uncertain" }; // contract 外の形は断定しない
}

/** GET / DELETE の error は taxonomy envelope ({error:{code,message}})。読めなければ status 由来。 */
async function apiError(resp: Response): Promise<ApiError> {
  try {
    const data: unknown = await resp.json();
    const code = (data as { error?: { code?: unknown } }).error?.code;
    if (typeof code === "string") return new ApiError(code);
  } catch {
    // body が JSON でなければ status 由来に落ちる
  }
  return new ApiError(`http_${resp.status}`);
}
