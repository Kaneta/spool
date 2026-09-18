// cloudflare-headers.ts — ui/public/_headers を読み、Cloudflare Pages と同じ header 付与を模擬する
// test-only static server (mobile.spec.ts 専用 helper)。CSP violation の実 browser 検証に使う。
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

export type HeaderRule = { pattern: string; headers: Record<string, string> };

/** `_headers` format: 空行区切り block。1 行目が path pattern、以降は 2 space indent の `Name: value`。 */
export function loadHeaderRules(headersPath: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  for (const block of fs.readFileSync(headersPath, "utf8").split(/\n\s*\n/)) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    const headers: Record<string, string> = {};
    for (const line of lines.slice(1)) {
      const i = line.indexOf(":");
      headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    rules.push({ pattern: lines[0]!, headers });
  }
  return rules;
}

/** Cloudflare Pages と同じ一致規則: `/*` は全 path、`/assets/*` は `/assets/` prefix。 */
function matches(rule: HeaderRule, pathname: string): boolean {
  if (rule.pattern === "/*") return true;
  if (rule.pattern.endsWith("/*")) return pathname.startsWith(rule.pattern.slice(0, -1));
  return rule.pattern === pathname;
}

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

/** dist を配信し、_headers の rule に一致した response header を付与する小さな server。 */
export function createHeadersServer(distDir: string, headersPath: string): http.Server {
  const rules = loadHeaderRules(headersPath);
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const file = path.join(distDir, url.pathname === "/" ? "index.html" : url.pathname);
    let body: Buffer;
    try {
      body = fs.readFileSync(file);
    } catch {
      res.writeHead(404);
      res.end();
      return;
    }
    const headers: Record<string, string> = {};
    for (const rule of rules) {
      if (matches(rule, url.pathname)) Object.assign(headers, rule.headers);
    }
    res.writeHead(200, { "Content-Type": mimeTypes[path.extname(file)] ?? "application/octet-stream", ...headers });
    res.end(body);
  });
}
