import { flatValid } from "../fixtures/inputs.js";
import type { Json } from "../observation.js";
import { accepted, all, RUNS, vector } from "./helpers.js";
import type { Vector } from "./schema.js";

/**
 * FIL: file answers. The fixture's `doc` field allows 0.001 MB (about 1 KB). A file envelope
 * carries a declared `size` and, for a base64 upload, the data itself: the size judged is the
 * decoded bytes, never the number the filler wrote.
 */
const everywhere = { program: RUNS, endpoint: RUNS, parity: RUNS } as const;

/** 4096 zero bytes, base64. */
const BYTES_4K = Buffer.alloc(4096).toString("base64");

const file = (envelope: Record<string, Json>): Record<string, Json> => flatValid({ doc: envelope });

export const FILE_VECTORS: Vector[] = [
  vector({
    id: "FIL-01",
    title: "A file whose declared size (10) understates its 4096 decoded bytes is refused as file.sizeMismatch; a small understatement is judged by maxFileSizeMb on the decoded size",
    class: "files",
    severity: "S3",
    attacker: "filler",
    provenance: { tests: [{ path: "packages/pdf-kernel/tests/attachment-size-lie.test.ts", name: "is refused as file.sizeMismatch when the bytes exceed the declared size by more than 1% + 1 KiB" }] },
    input: { kind: "values", values: file({ storage: "base64", name: "a.bin", type: "application/octet-stream", size: 10, data: BYTES_4K }) },
    expect: all(accepted(false), { op: "codes", exactly: ["file.sizeMismatch@doc"] }),
    variants: [
      {
        id: "understated-within-tolerance-is-judged-by-decoded-size",
        input: { kind: "values", values: file({ storage: "base64", name: "a.bin", type: "application/octet-stream", size: 4000, data: BYTES_4K }) },
        expect: all(accepted(false), { op: "codes", exactly: ["maxFileSize@doc"] })
      },
      {
        id: "honest-small-file-passes",
        input: { kind: "values", values: file({ storage: "base64", name: "a.bin", type: "application/octet-stream", size: 100, data: Buffer.alloc(100).toString("base64") }) },
        expect: all(accepted(true), { op: "codes", exactly: [] })
      }
    ],
    applies: everywhere
  }),
  vector({
    id: "FIL-02",
    title: "A file envelope naming a path-like storage and a double extension passes the kernel (documented: storing it is the host's duty)",
    class: "files",
    severity: "S4",
    attacker: "filler",
    provenance: { tests: [] },
    gate: { status: "advisory" },
    input: { kind: "values", values: file({ storage: "../x", name: "evil.php.pdf", type: "application/pdf", size: 1 }) },
    expect: accepted(true),
    applies: { program: RUNS, endpoint: false, parity: false }
  })
];
