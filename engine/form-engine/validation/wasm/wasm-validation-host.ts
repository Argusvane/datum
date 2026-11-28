import type { Journey } from "../../core/schema/journey.js";
import type { JourneyTrace } from "../../core/journey/journey-types.js";
import type {
  ValidationContext,
  ValidationLogEntry,
  ValidationLogThreshold,
  ValidationResult,
  WasmPluginContribution
} from "../../core/schema/contracts.js";
import type { ComponentNode } from "../../core/schema/types.js";
import type { FormTranslations, TranslationCatalog } from "../../core/localization/translations.js";
import type { FormulaErrorPolicy } from "../../core/expressions/expression.js";
import type { DefinitionInspectRequest, DefinitionInspectResponse } from "../../core/expressions/inspect.js";
import { kernelStableStringify, type KernelIndexRow, type KernelUnknownFieldsMode } from "./portable-kernel.js";
import type { KernelOptionSnapshot } from "./portable-options.js";

/** Per-run unknown-submitted-fields policy; see {@link KernelUnknownFieldsMode}. */
export type WasmUnknownFieldsMode = KernelUnknownFieldsMode;

/** What a run records to its log: a level, or `"off"`. The kernel's default is `"warn"`. */
export type WasmLogLevel = ValidationLogThreshold;

/** One entry of the run log an outcome carries: level, message, plain data. */
export type WasmLogEntry = ValidationLogEntry;

/** One row of an outcome's value index: `{ path, delta, value }`; see {@link WasmSubmissionOutcome.index}. */
export type WasmIndexRow = KernelIndexRow;

/**
 * Absolute sandbox policy: no ambient authority. `allowedExternalDataKeys` optionally
 * restricts which `WasmSubmissionContext.externalData` keys may cross the ABI boundary.
 */
export interface WasmSandboxPolicy {
  allowNetwork: false;
  allowFilesystem: false;
  allowProcess: false;
  allowEnvironment: false;
  allowedExternalDataKeys?: readonly string[];
}

/**
 * The submission context that crosses the ABI: the values plus the schema itself, so the
 * sandbox can sanitize and enforce schema-declared constraints on any host — including one
 * that cannot run engine TypeScript. `externalData` is the only
 * channel for data-source results: the host resolves them outside the sandbox and injects a
 * serializable snapshot; the sandbox itself never fetches. The browser's `requiredComponents`
 * stays out: the kernel works requiredness out for itself, from the same fold, so no
 * host can believe the sandbox honours a record it was handed — and since a spread of a
 * `ValidationContext` would still carry it, `JsonWasmAbi.serializeContext` drops it by name.
 * The browser's `inputStates` stay out alike: what a control knows beyond its value
 * is the browser's alone, and a server's verdict never turns on it. So do the browser's resolved
 * `dataGridRowBounds`: the kernel evaluates a grid's bound formulas itself.
 */
export interface WasmSubmissionContext extends Omit<ValidationContext, "requiredComponents" | "invalidComponents" | "inputStates" | "signal"> {
  /** The form schema root. */
  form: ComponentNode;
  /**
   * What the sandbox does with submitted keys the schema does not define, decided per run:
   * `"strip"` (default) silently removes them from the returned values, `"keep"` passes
   * them through, `"reject"` blocks the submission with an `unknown_field` error per key.
   * Crosses the ABI inside the serialized context, so any host sets it the same way.
   */
  unknownFields?: WasmUnknownFieldsMode;
  /**
   * What the run's log keeps: entries at this level and above, from the kernel's
   * own steps and from validators writing to `context.log`. Absent means `"warn"`, so a run
   * that behaves returns no log at all. Crosses the ABI inside the serialized context.
   */
  logLevel?: WasmLogLevel;
  /**
   * The journey the answers were given through. Set, the kernel works out the path
   * from the values — never from the client — and treats every component off it as hidden: not
   * required, not validated, its answer kept or dropped by the journey's `offPathValues`. A path
   * that ends at an exit page is refused (`journey.exit`). A page may hold nodes the presentation
   * owns: the kernel places the form fields they reference, fill or work out on that
   * page, and reads nothing else of them.
   */
  journey?: Journey;
  /**
   * A page of `journey` the host is checking: the outcome then carries
   * `pageComponentIds`, the form components in scope for that page by the kernel's own
   * placement, so a host that cannot run the engine keeps a page's check to the page without
   * porting the placement rules. The verdict is the whole submission's either way — scoping
   * the errors is the host's. Ignored without a usable journey.
   */
  page?: string;
  /**
   * The calendar day the rules read (`today()`, `age()`), as `YYYY-MM-DD`: the
   * day the host judges by. The browser tells its own at submit; a server may set its own, which
   * then wins. Absent, no rule reads a clock: one that does is left unevaluated, exactly as a
   * rule reading `host.` is (its field keeps its configured state, a calculation keeps its
   * submitted answer and is listed in `clientDerived`), and the outcome's `clockDependent`
   * names the components. A value that is not a real calendar date is warned about in the
   * log and treated as absent. With a journey any of whose route conditions reads the clock, an
   * absent day is refused: `journey.clockDependent` (stage `journey`, `parameters`
   * `{ journey, page }`), no values; a host that runs a journey passes the day.
   */
  today?: string;
  /**
   * The values the form's `host.` paths read (`host.region`, `host.role`), supplied by the
   * server from what it knows of the request (the signed-in person, the site), never taken from
   * the browser: a page's own `hostContext` is for display, and a client could send anything. A
   * plain JSON object; nested objects are read by dotted paths (`host.user.role`). Present, the
   * kernel evaluates every rule and calculation reading `host.` against it, as the browser does,
   * and a key it lacks reads as no answer (`null` in `=`), never as undecided. Absent, such a
   * rule is left unevaluated (its field keeps its configured state, a calculation keeps
   * its submitted answer and is listed in `clientDerived`, a host-shown field is not required:
   * `visibilitySkipped`). A value that is not an object is warned about in the log and treated
   * as absent; one JSON cannot carry (a function, `NaN`, a `Date`) is refused before the run, as
   * `externalData` is. A journey route's `when` never reads `host.` on either side, and a field a
   * journey places on no page whose visibility reads `host.` keeps the lenient fold even with a
   * context (both sides decide that from the definition alone).
   */
  hostContext?: Record<string, unknown>;
  /**
   * What the run does with a rule whose formula does not parse, or a scope a rule may not take:
   * `"fail"` (the default, so a formula that does not parse never passes silently) refuses the submission with one
   * `formula.invalid` error per problem and judges nothing else; `"warn"`, the explicit
   * opt-in for preview and staging, drops the rule and logs it (a server-run rule calling a
   * function the server lacks still refuses). Absent or any other value, the form's own
   * `root.configuration.formulaErrors`, else `"fail"`.
   */
  formulaErrors?: FormulaErrorPolicy;
  /**
   * What the run does with a regular expression of a catastrophic shape (a repeat of a repeat such
   * as `(x+)+`, a repeated back-reference): `"refuse"` (the default) treats a literal `matches`
   * pattern as a formula problem (`pattern.risky`, judged by `formulaErrors`) and a field's
   * `configuration.pattern` as a definition problem like one that does not compile (skipped and
   * logged, or failed closed under `formulaErrors: "fail"`); `"allow"` runs them. Absent, `"refuse"`.
   */
  riskyPatterns?: "refuse" | "allow";
  /**
   * Ask for the fold's results in the outcome: `withheld`, `effectiveState`, `submittable` (a
   * blocked run) and `trace`, so the host runs no second partition or fold. Absent or false, the
   * outcome carries none of them.
   */
  reportFold?: boolean;
  /**
   * The delivered document exactly as the host received it: an envelope
   * (`{ versionContext, submission, signatures? }`) or a signed wrapper
   * (`{ format, payload, signatures }`), parsed but not rewritten. Set, the outcome carries its
   * `canonical` text and `digest`, whatever the verdict, worked out before anything else in the
   * run. The verdict never reads it, and validators never see it (it is not in their context):
   * the answers judged are `values`, which the host takes from the same document. Absent,
   * neither comes back.
   */
  document?: unknown;
  /**
   * The options the host resolved from its data sources, by source id:
   * `Record<sourceId, { value, label? }[]>`, the shape the PDF ABI's `optionSnapshot` takes (one
   * is assignable to the other). The kernel holds every choice answer it stores to its options:
   * a choice whose `data.sourceId` names a source in the snapshot to that source's values, one
   * with inline options to those, and every choice answer to its shape (a string for a select or
   * radio, an object of booleans for checkboxes). A source the snapshot lacks (no snapshot, one
   * that is not a record, one without the id, or an entry that is not a list) fails closed: an
   * answer that picks a value of such a choice is refused with `option.sourceUnavailable`
   * (`parameters.sourceId` names the source); an empty list allows nothing. A refusal is an `option.notAllowed` error
   * (`parameters.keys` names the submitted keys) or that one, on a hidden component too.
   */
  optionSnapshot?: KernelOptionSnapshot;
  /**
   * The definition's `translations`: the form's texts in its other languages, by
   * locale, kind, owner id and property. A definition's texts are strings in its default
   * language, so a host that wants the sandbox's messages in `locale` passes the map the
   * definition carries; the kernel reads it only to word a failed pattern's own message
   * (`parameters.message`, from `components › <id> › patternMessage`). Read tolerantly: a value
   * that is not a map, or an entry under an unsafe key, is no translation. Absent, messages stay
   * in the default language (or in the host's `catalog`, when it passes one).
   */
  translations?: FormTranslations;
  /**
   * The definition's `kinds` map (`FormDefinition.kinds`): each plugin or design-system type the
   * form uses → the engine type it is read as. The kernel checks such a component's answer as its
   * base (a type mapped to `date` gets the date checks), with no plugin or binding code in the
   * program. A host passes the map the definition carries. Read tolerantly: a value that is not
   * a record, or an entry whose base is not an engine type, maps nothing.
   */
  kinds?: Readonly<Record<string, string>> | undefined;
  /**
   * The host's translation catalog in the shape of the definition's translations map (locale, kind, owner, property; `form`
   * has no owner level), string leaves. The kernel words a
   * failed pattern's message from it as the browser does: the catalog under the exact locale tag
   * wins over the map under the same tag, then the catalog's and the map's primary subtag. Read
   * tolerantly: a catalog that is not a record, a blank or non-string leaf, or an unsafe segment
   * is no text, the next rung. Absent, the map alone words the message; hosts pass it only when
   * it holds something.
   */
  catalog?: TranslationCatalog | undefined;
}

/**
 * The ABI error contract: code + parameters + field mapping (`componentId`/`path`), never
 * prose and never presentation. Rendering — placement, localization via the host's
 * `ValidationMessageCatalog`, focus — is entirely the renderer's job.
 */
export type WasmValidationError = ValidationResult["errors"][number];

/**
 * What a run hands back: the error contract, plus — only when nothing blocked — the
 * sanitized values, plus the run log when it kept anything. The sanitized values are the
 * submission: any key the schema does not define has been silently stripped, so they may
 * differ from what the form sent. The log is the host's to forward: the sandbox has no
 * console, so this is the one way out for what the kernel and the rules said.
 */
export interface WasmSubmissionOutcome {
  errors: WasmValidationError[];
  values?: Record<string, unknown>;
  logs?: WasmLogEntry[];
  /**
   * The value paths of the judged answers that were worked out in the browser and kept as sent,
   * in document order: the target of a presentation's worked-out
   * value, a calculation the kernel could not reproduce (it reads `host.`, or an answer it was
   * not sent), and any calculation that reads one of those. Each was held to the form's rules
   * like any answer; none was recomputed from inputs the server holds. Only answers the
   * verdict judged are listed — never one the fold withheld. Present only when there is one —
   * for forms without a journey too — and whether or not the run blocked.
   */
  clientDerived?: string[];
  /**
   * The form components in scope for the page the context named (`context.page`),
   * in document order: what the page lists, with subtrees, and what its own nodes reference,
   * fill or work out. A page's check keeps the errors on these, and those on no component bar
   * `journey.exit`. Present whenever the context names a page and carries a usable journey.
   */
  pageComponentIds?: string[];
  /**
   * The components whose rules or calculation read the clock (`today()`, `age()`) on the
   * server's side, in document order: what the verdict turned on the day for, when
   * a day was given, or what was left unevaluated for lack of one. Present only when there is
   * one, and whether or not the run blocked. With a journey it also carries page ids: every page
   * whose `when` or any route's `when` reads the clock.
   */
  clockDependent?: string[];
  /**
   * The components whose `server` or `server-secret` rules this run applied, in
   * document order: a visibility, an enabled, a read-only or a required rule, or a calculation,
   * the browser never ran, so a host can explain a verdict the browser never marked ("the
   * server requires X"). Present only when there is one, and whether or not the run blocked.
   */
  serverRules?: string[];
  /**
   * The components whose own `visibleWhen` the server could not replay,
   * in document order: it reads `host.` and the context carried no `hostContext`, is scoped to the browser, or reads the clock when the
   * context gave no day. Such a component, and everything under it, is treated as hidden for
   * requiredness: the server never demands an answer the browser may have hidden. Present only
   * when there is one, and whether or not the run blocked.
   */
  visibilitySkipped?: string[];
  /**
   * The delivered keys the form defines that the judged values leave out, hidden answers the
   * fold withheld, in the delivered order: what a host would otherwise work out with a second
   * partition. Present, possibly empty, when the context set `reportFold` and the fold ran;
   * absent without the flag and from a refused definition. Its presence also says
   * `effectiveState`, `submittable` and `trace` are authoritative (their absence is "none").
   */
  withheld?: string[];
  /**
   * The components whose errors the fold's hidden policy can drop, by id: the fold's effective state (`visible`, `disabled`, `readonly`, `runValidation`, `requiredApplies`, `submitValue`, `clearValue`) for each component not
   * validated or where requiredness does not apply. A component not listed passes every error,
   * so a host filters a validation hook's errors with it as `kernelErrorPassesFold` does with
   * the full fold. Present only when there is one and the fold ran.
   */
  effectiveState?: Record<string, { visible: boolean; disabled: boolean; readonly: boolean; runValidation: boolean; requiredApplies: boolean; submitValue: boolean; clearValue: boolean }>;
  /** The judged values of a run that blocked and so carries no `values`. */
  submittable?: Record<string, unknown>;
  /** The journey's path through the answers; present when the context carried a usable journey and the fold ran. */
  trace?: JourneyTrace;
  /**
   * The flat value index of `values`, built from the same sanitized object, so an
   * answer the run stripped or withheld is not indexed: one row per answer, in the order the
   * serialized `values` lists its keys. `path` is the key with every entry index (`[0]`) taken
   * out, `delta` those indexes joined with `.` (empty when there are none), `value` the answer as
   * given. A list whose items are all scalars or `null` gives one row per item, its position
   * appended to `delta` (an empty list gives none); any other object or list is one row, as is.
   * Present whenever `values` is.
   */
  index?: WasmIndexRow[];
  /**
   * The context's `document` as sent, written canonically: every object key sorted
   * by UTF-16 code unit, arrays in order, no whitespace, `JSON.stringify`'s strings and numbers.
   * It describes the document the host passed, not the values this run returns. Present only
   * when the context carried a `document`, whether or not the run blocked.
   */
  canonical?: string;
  /**
   * SHA-256 of the UTF-8 bytes of `canonical`, as 64 lowercase hex digits: the
   * record's identity, the same as `submissionDigest` in `@argusvane/datum-submissions` and the browser's
   * Data tab compute. Describes `document` as sent; present exactly when `canonical` is.
   */
  digest?: string;
}

export interface WasmValidationRequest {
  context: WasmSubmissionContext;
  policy: WasmSandboxPolicy;
}

/** A deterministic validator as a host function (in-process / parity form). */
export interface WasmValidator {
  id: string;
  version: string;
  validate(context: ValidationContext): ValidationResult;
}

/**
 * A sandbox plugin in function-backed form, for the in-process reference adapter and
 * parity testing. The portable twin is {@link WasmPluginSource}.
 */
export interface WasmPlugin {
  id: string;
  version: string;
  validators: WasmValidator[];
  /**
   * Formula functions the plugin adds (formulas): each takes the call's arguments as one
   * array and returns the value, or `undefined` for input it does not understand. A name
   * that is a built-in or already registered is refused at instantiate. The parser knows
   * them by name alone (any argument count); `toSourcePlugin` carries them into the sandbox.
   */
  functions?: Record<string, (args: unknown[]) => unknown>;
}

/**
 * A sandbox plugin as portable code: an ES2020 program whose completion value is a module
 * object `{ validators?: Array<(context) => { errors }> }`. Validators must be closure-free
 * and deterministic (no `Math.random`, no `Date`, no I/O — the sandbox disables and lacks
 * them). Unknown module keys are ignored, reserving future contribution kinds (logic,
 * actions, data-source shims) without an ABI break. This is the form that runs on every
 * host, which is why plugins shipping to the sandbox author `source`, not functions.
 * Structurally the same shape a `FormPlugin.wasmPlugin` contributes.
 */
export type WasmPluginSource = WasmPluginContribution;

export type WasmPluginModule = WasmPlugin | WasmPluginSource;

export function isSourcePlugin(module: WasmPluginModule): module is WasmPluginSource {
  return typeof (module as WasmPluginSource).source === "string";
}

// --- ABI -------------------------------------------

export const WASM_ABI_VERSION = "1.0.0";

/**
 * The serialization contract across the host boundary, versioned independently of the
 * engine so client/server drift is detectable: the context carries the schema, the result
 * is a {@link WasmSubmissionOutcome}, and canonical key order is code-unit comparison
 * (never locale collation, so QuickJS and V8 serialize identical bytes). Every optional
 * context key and outcome key is part of the sandbox ABI, and a
 * host pins the program whose version is {@link WASM_ABI_VERSION}.
 */
export interface WasmAbi {
  version: string;
  serializeContext(context: WasmSubmissionContext, policy: WasmSandboxPolicy): string;
  deserializeContext(payload: string): WasmSubmissionContext;
  serializeOutcome(outcome: WasmSubmissionOutcome): string;
  deserializeOutcome(payload: string): WasmSubmissionOutcome;
}

/** How deep an `externalData` value may nest, and how many values it may hold in all. */
const EXTERNAL_DATA_MAX_DEPTH = 64;
const EXTERNAL_DATA_MAX_NODES = 1_000_000;

/**
 * Refuses `externalData` that cannot cross the boundary as it is. Only what JSON carries intact
 * is allowed, at every depth: `null`, booleans, finite numbers, strings, arrays and plain
 * objects (prototype `Object.prototype` or none); an `undefined` entry is dropped by the
 * serializer, as JSON drops it, and is allowed. A function, symbol or bigint, a `Map`, `Set`,
 * `Date` or class instance, a `NaN` or infinity would be silently reshaped (a `Map` into `{}`,
 * so a plugin reads an empty snapshot as present), so each is refused with the path to it. The
 * walk is bounded in depth and in size, so a cyclic or enormous value is refused rather than
 * walked for ever: an honest snapshot (option rows, rates) is nowhere near either bound.
 */
function assertSerializableExternalData(
  externalData: Record<string, unknown> | undefined,
  allowedKeys: readonly string[] | undefined,
  label = "external data"
): void {
  if (!externalData) {
    return;
  }
  let nodes = 0;
  const refuse = (path: string, what: string): never => {
    throw new Error(`WASM ${label} at "${path}" is not serializable: ${what}`);
  };
  const walk = (value: unknown, path: string, depth: number): void => {
    nodes += 1;
    if (nodes > EXTERNAL_DATA_MAX_NODES) {
      refuse(path, `more than ${EXTERNAL_DATA_MAX_NODES} values in all`);
    }
    if (depth > EXTERNAL_DATA_MAX_DEPTH) {
      refuse(path, `nested deeper than ${EXTERNAL_DATA_MAX_DEPTH} levels (a cycle, or a value no form reads)`);
    }
    if (value === null || value === undefined || typeof value === "boolean" || typeof value === "string") {
      return;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        refuse(path, "a number JSON cannot carry (NaN or an infinity)");
      }
      return;
    }
    if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
      refuse(path, `a ${typeof value}`);
    }
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        walk(value[index], `${path}[${index}]`, depth + 1);
      }
      return;
    }
    if (typeof value === "object") {
      const prototype = Object.getPrototypeOf(value) as unknown;
      if (prototype !== Object.prototype && prototype !== null) {
        const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
        refuse(path, `an object that is not a plain object (${typeof name === "string" && name !== "" ? name : "unknown prototype"})`);
      }
      for (const key of Object.keys(value as Record<string, unknown>)) {
        walk((value as Record<string, unknown>)[key], `${path}.${key}`, depth + 1);
      }
      return;
    }
    refuse(path, `a ${typeof value}`);
  };
  for (const [key, value] of Object.entries(externalData)) {
    if (allowedKeys && !allowedKeys.includes(key)) {
      throw new Error(`WASM external data key not allowed: ${key}`);
    }
    if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
      throw new Error(`WASM ${label} key "${key}" is not serializable`);
    }
    walk(value, key, 1);
  }
}

/** Byte-stable JSON serialization: the kernel's canonical form, shared by every host. */
export const stableStringify = kernelStableStringify;

/** JSON ABI with code-unit key ordering for byte-stable payloads. */
export class JsonWasmAbi implements WasmAbi {
  public readonly version = WASM_ABI_VERSION;

  public serializeContext(context: WasmSubmissionContext, policy: WasmSandboxPolicy): string {
    assertSerializableExternalData(context.externalData, policy.allowedExternalDataKeys);
    // The server's host context crosses as JSON too, under the same bounds: what JSON would
    // reshape (a function dropped, `NaN` as `null`) is refused rather than read as something else.
    assertSerializableExternalData(context.hostContext, undefined, "host context");
    // The browser's `requiredComponents`, `invalidComponents` and
    // `inputStates` are not part of the ABI and the kernel ignores them. A caller
    // that spreads a `ValidationContext` into this one still carries them — TypeScript checks no
    // excess property on a spread — so they are dropped by name here, and every host serializes
    // the same bytes.
    // The browser's resolved `dataGridRowBounds` stay out the same way: the kernel
    // resolves a grid's formula bounds from the definition itself. A browser run's abort
    // `signal` is no data at all.
    const {
      requiredComponents: _requiredComponents,
      invalidComponents: _invalidComponents,
      inputStates: _inputStates,
      dataGridRowBounds: _dataGridRowBounds,
      signal: _signal,
      ...crossing
    } = context as WasmSubmissionContext & {
      requiredComponents?: unknown;
      invalidComponents?: unknown;
      inputStates?: unknown;
      dataGridRowBounds?: unknown;
      signal?: unknown;
    };
    return stableStringify(crossing);
  }

  public deserializeContext(payload: string): WasmSubmissionContext {
    return JSON.parse(payload) as WasmSubmissionContext;
  }

  public serializeOutcome(outcome: WasmSubmissionOutcome): string {
    return stableStringify(outcome);
  }

  public deserializeOutcome(payload: string): WasmSubmissionOutcome {
    return JSON.parse(payload) as WasmSubmissionOutcome;
  }
}

// --- Host adapter ----------------------------------------------------------------

export interface WasmValidatorInstance {
  abiVersion: string;
  run(serializedContext: string): string | Promise<string>;
  /**
   * The introspection entry point: a serialized {@link DefinitionInspectRequest} in, the
   * canonical JSON of a {@link DefinitionInspectResponse} out. Optional: an instance without one
   * cannot answer {@link WasmValidationHost.inspect}, which says so.
   */
  inspect?(serializedRequest: string): string | Promise<string>;
  /** Releases sandbox resources. Optional; in-process instances hold none. */
  dispose?(): void;
}

/**
 * What a host asks of a definition through {@link WasmValidationHost.inspect}: the request
 * without its `abi`, which the host fills in from its own ABI unless the caller names one.
 */
export type WasmInspectRequest = Omit<DefinitionInspectRequest, "abi"> & { abi?: string };

/**
 * Instantiates the sandbox behind the ABI boundary: the portable kernel (always) plus the
 * plugin modules the host wires in at startup. `InProcessWasmHostAdapter`
 * (`in-process-host.ts`) is the reference implementation; `QuickJsWasmHostAdapter`
 * (`@argusvane/datum-quickjs-wasm-host`) implements the same interface with real QuickJS/WASM module
 * instantiation, which is asynchronous — hence the promise-tolerant return.
 */
export interface WasmHostAdapter {
  id: string;
  abiVersion: string;
  instantiate(
    plugins: readonly WasmPluginModule[],
    abi: WasmAbi
  ): WasmValidatorInstance | Promise<WasmValidatorInstance>;
}

/**
 * How a host is wired: the adapter that instantiates the sandbox, or a sandbox already
 * instantiated. There is no default adapter. The reference one runs the whole portable kernel
 * in this process, and a default would put the kernel in every bundle that constructs a host —
 * `<datum-form>`'s among them, which only ever defers to the QuickJS sandbox. A host that wants
 * the reference path asks for it (`createInProcessWasmValidationHost`, `in-process-host.ts`).
 */
export type WasmValidationHostOptions =
  | { adapter: WasmHostAdapter; abi?: WasmAbi; instance?: WasmValidatorInstance }
  | {
      /**
       * A pre-instantiated sandbox, skipping `adapter.instantiate` in the constructor. Set by
       * {@link WasmValidationHost.create} after awaiting an async adapter, and by a host whose
       * runs defer to a sandbox it resolves later. Its `abiVersion` must be this host's ABI
       * version, exactly as an adapter's must; the constructor throws otherwise.
       */
      instance: WasmValidatorInstance;
      adapter?: WasmHostAdapter;
      abi?: WasmAbi;
    };

/** A single validator or a list of plugin modules, normalized to the plugin-module list the
 * adapter contract takes. The single-validator form keeps existing call sites working. */
export type WasmHostInput = WasmValidator | readonly WasmPluginModule[];

function normalizePlugins(input: WasmHostInput): readonly WasmPluginModule[] {
  if (Array.isArray(input)) {
    return input;
  }
  const validator = input as WasmValidator;
  return [{ id: validator.id, version: validator.version, validators: [validator] }];
}

function assertAbiMatches(adapter: WasmHostAdapter, abi: WasmAbi): void {
  if (adapter.abiVersion !== abi.version) {
    throw new Error(`WASM ABI version mismatch: adapter ${adapter.abiVersion} != abi ${abi.version}`);
  }
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

export class WasmValidationHost {
  // Default policy is intentionally absolute: no ambient authority.
  public static readonly STRICT_POLICY: WasmSandboxPolicy = {
    allowNetwork: false,
    allowFilesystem: false,
    allowProcess: false,
    allowEnvironment: false
  };

  private readonly abi: WasmAbi;
  private readonly instance: WasmValidatorInstance;

  constructor(input: WasmHostInput, options: WasmValidationHostOptions) {
    this.abi = options.abi ?? new JsonWasmAbi();
    // The instance first: a host handed one needs no adapter, and never instantiates one. Its
    // ABI is compared all the same: a program of another ABI reads the context differently, so
    // running its verdicts could be a silent loosening.
    if (options.instance) {
      if (options.instance.abiVersion !== this.abi.version) {
        throw new Error(`WASM ABI version mismatch: instance ${options.instance.abiVersion} != abi ${this.abi.version}`);
      }
      this.instance = options.instance;
      return;
    }
    const adapter = options.adapter;
    if (adapter === undefined) {
      throw new Error(
        "WasmValidationHost needs an adapter (or an instance): there is no default. Use " +
          "createInProcessWasmValidationHost() for the in-process reference kernel."
      );
    }
    assertAbiMatches(adapter, this.abi);
    const instance = adapter.instantiate(normalizePlugins(input), this.abi);
    if (isThenable(instance)) {
      throw new Error(
        `Adapter "${adapter.id}" instantiates asynchronously; use WasmValidationHost.create().`
      );
    }
    this.instance = instance;
  }

  /**
   * Async factory for adapters whose instantiation is asynchronous (real WASM module
   * loading). The startup wiring point: core kernel + plugin modules compose here, once;
   * runs are per-submission.
   */
  public static async create(
    input: WasmHostInput,
    options: WasmValidationHostOptions
  ): Promise<WasmValidationHost> {
    const abi = options.abi ?? new JsonWasmAbi();
    if (options.instance) {
      return new WasmValidationHost(input, { ...options, abi, instance: options.instance });
    }
    const adapter = options.adapter;
    if (adapter === undefined) {
      throw new Error(
        "WasmValidationHost.create needs an adapter (or an instance): there is no default. Use " +
          "createInProcessWasmValidationHost() for the in-process reference kernel."
      );
    }
    assertAbiMatches(adapter, abi);
    const instance = await adapter.instantiate(normalizePlugins(input), abi);
    return new WasmValidationHost(input, { ...options, abi, adapter, instance });
  }

  public async run(request: WasmValidationRequest): Promise<WasmSubmissionOutcome> {
    this.assertStrictPolicy(request.policy);
    const serialized = this.abi.serializeContext(request.context, request.policy);
    const resultPayload = await this.instance.run(serialized);
    return this.abi.deserializeOutcome(resultPayload);
  }

  /**
   * Asks the sandbox one of the three introspection questions: `public` for the
   * definition to serve a browser, `check` for the compile's verdict, `inspect` for the rules
   * inventory. The request crosses the boundary as canonical JSON with this host's ABI version
   * filled in, and the answer comes back parsed; an `ok: false` answer is returned, not thrown.
   * Rejects when the instance has no entry point.
   */
  public async inspect(request: WasmInspectRequest): Promise<DefinitionInspectResponse> {
    if (typeof this.instance.inspect !== "function") {
      throw new Error(
        `The sandbox instance (ABI ${this.instance.abiVersion}) has no inspect entry point (__datum_inspect).`
      );
    }
    const serialized = stableStringify({ ...request, abi: request.abi ?? this.abi.version });
    const payload = await this.instance.inspect(serialized);
    return JSON.parse(payload) as DefinitionInspectResponse;
  }

  /** Releases the underlying sandbox instance (no-op for in-process). */
  public dispose(): void {
    this.instance.dispose?.();
  }

  private assertStrictPolicy(policy: WasmSandboxPolicy): void {
    if (
      policy.allowNetwork ||
      policy.allowFilesystem ||
      policy.allowProcess ||
      policy.allowEnvironment
    ) {
      throw new Error("WASM validation policy must remain fully restricted.");
    }
  }
}
