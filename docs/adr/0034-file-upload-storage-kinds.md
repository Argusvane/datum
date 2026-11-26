# ADR 0034: File Upload Stores Through a Named Storage Kind

## Status
Accepted.

## Context

A form needs to take files — a scan of an ID, a receipt, a photo. The simplest form of that is
for the file's bytes to travel inside the form's values, base64-encoded, so a submission is
self-contained and nothing has to be set up server-side to receive it. But that is not where
files stay. A production host puts them in object storage and keeps a link, or streams them to
an upload endpoint that returns a handle, and a form authored against embedded bytes has to move
to that without being rewritten.

So the question is not "how do we embed a file" but "what does the form hold for a file, such
that where the bytes went can change underneath it".

## Decision

1. **A `file` component holds attachments, and an attachment names its storage.** The value
   is one `FileAttachment` (or a list, when `multiple`): `{ storage, name, type, size }` is
   the envelope every storage kind records, and `storage` says which specialization to expect
   beyond it. The engine's kind is `"base64"`, whose attachment adds `data` — the bytes, with
   no `data:` prefix. A host's kind adds whatever it keeps (`url`, `key`, `etag`).
   `core/schema/file-upload.ts` owns the envelope and its guards.

2. **The component's configuration names the storage kind** (`configuration.storage`,
   defaulting to `"base64"`), the way a button names its action. Unknown kinds pass through
   the reader rather than being replaced: a form that says `"s3"` on a renderer with no such
   storage stores nothing and says so in the console, because storing through some other kind
   would put the file somewhere the form did not say.

3. **Storing is a seam on the renderer, not on the component type.** `FileStorage` in
   `render/core/file-storage.ts` is `{ kind, store(file, context) → Promise<FileAttachment> }`.
   The renderer element (`<datum-form-renderer fileStorage>`, forwarded by
   `<datum-form-host>`) resolves the kind the component names and stores what the storage
   returns. Where bytes go is a host concern — credentials, endpoints, retries — and none of
   it belongs in a component definition that a form schema references by type. The engine
   registers `base64` by default; `createFileStorageResolver([...])` adds a host's kinds
   beside it.

4. **Everything else reads the envelope, never the bytes.** The field-constraints stage
   checks `maxFileSizeMb` (authored in megabytes, read in bytes) and `accept` (the attribute's
   own syntax: `.pdf`, `image/*`, `application/zip`) against `size`, `name` and `type`, so the
   same limits hold whether the bytes are embedded or in a bucket; the WASM kernel mirrors
   the reading. An answer that is not an envelope, too many attachments and a declared size no file
   has are refused with their own codes (`docs/reference/sandbox-abi.md`, "Attachments").
   `required` needs no special case: an attachment object is a value, an empty list is not.

5. **The list, not the control, is the field's state.** A file input cannot be given a value, so
   it is no record of what the form holds: Datum's adapter clears it after each pick (so picking
   the same file again is heard), and the attachments the form holds are listed under it with a
   Remove each (`FileFieldState.files`, `render/live/files.ts`). The markup never carries a
   `data:` URL: a download builds a blob from state on click, so the bytes are never written
   into the shadow root. An embedded attachment's name is a button that downloads it; a stored
   one's is plain text.

## Consequences

- Embedding is bounded by the author's size limit and nothing else. A large file makes a
  large value, which every consumer of the values sees — the runtime-data panel, a draft in
  `localStorage`, the WASM sandbox's serialized context. That is the trade the base64 kind
  makes deliberately, and the reason the seam exists.
- Adding a storage kind is: one `FileStorage`, registered on the renderer, plus one entry in
  the builder's storage picker (`FILE_STORAGE_OPTIONS` is the engine's list; a host's picker
  can extend it). No component, rule, constraint or renderer changes.
