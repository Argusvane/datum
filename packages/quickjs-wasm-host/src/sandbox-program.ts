import {
  FORMULA_FUNCTION_NAMES,
  formulaFunctionSignatures,
  kernelCreatePreparedCache,
  kernelStableStringify,
  runInspect,
  runKernel,
  PORTABLE_KERNEL_FUNCTIONS,
  type WasmPlugin,
  type WasmPluginSource,
  type WasmValidator
} from "@argusvane/datum-engine";

/** Definitions the sandbox remembers prepared between runs: the compile and its indexes, least recently used dropped. */
export const SANDBOX_PREPARED_DEFINITIONS = 16;
/**
 * The most key text, in characters, over those definitions. The cache lives inside the sandbox's
 * memory limit (32 MiB by default), and a prepared definition holds its compiled tree and indexes,
 * about seven times the size of its key in memory: this keeps sixteen forms of about 1,000 fields
 * (117 KB of JSON each) and no more. The QuickJS adapter lowers it to a sixteenth of a smaller
 * memory limit.
 */
export const SANDBOX_PREPARED_CHARS = 2_000_000;

/**
 * Builds the program evaluated once per sandbox instance: hardening, the portable kernel,
 * and the three entry points the host calls by well-known global name: `__datum_register`
 * once per plugin module at startup, `__datum_run` per submission, and `__datum_inspect`
 * per question about a definition (`public`, `check`, `inspect`).
 *
 * The kernel is composed from `Function.prototype.toString()` of the engine's
 * `PORTABLE_KERNEL_FUNCTIONS` — the exact code the in-process reference adapter runs, so
 * the two adapters cannot drift. Entry-point references use `fn.name` rather than literal
 * identifiers so the composition survives a minifier renaming the declarations (a minifier
 * renames the declaration and every call site consistently within the module).
 *
 * The sandbox serializes its own outcome (`kernelStableStringify`) so the returned string
 * is ABI-canonical no matter which host ran the sandbox — a Node process today, a JVM
 * embedding QuickJS tomorrow.
 *
 * The kernel calls functions from other engine modules (the expression
 * evaluator, the submittable fold, the journey path engine), all spliced in beside it. A
 * bundle leaves such a call a plain identifier; Vite's SSR transform — what vitest and
 * vite-node run the engine's sources through, and so what writes `datum-sandbox-program.js`
 * — rewrites it as a read on the import's namespace (`__vite_ssr_import_3__.journeyPath(…)`).
 * Each namespace named in the spliced source is therefore declared as one object holding
 * every spliced function by name, which resolves either spelling to the same declaration.
 *
 * The kernel cannot read the function table (plain data, never spliced), so the parser's
 * signatures are embedded here at generation time: the built-ins' as JSON (a variadic row's
 * `max` of `Infinity` travels as `null` and is mapped back once the program parses it), plus
 * one per plugin function `__datum_register` accepts (its name, any argument count). The
 * in-process adapter builds the same list, so a formula parses alike on every host.
 *
 * **Prepared definitions.** The page's host reuses one sandbox context across runs, so
 * the program keeps a cache of prepared definitions (made by the kernel's `kernelCreatePreparedCache`):
 * a definition judged again is not compiled and indexed again. The Node server hosts give every
 * call a sandbox of its own and size the cache to nothing (`__datum_cache_chars = 0`). It holds plain data the kernel
 * built inside this context, never a host handle, and is keyed by the exact text of the
 * definition, the formula-error word, the risky-pattern word and the parser's signatures, so a
 * hit is the object a miss would build and the outcome is byte-identical. It is no ABI surface:
 * nothing in a request or an outcome names it.
 *
 * **One closure.** The kernel's functions, the cache, the
 * registries and the language's intrinsics the kernel reads are locals of one function; the only
 * globals the program defines are `__datum_register`, `__datum_run` and `__datum_inspect`
 * (non-configurable, though QuickJS lets `Object.defineProperty` redefine a global whatever its
 * attributes: a host therefore captures the three once, right after the program loads and before
 * any plugin module, see `QuickJsProgramHost.captureEntries`, and calls those). A host may set
 * `globalThis.__datum_cache_chars` (a number) before evaluating the program to bound the cache's
 * key text; the program reads it once and removes it.
 */
export function buildSandboxProgram(options: SandboxProgramOptions = {}): string {
  const kernelDeclarations = PORTABLE_KERNEL_FUNCTIONS.map((fn) => fn.toString()).join("\n\n");
  const builtInNames = JSON.stringify([...FORMULA_FUNCTION_NAMES]);
  const builtInSignatures = JSON.stringify(JSON.stringify(formulaFunctionSignatures()));
  const runName = runKernel.name;
  const inspectName = runInspect.name;
  const stringifyName = kernelStableStringify.name;
  const createCacheName = kernelCreatePreparedCache.name;
  const namespaces = [...new Set(kernelDeclarations.match(IMPORT_NAMESPACE) ?? [])];
  const namespaceDeclarations =
    namespaces.length === 0
      ? []
      : [
          `var __datum_kernel_scope = { ${PORTABLE_KERNEL_FUNCTIONS.map((fn) => `${fn.name}: ${fn.name}`).join(", ")} };`,
          ...namespaces.map((name) => `var ${name} = __datum_kernel_scope;`),
          ""
        ];

  return [
    '"use strict";',
    // Hardening: the sandbox has no ambient authority by construction (no fetch, no
    // filesystem, no process); what QuickJS does provide and determinism forbids, disable.
    "(function () {",
    '  Math.random = function () { throw new Error("Math.random is disabled in the validation sandbox"); };',
    '  var ThrowingDate = function () { throw new Error("Date is disabled in the validation sandbox"); };',
    '  ThrowingDate.now = function () { throw new Error("Date.now is disabled in the validation sandbox"); };',
    "  globalThis.Date = ThrowingDate;",
    "})();",
    "",
    // Everything below lives in one closure: the kernel's
    // functions, the prepared-definition cache, the plugin registries and the language's
    // intrinsics the kernel reads are locals no plugin can name, so no change to the global
    // object (QuickJS lets `Object.defineProperty` redefine a global whatever its attributes)
    // can change what a run does. The three entry points are the only globals.
    "(function () {",
    `  var ${INTRINSIC_ALIASES.map((name) => `${name} = globalThis.${name}`).join(", ")};`,
    "",
    kernelDeclarations,
    "",
    ...namespaceDeclarations,
    // The one number a host may hand in before the program runs (the key text the cache keeps,
    // bounded by the host's memory limit); read once and removed.
    `  var __datum_cache_chars = typeof globalThis.__datum_cache_chars === "number" ? globalThis.__datum_cache_chars : ${SANDBOX_PREPARED_CHARS};`,
    "  delete globalThis.__datum_cache_chars;",
    "  var __datum_sealed = false;",
    "  var __datum_validators = [];",
    `  var __datum_prepared = ${createCacheName}(${SANDBOX_PREPARED_DEFINITIONS}, __datum_cache_chars);`,
    "  var __datum_functions = {};",
    `  var __datum_builtin_names = ${builtInNames};`,
    `  var __datum_signatures = JSON.parse(${builtInSignatures}).map(function (row) {`,
    "    return { name: row.name, min: row.min, max: row.max === null ? Infinity : row.max };",
    "  });",
    "",
    // Registration is over once a run or an inspect starts: the registries are frozen so a plugin
    // cannot empty or reorder another's validators/functions.
    "  function __datum_seal() {",
    "    if (!__datum_sealed) {",
    "      __datum_sealed = true;",
    "      Object.freeze(__datum_validators);",
    "      Object.freeze(__datum_functions);",
    "      Object.freeze(__datum_signatures);",
    "    }",
    "  }",
    "",
    // Called once per plugin module at startup with the module's completion value.
    "  var __datum_register = function (module) {",
    '    if (__datum_sealed) { throw new Error("wasm plugins are registered before the first run"); }',
    '    if (!module || typeof module !== "object") {',
    '      throw new Error("wasm plugin source must evaluate to a module object");',
    "    }",
    "    var functions = module.functions;",
    "    if (functions !== undefined) {",
    '      if (!functions || typeof functions !== "object" || Array.isArray(functions)) {',
    "        throw new Error(\"wasm plugin 'functions' must be an object of functions\");",
    "      }",
    "      var names = Object.keys(functions);",
    "      for (var f = 0; f < names.length; f += 1) {",
    '        if (typeof functions[names[f]] !== "function") {',
    "          throw new Error(\"wasm plugin 'functions' must be an object of functions\");",
    "        }",
    "        if (__datum_builtin_names.indexOf(names[f]) >= 0) {",
    '          throw new Error("wasm plugin function \\"" + names[f] + "\\" is a built-in formula function");',
    "        }",
    "        if (Object.prototype.hasOwnProperty.call(__datum_functions, names[f])) {",
    '          throw new Error("wasm plugin function \\"" + names[f] + "\\" is already registered");',
    "        }",
    "      }",
    "      for (var g = 0; g < names.length; g += 1) {",
    "        __datum_functions[names[g]] = functions[names[g]];",
    "        __datum_signatures.push({ name: names[g], min: 0, max: Infinity });",
    "      }",
    "    }",
    "    var validators = module.validators;",
    "    if (validators === undefined) { return 0; }",
    "    if (!Array.isArray(validators)) {",
    "      throw new Error(\"wasm plugin 'validators' must be an array of functions\");",
    "    }",
    "    for (var i = 0; i < validators.length; i += 1) {",
    '      if (typeof validators[i] !== "function") {',
    "        throw new Error(\"wasm plugin 'validators' must be an array of functions\");",
    "      }",
    "      __datum_validators.push(validators[i]);",
    "    }",
    "    return validators.length;",
    "  };",
    "",
    // The per-run entry point: string in, ABI-canonical string out.
    "  var __datum_run = function (serializedContext) {",
    "    __datum_seal();",
    `    return ${stringifyName}(${runName}(JSON.parse(serializedContext), __datum_validators, __datum_functions, __datum_signatures, __datum_prepared));`,
    "  };",
    "",
    // The introspection entry point: a { abi, op, definition, formulaErrors? } request
    // in, the canonical JSON of its answer out; the built-ins' names let `inspect` tell a plugin
    // function from a built-in. Never throws for a request of the wrong shape or ABI.
    "  var __datum_inspect = function (serializedRequest) {",
    "    __datum_seal();",
    // The plugins' functions and validators go to the op as to a run: the `test` op evaluates a form's
    // formulas and validators, so a plugin's must be there or a test would read them as unwired.
    `    return ${stringifyName}(${inspectName}(JSON.parse(serializedRequest), __datum_signatures, __datum_builtin_names, __datum_functions, __datum_validators));`,
    "  };",
    "",
    // The only globals, fixed (a host also holds its own reference to each from startup: see
    // QuickJsProgramHost.captureEntries).
    "  function __datum_publish(name, value) {",
    "    Object.defineProperty(globalThis, name, { value: value, writable: false, enumerable: false, configurable: false });",
    "  }",
    '  __datum_publish("__datum_register", __datum_register);',
    '  __datum_publish("__datum_run", __datum_run);',
    '  __datum_publish("__datum_inspect", __datum_inspect);',
    // Tests only: a read-only view of the cache, never a binding to it.
    ...(options.exposePrepared === true
      ? ['  Object.defineProperty(globalThis, "__datum_prepared", { get: function () { return __datum_prepared; }, enumerable: false, configurable: false });']
      : []),
    "})();",
    "",
    '"sandbox-ready";'
  ].join("\n");
}

/** The globals the program defines, which a host captures once at startup and calls through those handles. */
export const SANDBOX_ENTRY_POINTS: readonly string[] = ["__datum_register", "__datum_run", "__datum_inspect"];

export interface SandboxProgramOptions {
  /** Tests: also show the prepared-definition cache as a read-only global `__datum_prepared`. Never set by a host. */
  exposePrepared?: boolean;
}

/**
 * The language's own globals the kernel reads by bare name. The program binds each to a local
 * at its start, so a later redefinition of the global (QuickJS allows `defineProperty` on a
 * global whatever its attributes) is not seen by the kernel. A test compares this list with a
 * fresh context's globals.
 */
export const INTRINSIC_ALIASES: readonly string[] = [
  "Object", "Function", "Array", "String", "Number", "Boolean", "Symbol", "BigInt", "JSON", "Math", "Reflect", "Proxy", "RegExp", "Date",
  "Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError", "AggregateError", "InternalError",
  "Map", "Set", "WeakMap", "WeakSet", "WeakRef", "FinalizationRegistry", "Promise", "ArrayBuffer", "SharedArrayBuffer", "DataView", "Atomics",
  "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float16Array",
  "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array", "Iterator",
  "parseInt", "parseFloat", "isNaN", "isFinite", "decodeURI", "decodeURIComponent", "encodeURI", "encodeURIComponent", "escape", "unescape"
];

/**
 * The freeze: evaluated
 * once after the sandbox program and before any plugin module, so a plugin cannot patch the
 * language for the runs after it (the sandbox instance is reused across runs and forms). Every
 * object reachable from the global object's values (the intrinsics, their prototypes, and every
 * function among their properties and accessors, recursively: `Object.prototype.hasOwnProperty`
 * and its `call`, `%TypedArray%`, `Iterator`, `FinalizationRegistry`, `SharedArrayBuffer`,
 * `Float16Array` and the like where the engine has them) is frozen; every data property of the
 * global object becomes non-writable and non-configurable. The kernel does not depend on those
 * bindings (it is a closure of the program, with its own references to the intrinsics); they
 * keep plugin code from assigning over them.
 *
 * Freezing a prototype makes `this.name = "x"` and `o.toString = f` fail on instances that
 * inherit the property (the "override mistake"), which breaks ordinary plugin code such as
 * `class MyError extends Error { constructor(m) { super(m); this.name = "MyError"; } }`. As SES
 * does, `constructor`, `toString`, `valueOf`, `toLocaleString`, `toJSON`, and the `name` and
 * `message` strings of the error prototypes become accessors on the frozen prototypes: reading
 * gives the original value, assigning to an instance defines an own property on it, and
 * assigning to the prototype itself throws.
 *
 * The global object itself stays extensible, so a plugin can still define globals of its own. Every
 * object reached from a global is frozen, `__datum_` globals included: the program keeps its mutable
 * state in closure locals. A host that embeds the sandbox program elsewhere (a server host's own
 * runner) evaluates this same text at the same point.
 */
export const FREEZE_INTRINSICS_SNIPPET = [
  "(function () {",
  '  "use strict";',
  "  var root = globalThis;",
  "  var getNames = Object.getOwnPropertyNames;",
  "  var getSymbols = Object.getOwnPropertySymbols;",
  "  var getDescriptor = Object.getOwnPropertyDescriptor;",
  "  var getProto = Object.getPrototypeOf;",
  "  var define = Object.defineProperty;",
  "  var freeze = Object.freeze;",
  "  var seen = new Set();",
  "  var queue = [];",
  "  function visit(o) {",
  '    if (o === null || o === undefined || o === root || (typeof o !== "object" && typeof o !== "function") || seen.has(o)) { return; }',
  "    seen.add(o);",
  "    queue.push(o);",
  "  }",
  "  function visitDescriptor(d) {",
  "    if (d === undefined) { return; }",
  '    if ("value" in d) { visit(d.value); } else { visit(d.get); visit(d.set); }',
  "  }",
  "  var own = getNames(root);",
  "  for (var i = 0; i < own.length; i += 1) {",
  "    var d = getDescriptor(root, own[i]);",
  '    if (d !== undefined && "value" in d && (d.writable || d.configurable)) {',
  "      define(root, own[i], { value: d.value, writable: false, enumerable: d.enumerable, configurable: false });",
  "    }",
  "    visitDescriptor(d);",
  "  }",
  "  var iterators = [[][Symbol.iterator](), new Map().entries(), new Set().values(), ''[Symbol.iterator](), 'a'.matchAll(/a/g)];",
  // The iterator helpers' prototype and the one `Iterator.from` wraps with are reached only by an
  // operation, never through a property, so they are made here (when the language has them).
  "  var helped = [][Symbol.iterator]();",
  '  if (typeof helped.map === "function") { iterators.push(helped.map(function (x) { return x; })); }',
  '  if (typeof Iterator !== "undefined" && typeof Iterator.from === "function") { iterators.push(Iterator.from({ next: function () { return { done: true, value: undefined }; } })); }',
  "  for (var k = 0; k < iterators.length; k += 1) { visit(getProto(iterators[k])); }",
  "  visit(function () {});",
  "  visit(function* () {});",
  "  visit(async function () {});",
  "  visit(async function* () {});",
  "  for (var q = 0; q < queue.length; q += 1) {",
  "    var o = queue[q];",
  "    visit(getProto(o));",
  "    var keys = getNames(o).concat(getSymbols(o));",
  "    for (var j = 0; j < keys.length; j += 1) { visitDescriptor(getDescriptor(o, keys[j])); }",
  "  }",
  // The override-mistake repair, for prototypes only (a function's own name stays a plain property).
  '  var repaired = ["constructor", "toString", "valueOf", "toLocaleString", "toJSON", "name", "message"];',
  "  var added = [];",
  // Method shorthand, so the accessor functions have no `prototype` object of their own to leave unfrozen.
  "  function repair(proto, name, value) {",
  "    var accessor = {",
  "      get() { return value; },",
  "      set(next) {",
  '        if (this === proto) { throw new TypeError("Cannot assign to read only property \'" + name + "\' of a frozen built-in"); }',
  '        if (this === null || this === undefined || (typeof this !== "object" && typeof this !== "function")) { return; }',
  "        define(this, name, { value: next, writable: true, enumerable: true, configurable: true });",
  "      }",
  "    };",
  "    define(proto, name, { get: accessor.get, set: accessor.set, enumerable: false, configurable: false });",
  "    added.push(accessor.get, accessor.set);",
  "  }",
  "  var functionPrototype = getProto(function () {});",
  "  for (var r = 0; r < queue.length; r += 1) {",
  "    var proto = queue[r];",
  '    if (typeof proto === "function" && proto !== functionPrototype) { continue; }',
  "    for (var m = 0; m < repaired.length; m += 1) {",
  "      var pd = getDescriptor(proto, repaired[m]);",
  '      if (pd === undefined || !("value" in pd) || !pd.configurable) { continue; }',
  '      var plain = repaired[m] === "name" || repaired[m] === "message" ? typeof pd.value === "string" : repaired[m] === "constructor" || typeof pd.value === "function";',
  "      if (plain) { repair(proto, repaired[m], pd.value); }",
  "    }",
  "  }",
  "  for (var f = 0; f < queue.length; f += 1) { freeze(queue[f]); }",
  "  for (var a = 0; a < added.length; a += 1) { freeze(added[a]); }",
  "})();"
].join("\n");

/**
 * An import namespace a Vite SSR transform names (`__vite_ssr_import_0__`; older vite-node
 * spelled it `__vi_import_0__` or `__vi_ssr_import_0__`).
 */
const IMPORT_NAMESPACE = /\b__vi(?:te)?_(?:ssr_)?import_\d+__\b/g;

const NATIVE_CODE = /\[native code\]/;
const EXPRESSION_START = /^\s*(?:async\s+)?(?:function\b|\()/;
// A single-parameter arrow without parentheses: `ctx => ...` (parenthesized arrows match
// EXPRESSION_START already).
const BARE_ARROW = /^\s*(?:async\s+)?[A-Za-z_$][\w$]*\s*=>/;

/**
 * A function's source as a standalone expression. Handles the three shapes
 * `Function.prototype.toString()` produces: function declarations/expressions, arrows, and
 * object-method shorthand (`validate(ctx) { ... }`), which is only valid inside an object
 * literal and is re-wrapped accordingly.
 */
function functionExpression(fn: (...args: never[]) => unknown): string {
  const source = fn.toString();
  if (NATIVE_CODE.test(source)) {
    throw new Error(
      `Cannot derive portable source from "${fn.name || "anonymous"}": it is native or bound code. ` +
        "Ship an explicit source module instead."
    );
  }
  if (EXPRESSION_START.test(source) || BARE_ARROW.test(source)) {
    return `(${source})`;
  }
  // Method shorthand: `name(args) { ... }`.
  const name = fn.name || "fn";
  return `({ ${source} }).${name}`;
}

/**
 * Derives a portable single-validator module from a **closure-free** hosted validator via
 * `fn.toString()`. A convenience for validators authored once and run both in-process and
 * in the sandbox (parity tests, simple hosts); plugins shipping to production sandboxes
 * should author explicit `source`.
 */
export function toSourceModule(validator: WasmValidator): WasmPluginSource {
  return {
    id: validator.id,
    version: validator.version,
    source: `({ validators: [${functionExpression(validator.validate)}] })`
  };
}

/** Derives a portable module from a function-backed plugin. Same caveats as {@link toSourceModule}. */
export function toSourcePlugin(plugin: WasmPlugin): WasmPluginSource {
  const validators = plugin.validators
    .map((validator) => functionExpression(validator.validate))
    .join(", ");
  const functions = Object.entries(plugin.functions ?? {})
    .map(([name, fn]) => `${JSON.stringify(name)}: ${functionExpression(fn)}`)
    .join(", ");
  return {
    id: plugin.id,
    version: plugin.version,
    source: `({ validators: [${validators}], functions: { ${functions} } })`
  };
}
