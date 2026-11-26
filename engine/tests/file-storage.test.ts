import { describe, expect, it } from "vitest";

import {
  DEFAULT_FILE_STORAGE_RESOLVER,
  base64FileStorage,
  createFileStorageResolver,
  decodeBase64,
  encodeBase64,
  type FileStorage
} from "../form-engine/render/core/file-storage.js";
import { readFileUploadConfiguration } from "../form-engine/core/schema/file-upload.js";

const context = {
  componentId: "doc",
  valuePath: "doc",
  configuration: readFileUploadConfiguration({})
};

describe("file storage — base64", () => {
  it("embeds the file's bytes in the attachment, with the envelope every storage records", async () => {
    const file = new File(["hello, datum"], "note.txt", { type: "text/plain" });
    const attachment = await base64FileStorage.store(file, context);
    expect(attachment).toEqual({
      storage: "base64",
      name: "note.txt",
      type: "text/plain",
      size: 12,
      data: btoa("hello, datum")
    });
  });

  it("round-trips bytes, and refuses text that is not base64 instead of throwing", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
    const encoded = await encodeBase64(new Blob([bytes]));
    expect(decodeBase64(encoded)).toEqual(bytes);
    expect(decodeBase64("not base64!")).toBeUndefined();
  });

  it("encodes an empty file as an empty payload", async () => {
    expect(await encodeBase64(new Blob([]))).toBe("");
  });
});

describe("file storage — resolver", () => {
  it("knows base64 out of the box and nothing else", () => {
    expect(DEFAULT_FILE_STORAGE_RESOLVER.resolve("base64")).toBe(base64FileStorage);
    expect(DEFAULT_FILE_STORAGE_RESOLVER.resolve("s3")).toBeUndefined();
  });

  it("adds a host's storage kinds beside base64, and lets a host replace base64 itself", () => {
    const s3: FileStorage = {
      kind: "s3",
      store: async (file) => ({ storage: "s3", name: file.name, type: file.type, size: file.size })
    };
    const resolver = createFileStorageResolver([s3]);
    expect(resolver.resolve("s3")).toBe(s3);
    expect(resolver.resolve("base64")).toBe(base64FileStorage);

    const ownBase64: FileStorage = { ...base64FileStorage, kind: "base64" };
    expect(createFileStorageResolver([ownBase64]).resolve("base64")).toBe(ownBase64);
  });
});
