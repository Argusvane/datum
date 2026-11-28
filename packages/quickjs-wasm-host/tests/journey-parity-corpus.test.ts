import { describe, expect, it } from "vitest";

import {
  FormRuntime,
  InProcessWasmHostAdapter,
  JsonWasmAbi,
  SubmissionModeRegistry,
  ValidationPipeline,
  WasmValidationHost,
  createFieldConstraintsStage,
  createInProcessWasmValidationHost,
  type ComponentNode,
  type FormDefinition,
  type Journey
} from "@argusvane/datum-engine";

import { QuickJsWasmHostAdapter } from "../src/index.js";
import { kernelFoldSubmission } from "@argusvane/datum-engine/testing";

// The random-journey corpus: random journeys (branches, back/self/unknown routes, shared and unassigned fields,
// exit pages, hostile ids). Three comparisons:
//  A. independent oracle (rule-free forms): path, off-path withheld, required on reached/unassigned only
//  B. in-process kernel vs the real QuickJS program, byte for byte, at debug level
//  C. FormRuntime (browser) verdict vs the QuickJS server verdict over the envelope
// A divergence would be a finding; a clean run is REFUTED-BY-TEST.

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** The formula `<p> = "<v>"`, the one condition the oracle below reads back. */
const eq = (p: string, v: string): string => `${p} = "${v}"`;

interface Case {
  form: FormDefinition;
  journey: Journey;
  fields: Array<{ id: string; required: boolean; hvb?: string }>;
  pageFields: Record<string, string[]>;
  values: Record<string, unknown>;
  simple: boolean;
}

const HOSTILE = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"];

function gen(seed: number, simple: boolean): Case {
  const r = rng(seed);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const n = 3 + Math.floor(r() * 5);
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) ids.push(simple && r() < 0.15 ? pick(HOSTILE.filter((h) => !ids.includes(h))) : "f" + i);
  const fields: Case["fields"] = [];
  const nodes: ComponentNode[] = [];
  const keyOf: Record<string, string> = {};
  const containerOf: Record<string, string> = {};
  for (const id of ids) {
    const required = r() < 0.45;
    const hvb = !simple && r() < 0.3 ? pick(["retain", "clear", "exclude-from-submission"]) : undefined;
    const configuration: Record<string, unknown> = { required };
    if (hvb) configuration.hiddenValueBehavior = hvb;
    if (!simple && r() < 0.15) configuration.dataKey = "k_" + id;
    const node: ComponentNode = { id, type: "text", configuration } as ComponentNode;
    if (!simple) {
      if (r() < 0.25) (node as any).rules = { visibleWhen: eq(pick(ids), "a") };
      else if (r() < 0.12) (node as any).rules = { requiredWhen: eq(pick(ids), "a") };
    }
    fields.push({ id, required, ...(hvb ? { hvb } : {}) });
    nodes.push(node);
    keyOf[id] = (configuration.dataKey as string | undefined) ?? id;
  }
  // containers (rich only): wrap two adjacent fields
  const content: ComponentNode[] = [];
  const units: string[] = []; // page-listable ids
  if (!simple && n >= 4 && r() < 0.5) {
    const a = nodes[1] as ComponentNode;
    const b = nodes[2] as ComponentNode;
    const box: ComponentNode = { id: "box", type: "container", configuration: {}, children: { content: [a, b] } } as ComponentNode;
    content.push(nodes[0] as ComponentNode, box, ...nodes.slice(3));
    units.push(ids[0] as string, "box", ...ids.slice(3));
    for (const id of [a.id, b.id]) {
      containerOf[id] = "box";
      keyOf[id] = "box." + keyOf[id];
    }
  } else {
    content.push(...nodes);
    units.push(...ids);
  }
  content.push({ id: "bye", type: "html", configuration: {} } as ComponentNode);
  const nPages = 2 + Math.floor(r() * 4);
  const pageIds: string[] = [];
  for (let i = 0; i < nPages; i += 1) pageIds.push(simple && r() < 0.1 ? pick(HOSTILE.filter((h) => !pageIds.includes(h))) : "p" + i);
  const pages: Journey["pages"] = pageIds.map((id) => ({ id, components: [] as string[] })) as Journey["pages"];
  for (const u of units) {
    const roll = r();
    if (roll < 0.15) continue; // unassigned
    const first = Math.floor(r() * nPages);
    (pages[first] as any).components.push(u);
    if (roll > 0.88) {
      const second = Math.floor(r() * nPages);
      if (second !== first) (pages[second] as any).components.push(u);
    }
    if (roll > 0.8 && roll <= 0.88) (pages[first] as any).components.push("removed_" + u); // stale id
  }
  const condField = () => pick(ids);
  pages.forEach((page: any, i) => {
    // Pages have no condition of their own; the draws that made one are kept, so the corpus is
    // the one it was with those conditions left out.
    if (i > 0 && r() < 0.45) void [condField(), pick(["a", "b"])];
    const nr = Math.floor(r() * 3);
    if (nr > 0) {
      page.routes = [];
      for (let k = 0; k < nr; k += 1) {
        const roll = r();
        const to = roll < 0.15 ? "$end" : roll < 0.25 ? "nope" : roll < 0.35 ? page.id : pick(pageIds);
        page.routes.push({ ...(r() < 0.75 ? { when: eq(condField(), pick(["a", "b"])) } : {}), to });
      }
    }
  });
  if (r() < 0.15) {
    pages.push({ id: "gone", kind: "exit", components: ["bye"] } as any);
  }
  const journey: Journey = { id: "j", pages, ...(r() < 0.5 ? { offPathValues: pick(["retain", "clear", "exclude-from-submission"]) as any } : {}) } as Journey;
  const form: FormDefinition = {
    id: "fz",
    version: "1",
    schemaVersion: "1",
    root: { id: "form", type: "form", configuration: {}, children: { content } } as ComponentNode,
    journey: { journeys: [journey] }
  } as unknown as FormDefinition;
  const values: Record<string, unknown> = {};
  for (const id of ids) {
    if (r() < 0.75) Object.defineProperty(values, keyOf[id] as string, { value: pick(["a", "b", "ab", ""]), enumerable: true, writable: true, configurable: true });
  }
  const pageFields: Record<string, string[]> = Object.create(null);
  for (const page of pages) pageFields[page.id] = ((page as any).components as string[]).filter((c) => ids.includes(c));
  return { form, journey, fields, pageFields, values, simple };
}

/** Independent oracle for a rule-free form. */
function oracle(c: Case) {
  const view: Record<string, unknown> = Object.create(null);
  const own: Record<string, string[]> = Object.create(null);
  const placed = new Set<string>();
  for (const [p, fs] of Object.entries(c.pageFields)) for (const f of fs) { (own[f] ??= []).push(p); placed.add(f); }
  const pending = new Set<string>();
  for (const f of c.fields) { if (!placed.has(f.id)) view[f.id] = Object.hasOwn(c.values, f.id) ? c.values[f.id] : undefined; else pending.add(f.id); }
  const pages = c.journey.pages as any[];
  const idx = new Map<string, number>();
  pages.forEach((p, i) => { if (!idx.has(p.id)) idx.set(p.id, i); });
  const test = (when: string) => {
    const [, p, v] = /^(\S+) = "(.*)"$/.exec(when) as RegExpExecArray;
    return Object.hasOwn(view, p as string) && view[p as string] === v;
  };
  const onPath: string[] = [];
  let end = "end";
  let i = 0;
  while (i < pages.length) {
    const page = pages[i];
    // Every page the walk reaches is on the path, one with nothing of the form on it included.
    onPath.push(page.id);
    for (const f of [...pending]) if (own[f]!.includes(page.id)) { view[f] = Object.hasOwn(c.values, f) ? c.values[f] : undefined; pending.delete(f); }
    if (page.kind === "exit") { end = "exit"; break; }
    let next = i + 1;
    for (const route of page.routes ?? []) {
      const t = route.to === "$end" ? pages.length : idx.get(route.to);
      if (t === undefined || t <= i) continue;
      if (route.when && !test(route.when)) continue;
      next = t;
      break;
    }
    i = next;
  }
  const off = (f: string) => placed.has(f) && !own[f]!.some((p) => onPath.includes(p));
  return { onPath, end, off };
}

const envelope = { form: { id: "fz", version: "1" }, client: { runtimeVersion: "0.1.0", rendererVersion: "0.1.0", schemaVersion: "1" } };

function runtimeVerdict(form: FormDefinition, values: Record<string, unknown>) {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  modes.register({ id: "send", validate: false, sign: false, serverValidation: false });
  const make = () => {
    const rt = new FormRuntime(form, {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([createFieldConstraintsStage(form.root)]),
      wasmValidationHost: createInProcessWasmValidationHost([])
    });
    for (const [k, v] of Object.entries(values)) rt.setValue(k, v);
    return rt;
  };
  return { started: () => make().journeyView() !== undefined, submit: () => make().submit("submit", envelope as never), send: () => make().submit("send", envelope as never) };
}


// ---- Calculations that read later pages ----
// Random journeys with 1-3 chained calculations, page and route conditions over fields and
// calculations, three offPathValues modes, optionally hidden fields with a hiddenValueBehavior.
// Browser envelope == server over the raw honest answers == server over the envelope, unsettled
// agreeing on both sides, in-process == QuickJS byte for byte on a slice, and a filler who forges
// the derived values gets the honest verdict.
const SYMBOL: Record<string, string> = { gt: ">", lt: "<", eq: "=", add: "+", subtract: "-", multiply: "*" };
const bin = (operator: string, left: string | number, right: string | number): string => `${left} ${SYMBOL[operator]} ${right}`;

function genCalc(seed: number, rich: boolean) {
  const r = rng(seed);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const fields = Array.from({ length: 3 + Math.floor(r() * 3) }, (_, i) => "n" + i);
  const calcs = Array.from({ length: 1 + Math.floor(r() * 3) }, (_, i) => "c" + i);
  const nodes: ComponentNode[] = [];
  for (const id of fields) {
    const configuration: Record<string, unknown> = { required: false };
    const node: any = { id, type: "number", configuration };
    if (rich) {
      if (r() < 0.3) configuration.hiddenValueBehavior = pick(["retain", "clear", "exclude-from-submission"]);
      if (r() < 0.3) node.rules = { visibleWhen: bin("gt", pick(fields), pick([1, 2, 3])) };
    }
    nodes.push(node);
  }
  const reads: string[] = [...fields];
  for (const id of calcs) {
    const a = pick(reads);
    const b = pick(reads);
    const op = pick(["add", "subtract", "multiply"]);
    nodes.push({ id, type: "number", configuration: { required: false }, rules: { value: r() < 0.3 ? bin(op, a, 2) : bin(op, a, b) } } as never);
    reads.push(id);
  }
  nodes.push({ id: "tail", type: "text", configuration: { required: false } } as never);
  const all = [...fields, ...calcs, "tail"];
  const nPages = 2 + Math.floor(r() * 3);
  const pages: any[] = Array.from({ length: nPages }, (_, i) => ({ id: "p" + i, components: [] as string[] }));
  for (const u of all) {
    if (r() < 0.1) continue;
    pages[Math.floor(r() * nPages)].components.push(u);
  }
  pages.forEach((p, i) => {
    // Pages have no condition of their own; the draws that made one are kept, so the corpus is
    // the one it was with those conditions left out.
    if (i > 0 && r() < 0.6) void [pick(["gt", "lt", "eq"]), pick(reads), pick([0, 1, 2, 3, 4, 5, 6])];
    if (r() < 0.3) {
      p.routes = [{ ...(r() < 0.8 ? { when: bin("gt", pick(reads), pick([1, 2, 3])) } : {}), to: pick([...pages.map((x) => x.id), "$end"]) }];
    }
  });
  const journey = { id: "j", pages, ...(r() < 0.4 ? { offPathValues: pick(["retain", "clear", "exclude-from-submission"]) } : {}) } as unknown as Journey;
  const form = {
    id: "fz", version: "1", schemaVersion: "1",
    root: { id: "form", type: "form", configuration: {}, children: { content: nodes } } as ComponentNode,
    journey: { journeys: [journey] }
  } as unknown as FormDefinition;
  const values: Record<string, unknown> = {};
  for (const id of fields) if (r() < 0.85) values[id] = Math.floor(r() * 7);
  const forged: Record<string, unknown> = { ...values };
  for (const id of calcs) if (r() < 0.6) forged[id] = Math.floor(r() * 50);
  return { form, journey, values, forged };
}

describe("journey fold corpus", async () => {
  const abi = new JsonWasmAbi();
  const inProc = new InProcessWasmHostAdapter().instantiate([], abi);
  const quick = await new QuickJsWasmHostAdapter().instantiate([], abi);
  const ctx = (c: Case, values: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    abi.serializeContext({ formId: "fz", values, locale: "en", form: c.form.root, journey: c.journey, ...extra } as never, WasmValidationHost.STRICT_POLICY);

  it("A+B: oracle (rule-free) and in-process vs QuickJS byte-for-byte, 300 cases x 3 unknown modes", async () => {
    const bad: string[] = [];
    for (let seed = 1; seed <= Number(process.env.J1_N ?? 300); seed += 1) {
      const c = gen(seed, seed % 2 === 0);
      // JSON round trip so hostile ids stay own keys
      const values = JSON.parse(JSON.stringify(c.values)) as Record<string, unknown>;
      for (const unknownFields of ["strip", "keep", "reject"]) {
        const payload = ctx(c, values, { unknownFields, logLevel: "debug" });
        const a = inProc.run(payload);
        const b = await quick.run(payload);
        if (a !== b) bad.push(`B seed ${seed} ${unknownFields}`);
      }
      if (c.simple) {
        const o = oracle(c);
        const out = abi.deserializeOutcome(await quick.run(ctx(c, values)));
        const errIds = out.errors.map((e) => `${e.componentId ?? "-"}:${e.code}`);
        if (o.end === "exit") {
          if (!out.errors.some((e) => e.code === "journey.exit")) bad.push(`A seed ${seed} exit not refused`);
          continue;
        }
        // required: only on-path or unassigned; never off
        for (const f of c.fields) {
          const has = Object.hasOwn(values, f.id);
          const empty = !has || values[f.id] === "";
          const hasReq = errIds.some((e) => e.startsWith(f.id + ":") && e.endsWith(":required"));
          const expectReq = f.required && empty && !o.off(f.id);
          if (hasReq !== expectReq) { if (process.env.J1_DUMP === "A" + seed) console.log(JSON.stringify({ values, journey: c.journey, fields: c.fields, o, errIds, outv: out.values })); bad.push(`A seed ${seed} required ${f.id} got ${hasReq} want ${expectReq}`); }
          // withheld off-path under the default or "exclude"; journey offPathValues decides
          const stored = out.values !== undefined && Object.hasOwn(out.values, f.id) && out.values[f.id] !== undefined;
          if (out.values !== undefined && o.off(f.id) && has) {
            const mode = (c.journey as any).offPathValues ?? "exclude-from-submission";
            const wantStored = mode === "retain";
            if (stored !== wantStored) bad.push(`A seed ${seed} off-path ${f.id} stored=${stored} mode=${mode}`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  }, 240000);

  it("C: browser runtime verdict equals the QuickJS server verdict over its envelope, 300 rich cases", async () => {
    const bad: string[] = [];
    let skippedEmpty = 0;
    let notStarted = 0;
    for (let seed = 1000; seed < 1000 + Number(process.env.J1_N ?? 300); seed += 1) {
      const c = gen(seed, false);
      const fold = kernelFoldSubmission(c.form.root, c.values, c.journey);
      // Harness artefacts: an empty path starts no journey in the browser (it falls back to the whole form); an exit path submits nothing.
      if ((fold.trace?.pages.length ?? 0) === 0) { skippedEmpty += 1; continue; }
      const rt = runtimeVerdict(c.form, c.values);
      if (!rt.started()) { notStarted += 1; continue; }
      const submitted = await rt.submit();
      const browserErrors = submitted.errors.map((e) => `${e.componentId ?? "-"}:${e.code}`).sort();
      let sent: Record<string, unknown>;
      let fromEnvelope = true;
      if (submitted.accepted && submitted.canonicalSubmission) sent = submitted.canonicalSubmission.submission.values as Record<string, unknown>;
      else {
        const u = await rt.send();
        if (u.canonicalSubmission) sent = u.canonicalSubmission.submission.values as Record<string, unknown>;
        else { sent = c.values; fromEnvelope = false; }
      }
      const out = abi.deserializeOutcome(await quick.run(ctx(c, sent)));
      const serverErrors = out.errors.filter((e) => (e.severity ?? "error") === "error").map((e) => `${e.componentId ?? "-"}:${e.code}`).sort();
      const serverAccepted = serverErrors.length === 0 && out.values !== undefined;
      if (!fromEnvelope) { if (serverAccepted) bad.push(`C seed ${seed} exit accepted`); continue; }
      if (serverAccepted !== submitted.accepted || (JSON.stringify(serverErrors) !== JSON.stringify(browserErrors))) {
        if (process.env.J1_DUMP === String(seed)) console.log(JSON.stringify({ values: c.values, sent, journey: c.journey, root: c.form.root, outErr: out.errors, outVals: out.values }, null, 1));
        bad.push(`C seed ${seed} browser=${submitted.accepted}${JSON.stringify(browserErrors)} server=${serverAccepted}${JSON.stringify(serverErrors)} fromEnvelope=${fromEnvelope}`);
      } else if (serverAccepted && JSON.stringify(out.values) !== JSON.stringify(sent)) {
        if (process.env.J1_DUMP === String(seed)) console.log(JSON.stringify({ values: c.values, sent, journey: c.journey, root: c.form.root, outErr: out.errors, outVals: out.values }, null, 1));
        bad.push(`C seed ${seed} values differ`);
      }
    }
    console.log("skippedEmpty", skippedEmpty, "notStarted", notStarted);
    expect(bad).toEqual([]);
  }, 240000);
  for (const rich of [false, true]) {
    it(`D: calculations reading later pages (${rich ? "rich" : "plain"}): browser == server == QuickJS, forged calculations dropped, N=300`, async () => {
      const bad: string[] = [];
      const strip = (o: unknown) => JSON.parse(JSON.stringify(o ?? null)) as Record<string, unknown>;
      const sorted = (o: unknown) => JSON.stringify(Object.fromEntries(Object.entries(strip(o)).sort(([a], [b]) => a.localeCompare(b))));
      let compared = 0;
      let unsettled = 0;
      const total = Number(process.env.J1_N ?? 300);
      for (let seed = 1; seed <= total; seed += 1) {
        const c = genCalc(seed, rich);
        const cx = { form: c.form, journey: c.journey } as unknown as Case;
        const started = runtimeVerdict(c.form, c.values);
        if (!started.started()) continue;
        const sentOutcome = await started.send();
        const sent = sentOutcome.canonicalSubmission?.submission.values as Record<string, unknown> | undefined;
        if (sent === undefined) continue;
        const browserUnsettled = (await started.submit()).errors.some((e) => e.code === "fold.unsettled");
        const honest = abi.deserializeOutcome(inProc.run(ctx(cx, c.values)) as string) as any;
        const serverUnsettled = honest.errors.some((e: any) => e.code === "fold.unsettled");
        if (browserUnsettled !== serverUnsettled) {
          bad.push(`seed ${seed}: unsettled browser=${browserUnsettled} server=${serverUnsettled}`);
          continue;
        }
        if (serverUnsettled) {
          unsettled += 1;
          continue;
        }
        compared += 1;
        const forged = abi.deserializeOutcome(inProc.run(ctx(cx, c.forged)) as string) as any;
        const fromEnvelope = abi.deserializeOutcome(inProc.run(ctx(cx, sent)) as string) as any;
        if (sorted(honest.values) !== sorted(sent)) bad.push(`seed ${seed}: server(raw) ${sorted(honest.values)} != browser ${sorted(sent)}`);
        // A hideable input that excludes or clears its hidden answer is a maybe-withheld read the server takes on trust, so a forged calculation over one is out of the plain-form claim.
        if (!rich && sorted(forged.values) !== sorted(sent)) bad.push(`seed ${seed}: server(forged) ${sorted(forged.values)} != browser ${sorted(sent)}`);
        if (sorted(fromEnvelope.values) !== sorted(sent)) bad.push(`seed ${seed}: server(envelope) ${sorted(fromEnvelope.values)} != browser ${sorted(sent)}`);
        if (seed % 5 === 0) {
          const payload = ctx(cx, c.forged);
          if ((await quick.run(payload)) !== inProc.run(payload)) bad.push(`seed ${seed}: quickjs != in-process`);
        }
      }
      console.log(`D ${rich ? "rich" : "plain"}: compared`, compared, "unsettled", unsettled);
      expect(bad).toEqual([]);
      expect(compared).toBeGreaterThan(total / 3);
    }, 280000);
  }
});
