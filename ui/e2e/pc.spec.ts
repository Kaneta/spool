// pc.spec.ts — spool Local PC UI の実 browser E2E (M2 Unit 5 §25–§28)。
// 実 Go process (production PC build embed) + 実 Chromium。fake server は使わない。
// root は実 filesystem (fs 直読みで byte 一致を確認)。1 process / 1 root を全 test で共有する。
import { execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const repoRoot = path.resolve(import.meta.dirname, "..", ".."); // ui/e2e → spool2
const pcDir = path.join(repoRoot, "pc");

const savedText = "1行目 日本語\n\tTABあり\n\n末尾空白:   \n";

let proc: ChildProcess | undefined;
let rootDir = ""; // mkdtemp の親 (teardown で削除)
let root = ""; // spool root directory
let base = ""; // http://127.0.0.1:<port>
let token = "";
let page: Page;
let dialogAction: "accept" | "dismiss" = "dismiss"; // confirm は既定 dismiss。必要な test だけ accept に切り替える

test.beforeAll(async ({ browser }) => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "spool-e2e-"));
  const binPath = path.join(rootDir, "spool-e2e-bin"); // repo 外。teardown で rootDir ごと消える
  execSync(`go build -o ${binPath} .`, { cwd: pcDir });
  root = path.join(rootDir, "spool");
  proc = spawn(binPath, ["--root", root, "--init"], { stdio: ["ignore", "pipe", "pipe"] });
  const url = await new Promise<string>((resolve, reject) => {
    let out = "";
    proc!.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const m = out.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]+/);
      if (m) resolve(m[0]);
    });
    proc!.on("exit", (code) => reject(new Error(`spool exited early: ${code}\n${out}`)));
    setTimeout(() => reject(new Error(`startup URL timeout\n${out}`)), 10_000);
  });
  base = url.slice(0, url.indexOf("/#"));
  token = url.slice(url.indexOf("token=") + "token=".length);

  const context = await browser.newContext();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  page = await context.newPage();
  page.on("dialog", (dialog) => {
    if (dialogAction === "accept") void dialog.accept();
    else void dialog.dismiss();
  });
  await page.goto(`${base}/#token=${token}`); // fragment は server へ送られない
  await expect(page.locator("#save")).toBeVisible();
});

test.afterAll(async () => {
  if (proc !== undefined && proc.exitCode === null) {
    proc.kill("SIGTERM");
    await new Promise<void>((resolve) => proc!.on("exit", () => resolve()));
  }
  if (rootDir !== "") fs.rmSync(rootDir, { recursive: true, force: true }); // binary も rootDir ごと消える
});

const rootTxtFiles = (): string[] => fs.readdirSync(root).filter((f) => f.endsWith(".txt"));
const recordButton = (name: string) => page.locator(`#list button[data-name="${name}"]`);
const readTextContent = (): Promise<string | null> => page.locator("#read-text").evaluate((el) => el.textContent);
// click 後の selectRecord は async fetch を含むため、read-name が切り替わるまで待つ (race 対策)。
const selectAndWait = async (name: string): Promise<void> => {
  await recordButton(name).click();
  await expect(page.locator("#read-name")).toHaveText(name);
};
const removeRootFile = async (name: string): Promise<void> => {
  fs.rmSync(path.join(root, name));
  await page.click("#refresh");
};
// A: startup — production PC build を embed した実 binary で UI が開く。
test("startup: PC UI opens from startup URL", async () => {
  await expect(page.locator("#text")).toBeVisible();
  await expect(page.locator("#refresh")).toBeVisible();
  await expect(page.locator("#server-state")).toHaveText("");
});

// B: save — 日本語 / 複数行 / TAB / 空行 / 末尾空白を含む本文が byte 完全一致で ordinary .txt になる。
test("save: writes ordinary .txt with exact bytes", async () => {
  await page.fill("#text", savedText);
  await page.click("#save");
  await expect(page.locator("#result")).toHaveText(/^Saved: .+\.txt$/);
  await expect(page.locator("#text")).toHaveValue(""); // 成功時のみ clear
  const files = rootTxtFiles();
  expect(files).toHaveLength(1);
  expect(fs.readFileSync(path.join(root, files[0]!), "utf8")).toBe(savedText); // OS から byte 一致
});

// C: list — 保存済みが表示され、外部作成 file は Refresh で external 表示される (降順)。
test("list: captured shown and external file appears via Refresh", async () => {
  const captured = rootTxtFiles()[0]!;
  await expect(recordButton(captured)).toBeVisible();
  fs.writeFileSync(path.join(root, "external note.txt"), "external body\n");
  await page.click("#refresh");
  await expect(recordButton("external note.txt")).toHaveText("external note.txt [external]");
  const names = await page.locator("#list button").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.name));
  expect(names.indexOf("external note.txt")).toBeLessThan(names.indexOf(captured)); // 降順 = external が上
});

// D: read — captured / external 双方の本文が一致し、HTML は literal 表示で実行されない。
test("read: shows exact text without executing HTML", async () => {
  const captured = rootTxtFiles().find((f) => !f.includes("external"))!;
  await selectAndWait(captured);
  expect(await readTextContent()).toBe(savedText);

  const xss = `<img src=x onerror="window.__spoolXss=1"><script>window.__spoolXss2=1</script>`;
  fs.writeFileSync(path.join(root, "20260909-0700-xss.txt"), `${xss}\n`);
  await page.click("#refresh");
  await selectAndWait("20260909-0700-xss.txt");
  expect(await readTextContent()).toBe(`${xss}\n`); // literal 表示
  expect(await page.evaluate(() => (window as { __spoolXss?: number }).__spoolXss)).toBeUndefined();
  expect(await page.evaluate(() => (window as { __spoolXss2?: number }).__spoolXss2)).toBeUndefined();

  await selectAndWait("external note.txt");
  expect(await readTextContent()).toBe("external body\n");
});

// E: copy — 選択中 record を改めて読み、clipboard へ byte 一致で copy する。
test("copy: clipboard receives current body", async () => {
  // readdir の順序は不定なため、保存済み本文の byte 一致で対象を決める (不定順依存を避ける)。
  const captured = rootTxtFiles().find((f) => {
    try {
      return fs.readFileSync(path.join(root, f), "utf8") === savedText;
    } catch {
      return false;
    }
  })!;
  await selectAndWait(captured); // copy 時も現在値を server から読む。選択完成を待ってから Copy
  await page.click("#copy");
  await expect(page.locator("#read-result")).toHaveText(`Copied: ${captured}`);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(savedText);
});

// F: delete — confirm cancel は無傷。accept で file 消失、reload しても復活しない。
test("delete: confirm cancel keeps file, accept removes it", async () => {
  await selectAndWait("external note.txt");
  dialogAction = "dismiss";
  await page.click("#delete");
  expect(fs.existsSync(path.join(root, "external note.txt"))).toBe(true); // cancel は無傷
  await expect(recordButton("external note.txt")).toBeVisible();

  dialogAction = "accept";
  await page.click("#delete");
  await expect(recordButton("external note.txt")).toHaveCount(0); // UI 反映 = server 削除完了
  expect(fs.existsSync(path.join(root, "external note.txt"))).toBe(false); // 実 file が消える
  dialogAction = "dismiss";

  await page.reload(); // fragment token ごと復帰
  await expect(page.locator("#save")).toBeVisible();
  await expect(recordButton("external note.txt")).toHaveCount(0); // 復活しない
  expect(rootTxtFiles()).toHaveLength(2); // captured + xss
});

// I: external change — shell 由来の追加・削除に Refresh で追随し、背景 polling は存在しない。
test("external change: Refresh follows fs edits without polling", async () => {
  fs.writeFileSync(path.join(root, "added-later.txt"), "added\n");
  await page.click("#refresh");
  await expect(recordButton("added-later.txt")).toBeVisible();
  fs.rmSync(path.join(root, "added-later.txt"));
  await page.click("#refresh");
  await expect(recordButton("added-later.txt")).toHaveCount(0);

  let recordRequests = 0;
  page.on("request", (req) => {
    if (req.url().includes("/api/records")) recordRequests += 1;
  });
  await page.waitForTimeout(1_000); // 背景更新があればここで request が増える
  expect(recordRequests).toBe(0); // polling / watcher / SSE なし
});

// G: stale save completion — save 完了前に textarea を書き換えると、新しい入力は消されない。
test("stale save: old completion keeps newer textarea input", async () => {
  await page.route("**/api/records", async (route) => {
    if (route.request().method() === "POST") {
      await new Promise((r) => setTimeout(r, 500)); // 応答を遅らせて pending 中の入力を作る
      await route.continue();
      return;
    }
    await route.continue();
  });
  await page.fill("#text", "stale-A");
  await page.click("#save");
  await page.fill("#text", "stale-B-new-input"); // save 完了前に新しい入力
  await expect(page.locator("#result")).toHaveText(/^Saved: /);
  expect(await page.inputValue("#text")).toBe("stale-B-new-input"); // 新しい入力が消えない
  await page.unroute("**/api/records");
  await removeRootFile(/^Saved: (.+)$/.exec((await page.locator("#result").textContent())!)![1]!); // cleanup
});

// H: collision — 同一 captured minute / 同一 title の連続 save は server が suffix を解決し overwrite しない。
test("collision: repeated save gets ~01 suffix without overwrite", async () => {
  await page.fill("#text", "collision body");
  await page.click("#save");
  await expect(page.locator("#result")).toHaveText(/^Saved: .+collision body\.txt$/);
  const first = /^Saved: (.+)$/.exec((await page.locator("#result").textContent())!)![1]!;

  await page.fill("#text", "collision body");
  await page.click("#save");
  await expect(page.locator("#result")).toHaveText(/^Saved: .+collision body~01\.txt$/);
  const second = /^Saved: (.+)$/.exec((await page.locator("#result").textContent())!)![1]!;

  expect(second).toBe(`${first.slice(0, -4)}~01.txt`); // client 側に collision logic はなく server が決めた名
  expect(rootTxtFiles().filter((f) => f.includes("collision body"))).toHaveLength(2); // overwrite なし
  expect(fs.readFileSync(path.join(root, first), "utf8")).toBe("collision body");
  expect(fs.readFileSync(path.join(root, second), "utf8")).toBe("collision body");
});

// §26 uncertain — request は server に届いて保存され得るが、response は client へ返らない。
test("uncertain: lost save response shows Uncertain and never auto-retries", async () => {
  await page.route("**/api/records", async (route) => {
    if (route.request().method() === "POST") {
      await route.fetch(); // 実 server が処理する → file ができ得る
      await route.abort("failed"); // client には response を返さない
      return;
    }
    await route.continue();
  });
  const text = "uncertain body";
  await page.fill("#text", text);
  await page.click("#save");
  await expect(page.locator("#result")).toContainText("Uncertain");
  expect(await page.inputValue("#text")).toBe(text); // textarea 保持
  await page.unroute("**/api/records");

  // server 側には file が存在するが、client は Saved 扱いにしない
  const uncertainFile = rootTxtFiles().find((f) => fs.readFileSync(path.join(root, f), "utf8") === text);
  expect(uncertainFile).toBeDefined();
  await page.waitForTimeout(500); // 自動 retry なし: 表示は Uncertain のまま
  await expect(page.locator("#result")).toContainText("Uncertain");
  await removeRootFile(uncertainFile!); // cleanup
});

// §27 missing token — fragment token なしで開くと API が使えないことが最小表示で分かる。
test("missing token: UI shows unavailable state", async ({ browser }) => {
  const context = await browser.newContext();
  const p = await context.newPage();
  await p.goto(`${base}/`); // fragment なし
  await expect(p.locator("#server-state")).toContainText("token missing");
  await expect(p.locator("#save")).toBeDisabled();
  await context.close();
});
