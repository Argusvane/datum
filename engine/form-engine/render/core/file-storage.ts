import {
  DEFAULT_FILE_STORAGE,
  type Base64FileAttachment,
  type FileAttachment,
  type FileUploadConfiguration
} from "../../core/schema/file-upload.js";

/**
 * How a picked file becomes the value a `file` component stores — the seam between the
 * browser's `File` and the engine's `FileAttachment`.
 *
 * The renderer element owns the control and the state write; it hands each picked file to
 * the storage the component's configuration names and stores what comes back. So a host that
 * wants files in a bucket rather than in the values writes one `FileStorage` — presign, PUT,
 * return `{ storage: "s3", name, type, size, url }` — registers it on the renderer, and sets
 * `storage: "s3"` on the component. Nothing else in the form changes: rules, constraints,
 * the read-only listing and the builder all read the attachment envelope, not the bytes.
 */

export interface FileStorageContext {
  componentId: string;
  /** Where the attachment will be written in form state. */
  valuePath: string;
  /** The component's file configuration — a storage may honour `accept` or `maxFileSize` early. */
  configuration: FileUploadConfiguration;
}

/** One way of carrying a picked file into form state. */
export interface FileStorage {
  /** The kind a component's `configuration.storage` names to pick this storage. */
  kind: string;
  /**
   * Stores one file and returns the attachment the form will hold for it. A rejection leaves
   * the field as it was: the renderer reports the failure and stores nothing.
   */
  store(file: File, context: FileStorageContext): Promise<FileAttachment>;
}

/** Resolves the storage for a kind, or nothing when no storage of that kind is known. */
export interface FileStorageResolver {
  resolve(kind: string): FileStorage | undefined;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  // In slices: spreading a whole file into one call overflows the argument list.
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/**
 * The bytes of a blob, base64-encoded with no `data:` prefix. `FileReader` where there is
 * one — the browser encodes natively, off the main thread — and a plain encode of the buffer
 * where there is not (a server-side render, a test runner).
 */
export function encodeBase64(blob: Blob): Promise<string> {
  if (typeof FileReader === "function") {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === "string" ? reader.result : "";
        const comma = result.indexOf(",");
        resolve(comma >= 0 ? result.slice(comma + 1) : "");
      };
      reader.onerror = () => reject(reader.error ?? new Error("Could not read file"));
      reader.readAsDataURL(blob);
    });
  }
  return blob.arrayBuffer().then((buffer) => bytesToBase64(new Uint8Array(buffer)));
}

/**
 * The bytes back out of a base64 attachment's `data`, for handing an embedded file to the
 * person as a download. `undefined` for text that is not base64 at all — a hand-edited draft
 * — rather than a throw from deep inside a click handler.
 */
export function decodeBase64(data: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return undefined;
  }
}

/**
 * The engine's own storage: the file's bytes embedded in the value. Self-contained — a
 * submission carries its attachments and needs no second fetch to be complete — at the cost
 * of the value being as large as the file, which is what the component's size limit is for.
 */
export const base64FileStorage: FileStorage = {
  kind: DEFAULT_FILE_STORAGE,
  async store(file: File): Promise<Base64FileAttachment> {
    return {
      storage: "base64",
      name: file.name,
      type: file.type,
      size: file.size,
      data: await encodeBase64(file)
    };
  }
};

/**
 * A resolver over the given storages plus the engine's base64 one, so a host adding a bucket
 * storage does not lose embedded files. A host storage of kind `"base64"` replaces the
 * engine's — the one way to change how embedding itself works.
 */
export function createFileStorageResolver(storages: readonly FileStorage[] = []): FileStorageResolver {
  const byKind = new Map<string, FileStorage>([[base64FileStorage.kind, base64FileStorage]]);
  for (const storage of storages) {
    byKind.set(storage.kind, storage);
  }
  return { resolve: (kind) => byKind.get(kind) };
}

/** What a renderer uses when the host registers no storages: base64 only. */
export const DEFAULT_FILE_STORAGE_RESOLVER: FileStorageResolver = createFileStorageResolver();
