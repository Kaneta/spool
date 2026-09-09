// indexeddb.ts — DESIGN-v2 §5.1–§5.3。具体 IndexedDB API を直接使う。wrapper・抽象化は作らない。

export type StoredRecord = {
  name: string; // primary key (§3.2 format)
  text: string; // UTF-8 plain text、空文字有効
};

export const DB_NAME = "spool";
export const DB_VERSION = 1;
export const RECORD_STORE = "records";

export function openDatabase(): Promise<IDBDatabase> {
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  const req = indexedDB.open(DB_NAME, DB_VERSION);
  req.onupgradeneeded = () => {
    if (!req.result.objectStoreNames.contains(RECORD_STORE)) {
      req.result.createObjectStore(RECORD_STORE, { keyPath: "name" });
    }
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error ?? new Error("indexedDB.open failed"));
  req.onblocked = () => reject(new Error("indexedDB.open blocked"));
  return promise;
}

export type AddOutcome =
  | { kind: "committed" } // transaction complete 済み (保存成功の根拠)
  | { kind: "conflict" } // ConstraintError: 既存 key。create-only 衝突 (§3.5)
  | { kind: "error"; error: unknown };

/** 1候補 = 1 transaction。成功は tx の `complete` event のみ。request の success では返さない (§5.2)。 */
export function addRecord(db: IDBDatabase, record: StoredRecord): Promise<AddOutcome> {
  const { promise, resolve } = Promise.withResolvers<AddOutcome>();
  let requestError: unknown;
  const tx = db.transaction(RECORD_STORE, "readwrite");
  const req = tx.objectStore(RECORD_STORE).add(record);
  // preventDefault しない: request 失敗時は tx が abort し、onabort で分類する
  req.onerror = () => {
    requestError = req.error;
  };
  tx.oncomplete = () => resolve({ kind: "committed" });
  tx.onerror = () => {}; // abort 経由で分類する
  tx.onabort = () => resolve(classify(requestError ?? tx.error));
  return promise;
}

function classify(error: unknown): AddOutcome {
  if (error instanceof DOMException && error.name === "ConstraintError") return { kind: "conflict" };
  return { kind: "error", error };
}

/** 読み取り系の 1 request。list / read は readonly tx (§5.3)。 */
function readonlyRequest<T>(db: IDBDatabase, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const tx = db.transaction(RECORD_STORE, "readonly");
  const req = run(tx.objectStore(RECORD_STORE));
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error ?? new Error("readonly request failed"));
  return promise;
}

/** §5.3: getAllKeys()。key 順 = captured 時系列 (昇順)。list は name のみで text を持たない。 */
export function listRecords(db: IDBDatabase): Promise<string[]> {
  return readonlyRequest(db, (store) => store.getAllKeys() as IDBRequest<string[]>);
}

/** §5.3: get(name)。常に現在の IndexedDB から読み、不在なら undefined。 */
export function readRecord(db: IDBDatabase, name: string): Promise<StoredRecord | undefined> {
  return readonlyRequest(db, (store) => store.get(name));
}

/** §5.4: 全件読み取り (export 用)。list と別に text も取得する。export 用 metadata は永続化しない。 */
export function readAllRecords(db: IDBDatabase): Promise<StoredRecord[]> {
  return readonlyRequest(db, (store) => store.getAll() as IDBRequest<StoredRecord[]>);
}

export type DeleteOutcome =
  | { kind: "deleted" } // transaction complete 済み (UI 更新はこの後のみ)
  | { kind: "error"; error: unknown };

/** §5.3: readwrite tx で delete(name)。UI は tx の `complete` 後にのみ更新する。不在 key の delete は no-op で complete する。 */
export function deleteRecord(db: IDBDatabase, name: string): Promise<DeleteOutcome> {
  const { promise, resolve } = Promise.withResolvers<DeleteOutcome>();
  let requestError: unknown;
  const tx = db.transaction(RECORD_STORE, "readwrite");
  const req = tx.objectStore(RECORD_STORE).delete(name);
  req.onerror = () => {
    requestError = req.error;
  };
  tx.oncomplete = () => resolve({ kind: "deleted" });
  tx.onerror = () => {}; // abort 経由で分類する
  tx.onabort = () => resolve({ kind: "error", error: requestError ?? tx.error });
  return promise;
}
