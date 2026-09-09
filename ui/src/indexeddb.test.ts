import { expect, it } from "vitest";
import { addRecord, deleteRecord, type StoredRecord } from "./indexeddb";

// 限定的 fault injection 用の最小 stub。実 IndexedDB の request/tx 順序だけを模倣する:
// request error は preventDefault されない限り tx abort につながり、tx.error が同じ error を持つ。
// 実 IndexedDB での通常経路 (保存/collision) は実 browser test で確認する。

type FakeRequest = {
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  error: DOMException | null;
};

type FakeStore = {
  add(record: StoredRecord): FakeRequest;
  delete(name: string): FakeRequest;
};

type FakeTx = {
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  error: DOMException | null;
  objectStore(name: string): FakeStore;
};

function makeDb() {
  const ops: Array<{ req: FakeRequest; tx: FakeTx }> = [];
  const db = {
    transaction(_store: string, _mode: IDBTransactionMode): FakeTx {
      // tx 自体が objectStore を持つ。addRecord は tx.oncomplete / tx.onabort をこのオブジェクトへ代入する
      const tx: FakeTx = {
        oncomplete: null,
        onerror: null,
        onabort: null,
        error: null,
        objectStore: (_name) => ({
          add: (_record) => {
            const req: FakeRequest = { onsuccess: null, onerror: null, error: null };
            ops.push({ req, tx });
            return req;
          },
          delete: (_name) => {
            const req: FakeRequest = { onsuccess: null, onerror: null, error: null };
            ops.push({ req, tx });
            return req;
          },
        }),
      };
      return tx;
    },
  } as unknown as IDBDatabase; // 実 IndexedDB と同形の request/tx 順序だけを持つ stub への意図的な割当
  return {
    db,
    requestSuccess: () => ops[ops.length - 1]!.req.onsuccess?.(),
    complete: () => ops[ops.length - 1]!.tx.oncomplete?.(),
    commit: () => {
      ops[ops.length - 1]!.req.onsuccess?.();
      ops[ops.length - 1]!.tx.oncomplete?.();
    },
    fail: (name: string) => {
      const { req, tx } = ops[ops.length - 1]!;
      req.error = new DOMException("boom", name);
      req.onerror?.();
      tx.error = req.error;
      tx.onabort?.();
    },
    succeedThenAbort: () => {
      const { req, tx } = ops[ops.length - 1]!;
      req.onsuccess?.();
      tx.error = new DOMException("boom", "AbortError");
      tx.onabort?.();
    },
  };
}

it("保存成功は request success では解決せず、tx complete でだけ committed になる", async () => {
  const h = makeDb();
  let settled = false;
  const p = addRecord(h.db, { name: "n.txt", text: "t" });
  void p.then(() => {
    settled = true;
  });
  h.requestSuccess();
  expect(settled).toBe(false); // request success では Saved にできない
  h.complete();
  await expect(p).resolves.toEqual({ kind: "committed" });
});

it("ConstraintError だけが conflict になる", async () => {
  const h = makeDb();
  const p = addRecord(h.db, { name: "n.txt", text: "t" });
  h.fail("ConstraintError");
  await expect(p).resolves.toEqual({ kind: "conflict" });
});

it("QuotaExceededError は conflict ではなく failed (error) になる", async () => {
  const h = makeDb();
  const p = addRecord(h.db, { name: "n.txt", text: "t" });
  h.fail("QuotaExceededError");
  const outcome = await p;
  expect(outcome.kind).toBe("error");
  if (outcome.kind === "error") {
    expect(outcome.error instanceof DOMException).toBe(true);
    if (outcome.error instanceof DOMException) {
      expect(outcome.error.name).toBe("QuotaExceededError");
    }
  }
});

it("request success 後の tx abort も committed にならない", async () => {
  const h = makeDb();
  const p = addRecord(h.db, { name: "n.txt", text: "t" });
  h.succeedThenAbort();
  const outcome = await p;
  expect(outcome.kind).toBe("error");
});

it("delete も tx complete でだけ deleted になる", async () => {
  const h = makeDb();
  const p = deleteRecord(h.db, "n.txt");
  let settled = false;
  void p.then(() => {
    settled = true;
  });
  h.requestSuccess();
  expect(settled).toBe(false);
  h.commit();
  await expect(p).resolves.toEqual({ kind: "deleted" });
});

it("delete の tx abort は deleted にならない", async () => {
  const h = makeDb();
  const p = deleteRecord(h.db, "n.txt");
  h.fail("UnknownError");
  const outcome = await p;
  expect(outcome.kind).toBe("error");
});
