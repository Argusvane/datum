import type { Expectation } from "../predicates.js";
import type { Json } from "../observation.js";

export type VectorClass = "control" | "abi" | "isolation" | "resource" | "options" | "files" | "context" | "canonical" | "receiver" | "secrecy" | "parity" | "definition" | "builder" | "output" | "journey" | "test";
export type Attacker = "filler" | "author" | "plugin-author" | "source-operator" | "network" | "host-config";
/** The severity scale. */
export type Severity = "S1" | "S2" | "S3" | "S4";
/**
 * enforced: a FAIL fails the run. advisory: a FAIL reports WARN. pending: a failing vector
 * reports XFAIL, a passing one XPASS ("promote me"); neither fails the run.
 */
export type Gate =
  | { status: "enforced" }
  | { status: "advisory" }
  | { status: "pending"; blockedBy: string };

/**
 * A JSON-describable generator, so a vector stays data (and a 10,000-key object or a 1 MB string
 * is built when the run needs it, never held in the catalogue). `{ "$gen": ... }` can stand
 * anywhere in a JSON tree; {@link resolveGenerators} replaces it.
 */
export type Gen =
  | { $gen: "unknownKeys"; n: number; prefix?: string }
  | { $gen: "rows"; n: number; row: Json }
  | { $gen: "text"; length: number; char?: string }
  /**
   * Text of `head` then `text` written `n` times, each `$n` in `text` replaced by the 0-based index of the copy
   * (a test file of 201 uniquely named scenarios, a scenario of 1,001 statements). A string, so it can stand where a request holds text.
   */
  | { $gen: "repeat"; n: number; text: string; head?: string }
  /** Object keys of every part, later parts winning: `{ "$gen": "merge", "of": [ {...}, { "$gen": "unknownKeys", "n": 10 } ] }`. */
  | { $gen: "merge"; of: (Json | Gen)[] };

export interface PluginSource {
  id: string;
  version: string;
  source: string;
}

/** How a vector's form differs from the fixture form. `base` is the section-5 definition's root. */
export type DefinitionBuilder = (base: Record<string, unknown>) => Record<string, unknown>;

export interface Fixture {
  /** `base`: the section-5 fixture form (the only value the endpoint runner accepts). `base+patch`: `patch` applied to a copy of it. A function builds the root outright. */
  definition: "base" | "base+patch" | DefinitionBuilder;
  patch?: DefinitionBuilder;
  plugins?: PluginSource[];
  policy?: { formulaErrors?: string; riskyPatterns?: string; unknownFields?: string };
  hostOptions?: { maxEvalMs?: number; memoryLimitBytes?: number; recycleHeapBytes?: number; maxRequestLength?: number };
  /**
   * The host the sandbox runs on in program mode. `worker`: the Node worker host (its own thread and a
   * second clock, so a native call the interrupt handler cannot stop is killed); the row is SKIPped with
   * the reason where that host is not available (the bundled command line). Left out: the synchronous adapter.
   */
  host?: "sync" | "worker";
  /** The option snapshot (`externalData`), program only. */
  snapshot?: Record<string, unknown>;
  /**
   * The whole definition as JSON TEXT (DEF and BLD vectors), so a `__proto__` key stays an own key
   * and a duplicate key survives. Text, or a function of the base definition. Left out: the base
   * definition. The `$definition` token of an inspect `requestText` and the builder's save body
   * both read it.
   */
  definitionText?: string | ((base: Record<string, unknown>) => string);
}

export type VectorInput =
  | {
      kind: "values";
      values: Json | Gen;
      locale?: unknown;
      /**
       * The definition's `translations` map, as the run context carries it: a run
       * context has no definition, and the kernel words a localized message from this map alone.
       */
      translations?: Json;
      /**
       * The host's translation catalog, as the run context carries it (shape: locale, kind, owner, property, STRING leaves). It is read before
       * the `translations` map under the same locale tag. Left out when the host has none.
       */
      catalog?: Json;
      /**
       * The definition's `kinds` map (type -> engine base type), as the run context carries it:
       * the kernel reads a plugin's or a binding's type as its base. Program only.
       */
      kinds?: Json;
      today?: unknown;
      /**
       * The values the form's `host.` paths read, as the server supplies them (`context.hostContext`,
       * sandbox ABI 4.1.0). Program and parity only: a live host derives its own from the request.
       */
      hostContext?: unknown;
      document?: Json;
      logLevel?: string;
      /** Host-side `externalData` (program only; the ABI bounds it before the sandbox sees it). */
      externalData?: Json | Gen;
      /** Edits the form root for this one run (a series step that changes the definition). Program only. */
      formPatch?: DefinitionBuilder;
      /** The journey the answers were given through (`context.journey`). Program only. */
      journey?: Json;
    }
  /** Raw bytes; the program runner hands the text straight to `__datum_run`. */
  | { kind: "raw"; route: "validate" | "submit"; body: string | Gen; contentType?: string; method?: string }
  /**
   * An `__datum_inspect` request (program only). `requestText` is the request as JSON text with the
   * tokens `$definition` (the fixture's definition text), `$detected` (the program's ABI) and
   * `$baseTypes` (a JSON list of the base form's component types); it replaces `request`.
   */
  | { kind: "inspect"; request: unknown; requestText?: string }
  /** Program only: detect the program's ABI (see `detect-abi.ts`); the observation is an answer holding the detection. */
  | { kind: "detect-abi" }
  /** Several runs on ONE sandbox (state-leak and replay vectors). */
  | {
      kind: "series";
      steps: VectorInput[];
      /**
       * Judge the steps against each other instead of the last one: the observation becomes an
       * answer `{ steps: [{ bytes, sha256 }] }` over the steps' answers (as the program wrote them).
       */
      compareSteps?: boolean;
    };

export interface Variant {
  id: string;
  /**
   * True for a row an endpoint cannot run: it carries its own `fixture`, or its input is not
   * something a live site should be sent (a 32 MiB body). The endpoint runner skips it; a
   * variant with a `fixture` must say so (the vector lint checks).
   */
  programOnly?: boolean;
  input?: VectorInput;
  fixture?: Partial<Fixture>;
  expect?: Expectation;
  /** This row's own gate when it differs from the vector's (a vector whose controls hold today and whose structure rows wait for a new kernel). */
  gate?: Gate;
}

export type Applic = false | { expect?: Expectation; heavy?: boolean; needsWrites?: boolean; profiles?: ("submissions" | "builder")[]; note?: string };

export interface Vector {
  /** `CTL-02`: stable forever, never reused. */
  id: string;
  title: string;
  class: VectorClass;
  severity: Severity;
  attacker: Attacker;
  provenance: { tests: { path: string; name?: string }[] };
  gate: Gate;
  fixture: Fixture;
  input: VectorInput;
  /** Sub-rows; the vector passes only if every variant does. */
  variants?: Variant[];
  expect: Expectation;
  /** Wall-clock bounds the run must END within (a hang is a FAIL). */
  limits: { programBudgetMultiple?: number; programMs?: number; endpointMs?: number; /** A slow-runner allowance: the evaluation budget (and so the bound) this vector uses. */ nodeBudgetMs?: number };
  applies: { program: Applic; endpoint: Applic; parity: Applic };
  /** Output vectors: the one-sentence predicate the run checks, shown by explain and as the result's expectation. */
  predicate?: string;
  /** True when the check says nothing about a wasmtime host (ISO-02): the report flags it. */
  hostSensitive?: boolean;
}
