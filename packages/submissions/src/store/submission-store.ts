import type { CatalogKey, FormCatalogEntry, Page, RecordFilter, RecordListOptions, StoredKeyMaterial, SubmissionRecord } from "../types.js";

/**
 * Where the server keeps things. One interface, several homes: a `Map` for tests,
 * IndexedDB in the browser, a database behind a Node host later. Every method is async and
 * takes and returns plain data; a store never validates, never signs, never renders.
 */
export interface SubmissionStore {
  putCatalogEntry(entry: FormCatalogEntry): Promise<void>;
  getCatalogEntry(key: CatalogKey): Promise<FormCatalogEntry | undefined>;
  /** Every entry, newest registration first. */
  listCatalog(): Promise<FormCatalogEntry[]>;
  /** Removes the entry; with `cascade`, its records and their blobs too. */
  deleteCatalogEntry(key: CatalogKey, options?: { cascade?: boolean }): Promise<void>;

  putRecord(record: SubmissionRecord): Promise<void>;
  getRecord(id: string): Promise<SubmissionRecord | undefined>;
  listRecords(options?: RecordListOptions): Promise<Page<SubmissionRecord>>;
  countRecords(filter?: RecordFilter): Promise<number>;
  /** Removes the record and the blobs it references. */
  deleteRecord(id: string): Promise<void>;

  putBlob(ref: string, bytes: Uint8Array, meta: { mimeType: string }): Promise<void>;
  getBlob(ref: string): Promise<{ bytes: Uint8Array; mimeType: string } | undefined>;
  deleteBlob(ref: string): Promise<void>;

  getKeyMaterial(): Promise<StoredKeyMaterial | undefined>;
  putKeyMaterial(material: StoredKeyMaterial): Promise<void>;

  /** Forgets everything: catalog, records, blobs and keys. */
  clear(): Promise<void>;
}

export const DEFAULT_PAGE_SIZE = 50;

/** Whether a record matches a filter — shared by the stores that filter in memory. */
export function recordMatches(record: SubmissionRecord, filter: RecordFilter | undefined): boolean {
  if (!filter) {
    return true;
  }
  if (filter.formKey !== undefined && `${record.formId}@${record.formVersion}` !== filter.formKey) {
    return false;
  }
  if (filter.status !== undefined && record.status !== filter.status) {
    return false;
  }
  if (filter.locale !== undefined && record.locale !== filter.locale) {
    return false;
  }
  if (filter.source !== undefined && record.source !== filter.source) {
    return false;
  }
  if (filter.digest !== undefined && record.digest !== filter.digest) {
    return false;
  }
  if (filter.submissionKey !== undefined && record.submissionKey !== filter.submissionKey) {
    return false;
  }
  if (filter.from !== undefined && record.receivedAt < filter.from) {
    return false;
  }
  if (filter.to !== undefined && record.receivedAt >= filter.to) {
    return false;
  }
  return true;
}

/** The cursor a page ends on: the last item's time and id, so the next page starts after it whatever was added meanwhile. */
export function cursorOf(record: SubmissionRecord): string {
  return `${record.receivedAt}|${record.id}`;
}

/** Newest first by default; the id breaks ties so the order is total. */
export function compareRecords(a: SubmissionRecord, b: SubmissionRecord, order: "desc" | "asc"): number {
  const byTime = a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return order === "asc" ? byTime : -byTime;
}

/** Filters, orders and pages a whole list in memory — what the `Map` store does, and what the IndexedDB store does after its index narrowed the set. */
export function pageRecords(all: readonly SubmissionRecord[], options: RecordListOptions = {}): Page<SubmissionRecord> {
  const order = options.order ?? "desc";
  const matching = all.filter((record) => recordMatches(record, options.filter)).sort((a, b) => compareRecords(a, b, order));
  const start = options.cursor ? matching.findIndex((record) => cursorOf(record) === options.cursor) + 1 : 0;
  const limit = Math.max(1, options.limit ?? DEFAULT_PAGE_SIZE);
  const items = matching.slice(start, start + limit);
  const last = items[items.length - 1];
  const more = start + limit < matching.length && last !== undefined;
  return { items, total: matching.length, ...(more ? { cursor: cursorOf(last) } : {}) };
}
