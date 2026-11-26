// Shared FEEL performance harness.
//
//   npm run bench:feel -- <parse|compile|evaluate|keystroke|kernel|builder|all> [--runs N] [--warm N]
//
// Runs under vite-node (the repo's way to run TypeScript sources from a script), so it measures
// the sources, not dist. Prints a table per sub-command and merges the rows into
// engine/scripts/bench-feel.last.json. Time only on an idle machine (`pgrep -f vitest` empty).
// Counts come from patching the module namespace (configurable getters under vite-node), so the
// product code is untouched; intra-module calls cannot be counted this way and are noted.
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const engine = join(here, "..", "form-engine");
const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith("--")) ?? "all";
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? Number(args[at + 1]) : fallback;
};
const RUNS = flag("runs", 7);
const WARM = flag("warm", 2);
const REPORT = join(here, "bench-feel.last.json");

const load = (p) => import(join(engine, p));
const [formula, compile, evaluator, fnTable, kernel, runtimeMod, fold, ladder, hostMod, inProc] = await Promise.all([
  load("core/expressions/formula.ts"),
  load("core/expressions/compile.ts"),
  load("rules/evaluator/evaluator.ts"),
  load("core/expressions/function-table.ts"),
  load("validation/wasm/portable-kernel.ts"),
  load("runtime/browser/form-runtime.ts"),
  load("core/state/submittable-fold.ts"),
  import(join(here, "..", "tests", "fixtures", "feel-ladder.ts")),
  load("validation/wasm/wasm-validation-host.ts"),
  load("validation/wasm/in-process-host.ts")
]);
const signatures = fnTable.formulaFunctionSignatures();

// ---- measuring -------------------------------------------------------------------------
function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { median: at(0.5), p90: at(0.9) };
}
/** Times `fn` (returning ms of one run); `setup` runs untimed before each run. */
function time(fn, { runs = RUNS, warm = WARM, setup } = {}) {
  const samples = [];
  for (let i = 0; i < warm + runs; i += 1) {
    const ctx = setup ? setup() : undefined;
    const t0 = performance.now();
    fn(ctx);
    const dt = performance.now() - t0;
    if (i >= warm) samples.push(dt);
  }
  return stats(samples);
}
async function timeAsync(fn, { runs = RUNS, warm = WARM } = {}) {
  const samples = [];
  for (let i = 0; i < warm + runs; i += 1) {
    const t0 = performance.now();
    await fn();
    const dt = performance.now() - t0;
    if (i >= warm) samples.push(dt);
  }
  return stats(samples);
}
/** Replaces module export `name` with a counting wrapper; returns {count(), reset(), restore()}. */
function counter(mod, name) {
  const original = mod[name];
  let n = 0;
  const wrapped = function (...a) {
    n += 1;
    return original.apply(this, a);
  };
  const descriptor = Object.getOwnPropertyDescriptor(mod, name);
  try {
    Object.defineProperty(mod, name, { configurable: true, enumerable: true, get: () => wrapped });
  } catch (error) {
    console.error(`cannot patch ${name}: ${String(error)}`);
    return { count: () => -1, reset() {}, restore() {} };
  }
  return {
    count: () => n,
    reset: () => {
      n = 0;
    },
    restore: () => descriptor && Object.defineProperty(mod, name, descriptor)
  };
}

const results = {};
const rows = [];
function row(group, step, t, metrics = {}) {
  const line = {
    step: `${group}:${step}`,
    median_ms: t ? Number(t.median.toFixed(4)) : undefined,
    p90_ms: t ? Number(t.p90.toFixed(4)) : undefined,
    ...metrics
  };
  rows.push(line);
  (results[group] ??= []).push(line);
}
function flush(group) {
  const mine = rows.filter((r) => r.step.startsWith(`${group}:`));
  console.log(`\n== ${group} (runs ${String(RUNS)}, warm ${String(WARM)}) ==`);
  console.table(mine.map(({ step, ...rest }) => ({ step: step.slice(group.length + 1), ...rest })));
}
function tokensOf(text) {
  return (text.match(/[A-Za-z_][\w.]*|\d+(?:\.\d+)?|"[^"]*"|[^\s\w]/g) ?? []).length;
}
function nodeCount(expr) {
  if (expr === null || typeof expr !== "object") return 0;
  let n = 1;
  for (const v of Object.values(expr)) {
    if (Array.isArray(v)) for (const x of v) n += nodeCount(x);
    else if (v && typeof v === "object") n += nodeCount(v);
  }
  return n;
}
const parseText = (text) => formula.kernelParseFormula(text, signatures);

// ---- sub-commands ----------------------------------------------------------------------
function benchParse() {
  const corpus = ladder.ruleCorpus(100, 50);
  const tokens = corpus.reduce((n, t) => n + tokensOf(t), 0);
  const t = time(() => corpus.forEach(parseText));
  row("parse", "corpus-100", t, { count: corpus.length, tokens, tokens_per_ms: Math.round(tokens / t.median) });
  const cases = [
    ...[50, 500, 5000].map((n) => [`and-chain-${String(n)}`, ladder.andChain(n)]),
    ...[10, 100].map((n) => [`if-ladder-${String(n)}`, ladder.ifLadder(n)]),
    ["wide-300", ladder.wideFormula(300)]
  ];
  for (const [name, text] of cases) {
    const ok = parseText(text).ok;
    const tk = tokensOf(text);
    const tt = time(() => parseText(text));
    row("parse", name, tt, { ok, tokens: tk, tokens_per_ms: Math.round(tk / tt.median) });
  }
}

function benchCompile() {
  for (const n of [50, 200, 1000]) {
    const root = ladder.ladderRoot({ fields: n, ruleShare: 0.3 });
    let parses = 0;
    const counting = (text, sigs) => {
      parses += 1;
      return formula.kernelParseFormula(text, sigs);
    };
    const run = () => compile.kernelCompileDefinition(root, undefined, undefined, counting, signatures);
    run();
    const rules = parses;
    const t = time(run);
    row("compile", `fields-${String(n)}`, t, { rules, parses_per_run: rules, per_rule_ms: Number((t.median / Math.max(1, rules)).toFixed(5)) });
  }
  for (const n of [200, 1000]) {
    const def = ladder.ladderForm({ fields: n, ruleShare: 0.3 });
    const c = counter(formula, "kernelParseFormula");
    runtimeMod.compileFormDefinition(def);
    const parses = c.count();
    c.restore();
    const t = time(() => runtimeMod.compileFormDefinition(def));
    row("compile", `compileFormDefinition-${String(n)}`, t, { parses_per_run: parses });
  }
}

function benchEvaluate() {
  const corpus = ladder.ruleCorpus(100, 50);
  const exprs = corpus.map((text) => parseText(text).expression).filter(Boolean);
  const nodes = exprs.reduce((n, e) => n + nodeCount(e), 0);
  const values = ladder.ladderValues(1000);
  const context = { values };
  const REPS = 20;
  const t = time(() => {
    for (let r = 0; r < REPS; r += 1) for (const e of exprs) evaluator.evaluateExpression(e, context);
  });
  const evals = exprs.length * REPS;
  row("evaluate", "corpus-100x20", t, {
    expressions: exprs.length,
    nodes_per_pass: nodes,
    per_eval_us: Number(((t.median * 1000) / evals).toFixed(3)),
    per_node_ns: Number(((t.median * 1e6) / (nodes * REPS)).toFixed(1))
  });
  let reads = 0;
  const proxied = new Proxy(values, { get: (target, key) => ((reads += typeof key === "string" ? 1 : 0), target[key]) });
  for (const e of exprs) evaluator.evaluateExpression(e, { values: proxied });
  const groups = {};
  const walk = (e) => {
    if (!e || typeof e !== "object") return;
    if (e.kind === "call" || e.type === "call") groups[e.name ?? e.fn ?? "?"] = (groups[e.name ?? e.fn ?? "?"] ?? 0) + 1;
    for (const v of Object.values(e)) Array.isArray(v) ? v.forEach(walk) : walk(v);
  };
  exprs.forEach(walk);
  row("evaluate", "path-reads-per-pass", undefined, { value_reads: reads, calls_by_name: JSON.stringify(groups) });
  const one = exprs.find((e) => nodeCount(e) > 5) ?? exprs[0];
  const t1 = time(() => {
    for (let r = 0; r < 2000; r += 1) evaluator.evaluateExpression(one, context);
  });
  row("evaluate", "single-rule-x2000", t1, { nodes: nodeCount(one), per_eval_us: Number(((t1.median * 1000) / 2000).toFixed(3)) });
  const ctx1000 = { values: ladder.ladderValues(1000) };
  const wide = parseText(ladder.wideFormula(300)).expression;
  const tw = time(() => {
    for (let r = 0; r < 200; r += 1) evaluator.evaluateExpression(wide, ctx1000);
  });
  row("evaluate", "wide-300-x200", tw, { per_eval_us: Number(((tw.median * 1000) / 200).toFixed(3)) });
  row("evaluate", "quickjs", undefined, { note: "see kernel:quickjs-* (the evaluator runs inside the program there)" });
}

function benchKeystroke() {
  const E = counter(evaluator, "evaluateExpression");
  const F = counter(fold, "kernelFoldSubmittable");
  const P = counter(formula, "kernelParseFormula");
  try {
    for (const readers of [1, 10, 50]) {
      const def = ladder.readersForm(readers, 100);
      const runtime = new runtimeMod.FormRuntime(def, {});
      let flip = 0;
      const key = (path) => () => runtime.setValue(path, `v${String(flip++)}`);
      for (const [label, path] of [["hub", "hub"], ["quiet", "quiet"]]) {
        const set = key(path);
        set();
        E.reset(); F.reset(); P.reset();
        const heap0 = process.memoryUsage().heapUsed;
        set();
        const heapDelta = process.memoryUsage().heapUsed - heap0;
        const evals = E.count(), folds = F.count(), parses = P.count();
        const t = time(() => { for (let i = 0; i < 20; i += 1) set(); });
        row("keystroke", `${label}-read-by-${String(readers)}`, { median: t.median / 20, p90: t.p90 / 20 }, {
          rules_evaluated_per_setValue: evals, fold_calls: folds, parses_per_setValue: parses, heap_delta_bytes_noisy: heapDelta
        });
      }
    }
    const none = new runtimeMod.FormRuntime(ladder.ladderForm({ fields: 200, ruleShare: 0.3 }), {});
    let k = 0;
    none.setValue("f0", "x");
    E.reset(); F.reset();
    none.setValue("f0", `y${String(k++)}`);
    const t = time(() => { for (let i = 0; i < 20; i += 1) none.setValue("f0", `y${String(k++)}`); });
    row("keystroke", "ladder-200-f0", { median: t.median / 20, p90: t.p90 / 20 }, { rules_evaluated_per_setValue: E.count(), fold_calls: F.count() });
    for (const n of [100, 1000]) {
      const rt = new runtimeMod.FormRuntime(ladder.ladderForm({ fields: 20, ruleShare: 0.3, repeating: true }), {});
      E.reset(); F.reset();
      const t0 = performance.now();
      const big = Array.from({ length: n }, (_, i) => ({ rowText: `r${String(i)}`, rowAmount: i }));
      rt.addRows("rows", big);
      const bulk = performance.now() - t0;
      const bulkEvals = E.count(), bulkFolds = F.count();
      E.reset(); F.reset();
      const t1 = performance.now();
      rt.addRow("rows", { rowText: "z", rowAmount: 1 });
      const one = performance.now() - t1;
      const addEvals = E.count(), addFolds = F.count();
      let j = 0;
      const ts = time(() => { for (let i = 0; i < 5; i += 1) rt.setValue("rows[0].rowText", `q${String(j++)}`); });
      E.reset();
      rt.setValue("rows[0].rowText", "w");
      const setEvals = E.count();
      const t2 = performance.now();
      rt.removeRow("rows", n);
      const rem = performance.now() - t2;
      row("keystroke", `rows-${String(n)}`, { median: one, p90: one }, {
        addRows_ms: Number(bulk.toFixed(3)), addRows_evals: bulkEvals, addRows_folds: bulkFolds,
        addRow_evals: addEvals, addRow_folds: addFolds, removeRow_ms: Number(rem.toFixed(3)),
        rowSetValue_ms: Number((ts.median / 5).toFixed(4)), rowSetValue_evals: setEvals
      });
    }
  } finally {
    E.restore(); F.restore(); P.restore();
  }
}

async function benchKernel() {
  const abi = new hostMod.JsonWasmAbi();
  const inProcess = new inProc.InProcessWasmHostAdapter().instantiate([], abi);
  let quick;
  try {
    const qj = await import(join(here, "..", "..", "packages", "quickjs-wasm-host", "src", "index.ts"));
    const t0 = performance.now();
    quick = await new qj.QuickJsWasmHostAdapter().instantiate([], abi);
    row("kernel", "quickjs-instantiate", { median: performance.now() - t0, p90: performance.now() - t0 }, {});
  } catch (error) {
    row("kernel", "quickjs-instantiate", undefined, { note: `unavailable: ${String(error).slice(0, 120)}` });
  }
  const P = counter(formula, "kernelParseFormula");
  try {
    for (const n of [50, 200, 1000]) {
      const root = ladder.ladderRoot({ fields: n, ruleShare: 0.3 });
      const values = ladder.ladderValues(n);
      const context = { formId: "ladder", values, locale: "en", form: root };
      const payload = abi.serializeContext(context, hostMod.WasmValidationHost.STRICT_POLICY);
      const run = () => inProcess.run(payload);
      P.reset();
      run();
      const parses = P.count();
      const t = time(run);
      const ts = time(() => abi.serializeContext(context, hostMod.WasmValidationHost.STRICT_POLICY));
      const outcomeText = run();
      const td = time(() => abi.deserializeOutcome(outcomeText));
      const tc = time(() => compile.kernelCompileDefinition(root, undefined, undefined, formula.kernelParseFormula, signatures));
      row("kernel", `in-process-${String(n)}`, t, {
        parses_per_run: parses, payload_bytes: payload.length, serialize_ms: Number(ts.median.toFixed(4)),
        deserialize_outcome_ms: Number(td.median.toFixed(4)), compile_ms: Number(tc.median.toFixed(4)),
        compile_share_pct: Number(((tc.median / t.median) * 100).toFixed(1))
      });
      if (quick) {
        await quick.run(payload);
        const tq = await timeAsync(() => quick.run(payload));
        row("kernel", `quickjs-${String(n)}`, tq, { payload_bytes: payload.length });
      }
    }
  } finally {
    P.restore();
    quick?.dispose?.();
  }
}

async function benchBuilder() {
  const [textarea, fields, print, logic, diag] = await Promise.all([
    load("builder/formula/formula-textarea.ts"),
    load("builder/formula/formula-fields.ts"),
    load("builder/formula/feel-print.ts"),
    load("builder/logic/logic-model.ts"),
    load("core/journey/journey-diagnostics.ts")
  ]);
  const root = ladder.ladderRoot({ fields: 200, ruleShare: 0.3 });
  const fieldList = fields.formulaFieldsOf(root);
  const corpus = ladder.ruleCorpus(100, 50);
  const opts = { fields: fieldList, signatures };
  row("builder", "formulaEditorState-corpus-100", time(() => corpus.forEach((x) => textarea.formulaEditorState(x, opts))), { fields: fieldList.length });
  const typo = ladder.ruleCorpus(100, 50).map((x) => x.replace("f1", "fx1"));
  row("builder", "formulaEditorState-unknown-fields-100", time(() => typo.forEach((x) => textarea.formulaEditorState(x, opts))));
  const exprs = corpus.map((x) => parseText(x).expression).filter(Boolean);
  row("builder", "printFormula-corpus-100", time(() => exprs.forEach((e) => print.printFormula(e))));
  for (const n of [50, 200, 1000]) {
    const r = ladder.ladderRoot({ fields: n, ruleShare: 0.3 });
    row("builder", `buildLogicModel-${String(n)}`, time(() => logic.buildLogicModel(r)));
  }
  const pages = Array.from({ length: 20 }, (_, p) => ({
    id: `p${String(p)}`,
    components: Array.from({ length: 10 }, (_, i) => `f${String(p * 10 + i)}`),
    ...(p > 0 ? { when: `not(empty(f${String(p * 10 - 1)}))` } : {})
  }));
  const journey = { id: "j", pages };
  try {
    row("builder", "diagnoseJourney-200-fields-20-pages", time(() => diag.diagnoseJourney(root, journey)), { findings: diag.diagnoseJourney(root, journey).length });
  } catch (error) {
    row("builder", "diagnoseJourney-200-fields-20-pages", undefined, { note: String(error).slice(0, 120) });
  }
  row("builder", "problemsOf-ruleProblemsFor", undefined, { note: "no such exports in engine core; the builder inspector owns them" });
}

// ---- main ------------------------------------------------------------------------------
const table = { parse: benchParse, compile: benchCompile, evaluate: benchEvaluate, keystroke: benchKeystroke, kernel: benchKernel, builder: benchBuilder };
const selected = command === "all" ? Object.keys(table) : [command];
if (selected.some((s) => !table[s])) {
  console.error(`unknown sub-command "${command}"; use ${Object.keys(table).join(", ")} or all`);
  process.exit(2);
}
for (const name of selected) {
  await table[name]();
  flush(name);
}
let previous = {};
try {
  if (existsSync(REPORT)) previous = JSON.parse(readFileSync(REPORT, "utf8")).results ?? {};
} catch {
  previous = {};
}
writeFileSync(REPORT, `${JSON.stringify({ node: process.version, runs: RUNS, warm: WARM, results: { ...previous, ...results } }, null, 2)}\n`);
console.log(`\nwrote ${REPORT}`);
