import type { CatalogKey, FormCatalogEntry, Page, RecordFilter, RecordListOptions, StoredKeyMaterial, SubmissionRecord } from "../types.js";
import { pageRecords, recordMatches, type SubmissionStore } from "./submission-store.js";

/**
 * The store as three `Map`s: what tests run against, and what a page without IndexedDB (a
 * test DOM) falls back to. Values are cloned on the way in and out so a caller's later edits
 * never reach what was stored — the same contract a database gives.
 */
export class InMemorySubmissionStore implements SubmissionStore {
  private readonly catalog = new Map<CatalogKey, FormCatalogEntry>();
  private readonly records = new Map<string, SubmissionRecord>();
  private readonly blobs = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  private keys: StoredKeyMaterial | undefined;

  public async putCatalogEntry(entry: FormCatalogEntry): Promise<void> {
    this.catalog.set(entry.key, structuredClone(entry));
  }

  public async getCatalogEntry(key: CatalogKey): Promise<FormCatalogEntry | undefined> {
    const entry = this.catalog.get(key);
    return entry ? structuredClone(entry) : undefined;
  }

  public async listCatalog(): Promise<FormCatalogEntry[]> {
    return [...this.catalog.values()].map((entry) => structuredClone(entry)).sort((a, b) => (a.registeredAt < b.registeredAt ? 1 : a.registeredAt > b.registeredAt ? -1 : a.key.localeCompare(b.key)));
  }

  public async deleteCatalogEntry(key: CatalogKey, options: { cascade?: boolean } = {}): Promise<void> {
    this.catalog.delete(key);
    if (options.cascade) {
      for (const record of [...this.records.values()]) {
        if (`${record.formId}@${record.formVersion}` === key) {
          await this.deleteRecord(record.id);
        }
      }
    }
  }

  public async putRecord(record: SubmissionRecord): Promise<void> {
    this.records.set(record.id, structuredClone(record));
  }

  public async getRecord(id: string): Promise<SubmissionRecord | undefined> {
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  public async listRecords(options: RecordListOptions = {}): Promise<Page<SubmissionRecord>> {
    const page = pageRecords([...this.records.values()], options);
    return { ...page, items: page.items.map((record) => structuredClone(record)) };
  }

  public async countRecords(filter?: RecordFilter): Promise<number> {
    let count = 0;
    for (const record of this.records.values()) {
      if (recordMatches(record, filter)) {
        count += 1;
      }
    }
    return count;
  }

  public async deleteRecord(id: string): Promise<void> {
    const record = this.records.get(id);
    if (record?.pdf) {
      this.blobs.delete(record.pdf.blobRef);
    }
    this.records.delete(id);
  }

  public async putBlob(ref: string, bytes: Uint8Array, meta: { mimeType: string }): Promise<void> {
    this.blobs.set(ref, { bytes: bytes.slice(), mimeType: meta.mimeType });
  }

  public async getBlob(ref: string): Promise<{ bytes: Uint8Array; mimeType: string } | undefined> {
    const blob = this.blobs.get(ref);
    return blob ? { bytes: blob.bytes.slice(), mimeType: blob.mimeType } : undefined;
  }

  public async deleteBlob(ref: string): Promise<void> {
    this.blobs.delete(ref);
  }

  public async getKeyMaterial(): Promise<StoredKeyMaterial | undefined> {
    return this.keys ? { ...this.keys } : undefined;
  }

  public async putKeyMaterial(material: StoredKeyMaterial): Promise<void> {
    this.keys = { ...material };
  }

  public async clear(): Promise<void> {
    this.catalog.clear();
    this.records.clear();
    this.blobs.clear();
    this.keys = undefined;
  }
}
