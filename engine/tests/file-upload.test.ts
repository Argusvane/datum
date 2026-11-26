import { describe, expect, it } from "vitest";

import {
  BYTES_PER_MEGABYTE,
  DEFAULT_FILE_STORAGE,
  FILE_STORAGE_OPTIONS,
  formatFileSize,
  isBase64FileAttachment,
  isFileAttachment,
  matchesAccept,
  readAcceptTokens,
  readFileAttachments,
  readFileUploadConfiguration
} from "../form-engine/core/schema/file-upload.js";

const pdf = { storage: "base64", name: "Statement.PDF", type: "application/pdf", size: 2048, data: "AAAA" };
const photo = { storage: "s3", name: "me.jpg", type: "image/jpeg", size: 300, url: "https://bucket/me.jpg" };

describe("file upload — configuration", () => {
  it("defaults to the engine's base64 storage, one file, anything accepted, no limit", () => {
    expect(readFileUploadConfiguration({})).toEqual({
      storage: "base64",
      multiple: false,
      accept: [],
      maxFileSize: undefined
    });
    expect(readFileUploadConfiguration(undefined).storage).toBe(DEFAULT_FILE_STORAGE);
    expect(FILE_STORAGE_OPTIONS.map((option) => option.value)).toEqual(["base64"]);
  });

  it("passes an unknown storage kind through rather than silently substituting base64", () => {
    // A host storage the engine has never heard of is exactly what the seam is for.
    expect(readFileUploadConfiguration({ storage: " s3 " }).storage).toBe("s3");
    expect(readFileUploadConfiguration({ storage: "" }).storage).toBe("base64");
  });

  it("reads the limit in megabytes and reports it in bytes", () => {
    expect(readFileUploadConfiguration({ maxFileSizeMb: 5 }).maxFileSize).toBe(5 * BYTES_PER_MEGABYTE);
    expect(readFileUploadConfiguration({ maxFileSizeMb: 0.5 }).maxFileSize).toBe(BYTES_PER_MEGABYTE / 2);
    for (const none of [0, -1, "5", Number.NaN, 0.0000001]) {
      expect(readFileUploadConfiguration({ maxFileSizeMb: none }).maxFileSize).toBeUndefined();
    }
  });

  it("normalizes accept tokens and drops what is neither an extension nor a MIME type", () => {
    expect(readAcceptTokens(" .PDF, image/* ,application/zip,.pdf")).toEqual([".pdf", "image/*", "application/zip"]);
    expect(readAcceptTokens([".png", "not a type", "image/png"])).toEqual([".png", "image/png"]);
    expect(readAcceptTokens("image")).toEqual([]);
    expect(readAcceptTokens(42)).toEqual([]);
    expect(readFileUploadConfiguration({ accept: ".pdf", multiple: true })).toMatchObject({
      accept: [".pdf"],
      multiple: true
    });
  });
});

describe("file upload — attachments", () => {
  it("recognises the envelope every storage kind records, and the base64 specialization", () => {
    expect(isFileAttachment(pdf)).toBe(true);
    expect(isFileAttachment(photo)).toBe(true);
    expect(isBase64FileAttachment(pdf)).toBe(true);
    expect(isBase64FileAttachment(photo)).toBe(false);
    expect(isBase64FileAttachment({ ...pdf, data: undefined })).toBe(false);
    for (const not of [undefined, null, "x.pdf", [], { name: "x" }, { ...pdf, storage: "" }, { ...pdf, size: "2" }]) {
      expect(isFileAttachment(not)).toBe(false);
    }
  });

  it("reads one attachment or a list, and nothing from a value of another shape", () => {
    expect(readFileAttachments(pdf)).toEqual([pdf]);
    expect(readFileAttachments([pdf, "junk", photo])).toEqual([pdf, photo]);
    expect(readFileAttachments("C:\\fakepath\\x.pdf")).toEqual([]);
    expect(readFileAttachments(undefined)).toEqual([]);
  });

  it("matches accept tokens the way the browser reads the attribute", () => {
    expect(matchesAccept(pdf, [])).toBe(true);
    expect(matchesAccept(pdf, [".pdf"])).toBe(true);
    expect(matchesAccept(pdf, ["application/pdf"])).toBe(true);
    expect(matchesAccept(pdf, ["image/*"])).toBe(false);
    expect(matchesAccept(photo, ["image/*"])).toBe(true);
    expect(matchesAccept(photo, ["image/png", ".jpeg"])).toBe(false);
    expect(matchesAccept({ name: "notes", type: "" }, [".txt"])).toBe(false);
  });

  it("formats a size for a person, with one decimal only where it helps", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(12 * 1024 + 400)).toBe("12 KB");
    expect(formatFileSize(5 * BYTES_PER_MEGABYTE)).toBe("5 MB");
    expect(formatFileSize(2.5 * BYTES_PER_MEGABYTE * 1024)).toBe("2.5 GB");
    expect(formatFileSize(Number.NaN)).toBe("0 B");
  });
});
