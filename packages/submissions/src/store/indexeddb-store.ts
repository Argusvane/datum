import type { CatalogKey, FormCatalogEntry, Page, RecordFilter, RecordListOptions, StoredKeyMaterial, SubmissionRecord } from "../types.js";
import { pageRecords, recordMatches, type SubmissionStore } from "./submission-store.js";

/**
 * The store in the browser's IndexedDB: four object stores — `catalog`, `records`, `blobs`
 * (the PDFs) and `keys` (the server's identity) — in one database that survives a reload the
 * way a server's disk does. The factory is handed in rather than read from a global, so the
 * page decides which IndexedDB this is (the window's, a fake in a test) and Node never sees a
 * reference to one. Listing narrows by index where one fits and pages in memory after, which
 * is plenty for a demo's thousands of records.
 */
export const SUBMISSIONS_DB_NAME = "datum-demo-submissions";
export const SUBMISSIONS_DB_VERSION = 1;

const CATALOG = "catalog";
const RECORDS = "records";
const BLOBS = "blobs";
const KEYS = "keys";
const SERVER_KEY = "server";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

interface StoredBlob {
  ref: string;
  bytes: ArrayBuffer;
  mimeType: string;
}

export class IndexedDbSubmissionStore implements SubmissionStore {
  private db: Promise<IDBDatabase> | undefined;

  constructor(
    private readonly factory: IDBFactory,
    private readonly name: string = SUBMISSIONS_DB_NAME
  ) {}

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = new Promise((resolve, reject) => {
        const opening = this.factory.open(this.name, SUBMISSIONS_DB_VERSION);
        opening.onupgradeneeded = (event) => {
          const db = opening.result;
          // Each version's changes in order, so a database at any older version arrives at this one.
          if (event.oldVersion < 1) {
            db.createObjectStore(CATALOG, { keyPath: "key" });
            const records = db.createObjectStore(RECORDS, { keyPath: "id" });
            records.createIndex("byForm", ["formId", "formVersion", "receivedAt"]);
            records.createIndex("byReceived", "receivedAt");
            records.createIndex("byStatus", ["status", "receivedAt"]);
            db.createObjectStore(BLOBS, { keyPath: "ref" });
            db.createObjectStore(KEYS);
          }
        };
        opening.onsuccess = () => {
          const db = opening.result;
          // Another tab upgrading the schema closes this connection; the next call reopens.
          db.onversionchange = () => {
            db.close();
            this.db = undefined;
          };
          resolve(db);
        };
        opening.onerror = () => reject(opening.error ?? new Error("IndexedDB could not open"));
        opening.onblocked = () => reject(new Error("IndexedDB open blocked by another connection"));
      });
    }
    return this.db;
  }

  private async read<T>(store: string, run: (objectStore: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    const tx = db.transaction(store, "readonly");
    const result = await request(run(tx.objectStore(store)));
    await done(tx);
    return result;
  }

  private async write(stores: string[], run: (tx: IDBTransaction) => void): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(stores, "readwrite");
    run(tx);
    await done(tx);
  }

  public async putCatalogEntry(entry: FormCatalogEntry): Promise<void> {
    await this.write([CATALOG], (tx) => tx.objectStore(CATALOG).put(entry));
  }

  public async getCatalogEntry(key: CatalogKey): Promise<FormCatalogEntry | undefined> {
    return (await this.read(CATALOG, (store) => store.get(key))) as FormCatalogEntry | undefined;
  }

  public async listCatalog(): Promise<FormCatalogEntry[]> {
    const entries = (await this.read(CATALOG, (store) => store.getAll())) as FormCatalogEntry[];
    return entries.sort((a, b) => (a.registeredAt < b.registeredAt ? 1 : a.registeredAt > b.registeredAt ? -1 : a.key.localeCompare(b.key)));
  }

  public async deleteCatalogEntry(key: CatalogKey, options: { cascade?: boolean } = {}): Promise<void> {
    const records = options.cascade ? await this.recordsOfForm(key) : [];
    await this.write([CATALOG, RECORDS, BLOBS], (tx) => {
      tx.objectStore(CATALOG).delete(key);
      for (const record of records) {
        tx.objectStore(RECORDS).delete(record.id);
        if (record.pdf) {
          tx.objectStore(BLOBS).delete(record.pdf.blobRef);
        }
      }
    });
  }

  private async recordsOfForm(key: CatalogKey): Promise<SubmissionRecord[]> {
    const at = key.lastIndexOf("@");
    if (at < 0) {
      return [];
    }
    const formId = key.slice(0, at);
    const formVersion = key.slice(at + 1);
    const range = IDBKeyRange.bound([formId, formVersion, ""], [formId, formVersion, "￿"]);
    return (await this.read(RECORDS, (store) => store.index("byForm").getAll(range))) as SubmissionRecord[];
  }

  public async putRecord(record: SubmissionRecord): Promise<void> {
    await this.write([RECORDS], (tx) => tx.objectStore(RECORDS).put(record));
  }

  public async getRecord(id: string): Promise<SubmissionRecord | undefined> {
    return (await this.read(RECORDS, (store) => store.get(id))) as SubmissionRecord | undefined;
  }

  private async candidates(filter: RecordFilter | undefined): Promise<SubmissionRecord[]> {
    if (filter?.formKey) {
      return this.recordsOfForm(filter.formKey);
    }
    if (filter?.status) {
      const range = IDBKeyRange.bound([filter.status, ""], [filter.status, "￿"]);
      return (await this.read(RECORDS, (store) => store.index("byStatus").getAll(range))) as SubmissionRecord[];
    }
    return (await this.read(RECORDS, (store) => store.getAll())) as SubmissionRecord[];
  }

  public async listRecords(options: RecordListOptions = {}): Promise<Page<SubmissionRecord>> {
    return pageRecords(await this.candidates(options.filter), options);
  }

  public async countRecords(filter?: RecordFilter): Promise<number> {
    return (await this.candidates(filter)).filter((record) => recordMatches(record, filter)).length;
  }

  public async deleteRecord(id: string): Promise<void> {
    const record = await this.getRecord(id);
    await this.write([RECORDS, BLOBS], (tx) => {
      tx.objectStore(RECORDS).delete(id);
      if (record?.pdf) {
        tx.objectStore(BLOBS).delete(record.pdf.blobRef);
      }
    });
  }

  public async putBlob(ref: string, bytes: Uint8Array, meta: { mimeType: string }): Promise<void> {
    const copy = bytes.slice().buffer as ArrayBuffer;
    const stored: StoredBlob = { ref, bytes: copy, mimeType: meta.mimeType };
    await this.write([BLOBS], (tx) => tx.objectStore(BLOBS).put(stored));
  }

  public async getBlob(ref: string): Promise<{ bytes: Uint8Array; mimeType: string } | undefined> {
    const stored = (await this.read(BLOBS, (store) => store.get(ref))) as StoredBlob | undefined;
    return stored ? { bytes: new Uint8Array(stored.bytes), mimeType: stored.mimeType } : undefined;
  }

  public async deleteBlob(ref: string): Promise<void> {
    await this.write([BLOBS], (tx) => tx.objectStore(BLOBS).delete(ref));
  }

  public async getKeyMaterial(): Promise<StoredKeyMaterial | undefined> {
    return (await this.read(KEYS, (store) => store.get(SERVER_KEY))) as StoredKeyMaterial | undefined;
  }

  public async putKeyMaterial(material: StoredKeyMaterial): Promise<void> {
    await this.write([KEYS], (tx) => tx.objectStore(KEYS).put(material, SERVER_KEY));
  }

  public async clear(): Promise<void> {
    await this.write([CATALOG, RECORDS, BLOBS, KEYS], (tx) => {
      for (const store of [CATALOG, RECORDS, BLOBS, KEYS]) {
        tx.objectStore(store).clear();
      }
    });
  }

  /** Closes the connection; the next call reopens it. */
  public async close(): Promise<void> {
    if (this.db) {
      const db = await this.db;
      db.close();
      this.db = undefined;
    }
  }
}
