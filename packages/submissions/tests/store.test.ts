import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";

import { IndexedDbSubmissionStore, InMemorySubmissionStore, type FormCatalogEntry, type SubmissionRecord, type SubmissionStore } from "../src/index.js";
import { DEFAULT_SUBMISSION_SETTINGS } from "../src/types.js";

function entry(formId: string, version: string, registeredAt: string): FormCatalogEntry {
  return {
    key: `${formId}@${version}`,
    formId,
    formVersion: version,
    registeredAt,
    definition: { id: formId, version, schemaVersion: "1.0.0", root: { id: "root", type: "form", configuration: {} } },
    settings: structuredClone(DEFAULT_SUBMISSION_SETTINGS)
  };
}

function record(id: string, receivedAt: string, extra: Partial<SubmissionRecord> = {}): SubmissionRecord {
  return {
    id,
    formId: "intake",
    formVersion: "1.0.0",
    receivedAt,
    status: "accepted",
    document: { versionContext: { form: { id: "intake", version: "1.0.0" }, client: { runtimeVersion: "1", rendererVersion: "1", schemaVersion: "1" } }, submission: { locale: "en", values: { name: id } } },
    digest: `digest-${id}`,
    submissionKey: `key-${id}`,
    locale: "en",
    source: "renderer",
    errors: [],
    ...extra
  };
}

/** The contract every store honours, run against each home. */
function storeContract(name: string, make: () => SubmissionStore | Promise<SubmissionStore>): void {
  describe(name, () => {
    let store: SubmissionStore;
    afterEach(async () => {
      await store?.clear();
    });

    it("keeps the catalog, newest registration first, and cascades a delete to the form's records and blobs", async () => {
      store = await make();
      await store.putCatalogEntry(entry("intake", "1.0.0", "2026-09-15T10:00:00.000Z"));
      await store.putCatalogEntry(entry("survey", "2.0.0", "2026-09-15T11:00:00.000Z"));
      expect((await store.listCatalog()).map((item) => item.key)).toEqual(["survey@2.0.0", "intake@1.0.0"]);
      expect((await store.getCatalogEntry("intake@1.0.0"))?.formId).toBe("intake");

      await store.putRecord(record("a", "2026-09-15T10:01:00.000Z", { pdf: { fileName: "a.pdf", pageCount: 1, blobRef: "blob-a", sha256: "x", size: 3, layoutId: "l", signed: false, attached: false, warnings: [] } }));
      await store.putBlob("blob-a", new Uint8Array([1, 2, 3]), { mimeType: "application/pdf" });
      await store.putRecord(record("b", "2026-09-15T10:02:00.000Z", { formId: "survey", formVersion: "2.0.0" }));

      await store.deleteCatalogEntry("intake@1.0.0", { cascade: true });
      expect(await store.getCatalogEntry("intake@1.0.0")).toBeUndefined();
      expect(await store.getRecord("a")).toBeUndefined();
      expect(await store.getBlob("blob-a")).toBeUndefined();
      expect((await store.getRecord("b"))?.id).toBe("b");
    });

    it("lists records newest first, pages by cursor, filters, counts, and removes a record's blob with it", async () => {
      store = await make();
      for (let index = 0; index < 5; index += 1) {
        await store.putRecord(record(`r${index}`, `2026-09-15T10:0${index}:00.000Z`, { status: index % 2 === 0 ? "accepted" : "rejected", locale: index < 3 ? "en" : "fr" }));
      }
      const first = await store.listRecords({ limit: 2 });
      expect(first.items.map((item) => item.id)).toEqual(["r4", "r3"]);
      expect(first.total).toBe(5);
      expect(first.cursor).toBeDefined();
      const second = await store.listRecords({ limit: 2, cursor: first.cursor! });
      expect(second.items.map((item) => item.id)).toEqual(["r2", "r1"]);
      const third = await store.listRecords({ limit: 2, cursor: second.cursor! });
      expect(third.items.map((item) => item.id)).toEqual(["r0"]);
      expect(third.cursor).toBeUndefined();

      expect((await store.listRecords({ order: "asc", limit: 10 })).items[0]?.id).toBe("r0");
      expect((await store.listRecords({ filter: { status: "rejected" } })).items.map((item) => item.id)).toEqual(["r3", "r1"]);
      expect((await store.listRecords({ filter: { formKey: "intake@1.0.0", locale: "fr" } })).total).toBe(2);
      expect((await store.listRecords({ filter: { submissionKey: "key-r2" } })).items.map((item) => item.id)).toEqual(["r2"]);
      expect((await store.listRecords({ filter: { from: "2026-09-15T10:02:00.000Z", to: "2026-09-15T10:04:00.000Z" } })).items.map((item) => item.id)).toEqual(["r3", "r2"]);
      expect(await store.countRecords({ status: "accepted" })).toBe(3);
      expect(await store.countRecords({ formKey: "nobody@0" })).toBe(0);

      await store.putRecord(record("p", "2026-09-15T11:00:00.000Z", { pdf: { fileName: "p.pdf", pageCount: 1, blobRef: "blob-p", sha256: "y", size: 1, layoutId: "l", signed: true, attached: true, warnings: [] } }));
      await store.putBlob("blob-p", new Uint8Array([9]), { mimeType: "application/pdf" });
      expect((await store.getBlob("blob-p"))?.bytes).toEqual(new Uint8Array([9]));
      await store.deleteRecord("p");
      expect(await store.getBlob("blob-p")).toBeUndefined();
    });

    it("hands back copies, not the stored objects", async () => {
      store = await make();
      const original = record("c", "2026-09-15T10:00:00.000Z");
      await store.putRecord(original);
      original.locale = "changed";
      const read = await store.getRecord("c");
      expect(read?.locale).toBe("en");
      read!.locale = "changed again";
      expect((await store.getRecord("c"))?.locale).toBe("en");
    });

    it("keeps the server's key material and forgets everything on clear", async () => {
      store = await make();
      expect(await store.getKeyMaterial()).toBeUndefined();
      await store.putKeyMaterial({ algorithm: "ECDSA-P256-SHA256", privateKeyPkcs8: "k", certificateDer: "c", subject: "CN=x", createdAt: "2026-09-15T00:00:00.000Z" });
      expect((await store.getKeyMaterial())?.subject).toBe("CN=x");
      await store.putCatalogEntry(entry("intake", "1.0.0", "2026-09-15T10:00:00.000Z"));
      await store.clear();
      expect(await store.getKeyMaterial()).toBeUndefined();
      expect(await store.listCatalog()).toEqual([]);
    });
  });
}

storeContract("InMemorySubmissionStore", () => new InMemorySubmissionStore());

let databases = 0;
storeContract("IndexedDbSubmissionStore (fake-indexeddb)", () => {
  databases += 1;
  return new IndexedDbSubmissionStore(indexedDB, `datum-test-submissions-${databases}`);
});
