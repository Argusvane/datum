import { describe, expect, it } from "vitest";

import { InProcessWasmHostAdapter, JsonWasmAbi, WasmValidationHost } from "@argusvane/datum-engine";

import { QuickJsWasmHostAdapter } from "../src/index.js";
import { SLOW_FACTOR } from "./slow-machine.js";

// Journey hardening on the real QuickJS program: a calculation reads the
// settled view, and the path walk is linear in the pages.

const lt = (p: string, n: number) => ({ kind: "binary", operator: "lt", left: { kind: "path", path: p }, right: { kind: "literal", value: n } });
const eq = (p: string, v: unknown) => ({ kind: "binary", operator: "eq", left: { kind: "path", path: p }, right: { kind: "literal", value: v } });

describe("journeys on the QuickJS program, hardening", () => {
  it("a calculation never reads an answer the journey withheld, and so derives nothing from a forged one", async () => {
    const form: any = {
      id: "form", type: "form", configuration: {},
      children: { content: [
        { id: "resident", type: "select", configuration: { required: true, options: [{ value: "yes", label: "y" }, { value: "no", label: "n" }] } },
        { id: "income", type: "number", configuration: { required: true } },
        { id: "eligible", type: "checkbox", configuration: {}, rules: { value: lt("income", 30000) } },
        { id: "bonus", type: "text", configuration: { required: true } }
      ] }
    };
    const journey: any = { id: "j", pages: [
      { id: "who", components: ["resident"], routes: [{ when: { kind: "unary", operator: "not", operand: eq("resident", "yes") }, to: "result" }] },
      { id: "money", components: ["income"] },
      { id: "result", components: ["eligible"], routes: [{ when: { kind: "unary", operator: "not", operand: eq("eligible", true) }, to: "$end" }] },
      { id: "extra", components: ["bonus"] }
    ] };
    const abi = new JsonWasmAbi();
    const hosts = { inproc: new InProcessWasmHostAdapter().instantiate([], abi), quickjs: await new QuickJsWasmHostAdapter().instantiate([], abi) };
    for (const [name, host] of Object.entries(hosts)) {
      const run = async (values: Record<string, unknown>) =>
        abi.deserializeOutcome(await host.run(abi.serializeContext({ formId: "f", values, locale: "en", form, journey } as never, WasmValidationHost.STRICT_POLICY)));
      const honest = await run({ resident: "no" });
      expect(honest.errors, name).toEqual([]);
      expect(honest.values?.eligible, name).not.toBe(true);
      // Income sits on a page resident "no" skips; a forged income does not
      // derive eligible = true, so the page behind it stays off the path and its answer is withheld.
      const forged = await run({ resident: "no", income: 0, bonus: "x" });
      expect(forged.errors, name).toEqual([]);
      expect(forged.values, name).toEqual(honest.values);
      expect(forged.values?.eligible, name).not.toBe(true);
      // The same forgery with the figure ON the path still derives from it, as before.
      const real = await run({ resident: "yes", income: 0, bonus: "x" });
      expect(real.values?.eligible, name).toBe(true);
      // A forged result is not taken on trust: the filler cannot name a derived answer the withheld input would not give.
      const claimed = await run({ resident: "no", eligible: true, bonus: "x" });
      expect(claimed.values?.eligible, name).not.toBe(true);
    }
  });

  it("a calculation that moves the page that feeds it is fold.unsettled; an omitted on-path optional input is the person's empty answer", async () => {
    const path = (p: string) => ({ kind: "path", path: p });
    const abi = new JsonWasmAbi();
    const hosts = { inproc: new InProcessWasmHostAdapter().instantiate([], abi), quickjs: await new QuickJsWasmHostAdapter().instantiate([], abi) };
    const osc: any = { id: "form", type: "form", configuration: {}, children: { content: [
      { id: "n0", type: "number", configuration: {} },
      { id: "n1", type: "number", configuration: {} },
      { id: "c0", type: "number", configuration: {}, rules: { value: { kind: "arithmetic", operator: "add", left: path("n1"), right: path("n0") } } }
    ] } };
    const oscJourney: any = { id: "j", pages: [
      { id: "p0", components: ["n0", "c0"], routes: [{ when: { kind: "binary", operator: "gt", left: path("c0"), right: { kind: "literal", value: 3 } }, to: "$end" }] },
      { id: "p1", components: ["n1"] }
    ] };
    const money: any = { id: "form", type: "form", configuration: {}, children: { content: [
      { id: "resident", type: "select", configuration: { required: true, options: [{ value: "yes", label: "y" }] } },
      { id: "income", type: "number", configuration: {} },
      { id: "eligible", type: "checkbox", configuration: {}, rules: { value: lt("income", 30000) } },
      { id: "bonus", type: "text", configuration: { required: true } }
    ] } };
    const moneyJourney: any = { id: "j", pages: [
      { id: "who", components: ["resident"], routes: [{ when: { kind: "unary", operator: "not", operand: eq("resident", "yes") }, to: "result" }] },
      { id: "money", components: ["income"] },
      { id: "result", components: ["eligible"], routes: [{ when: { kind: "unary", operator: "not", operand: eq("eligible", true) }, to: "$end" }] },
      { id: "extra", components: ["bonus"] }
    ] };
    for (const [name, host] of Object.entries(hosts)) {
      const run = async (form: any, journey: any, values: any) =>
        abi.deserializeOutcome(await host.run(abi.serializeContext({ formId: "f", values, locale: "en", form, journey } as never, WasmValidationHost.STRICT_POLICY))) as any;
      const unsettled = await run(osc, oscJourney, { n0: 4, n1: 5 });
      expect(unsettled.errors.map((e: any) => e.code), name).toContain("fold.unsettled");
      expect(unsettled.values, name).toBeUndefined();
      const honest = await run(money, moneyJourney, { resident: "yes" });
      const forged = await run(money, moneyJourney, { resident: "yes", eligible: true, bonus: "x" });
      expect(honest.errors, name).toEqual([]);
      expect(forged.errors, name).toEqual([]);
      expect(forged.values, name).toEqual(honest.values);
      expect(forged.clientDerived, name).toBeUndefined();
    }
  });

  it("a journey at the page cap (1,000 pages) is judged in the QuickJS sandbox in the time of the same fields without a journey", async () => {
    const abi = new JsonWasmAbi();
    const n = 1000;
    const content: any[] = [];
    const pages: any[] = [];
    const values: Record<string, unknown> = {};
    for (let i = 0; i < n; i += 1) {
      content.push({ id: "f" + i, type: "text", configuration: {} });
      pages.push({ id: "p" + i, components: ["f" + i] });
      values["f" + i] = "a";
    }
    const form = { id: "form", type: "form", configuration: {}, children: { content } };
    const journeyed = abi.serializeContext({ formId: "f", values, locale: "en", form, journey: { id: "j", pages } } as never, WasmValidationHost.STRICT_POLICY);
    const plain = abi.serializeContext({ formId: "f", values, locale: "en", form } as never, WasmValidationHost.STRICT_POLICY);
    const quick = await new QuickJsWasmHostAdapter().instantiate([], abi);
    // The best of seven warm runs: the program is parsed and the engine's caches primed, as a
    // server's second request, and a loaded machine's noise does not decide it. A starved machine
    // can trip the sandbox's own wall clock (a synchronous throw); that run counts as slow.
    const best = (payload: string): number => {
      const times: number[] = [];
      for (let i = 0; i < 8; i += 1) {
        const started = performance.now();
        try {
          const outcome = abi.deserializeOutcome(quick.run(payload) as string);
          expect(outcome.errors).toEqual([]);
          if (i > 0) times.push(performance.now() - started);
        } catch (failure) {
          if ((failure as { code?: string }).code !== "interrupted") {
            throw failure;
          }
          if (i > 0) times.push(Number.POSITIVE_INFINITY);
        }
      }
      return Math.min(...times);
    };
    const baseline = best(plain);
    const withJourney = best(journeyed);
    console.log("journey warm ms: baseline", baseline.toFixed(1), "journey", withJourney.toFixed(1));
    // A quadratic walk would be interrupted at the default budget; compare against a baseline run, not a fixed 100 ms.
    expect(withJourney).toBeLessThan(Math.max(150 * SLOW_FACTOR, baseline * 3));
  }, 60000);

  it("a page, route or exit condition reading the clock, with no day given, is refused (journey.clockDependent), and runs with one", async () => {
    const DAY = "2026-10-14";
    const today = { kind: "call", name: "today", args: [] };
    const onDay = { kind: "binary", operator: "eq", left: today, right: { kind: "literal", value: DAY } };
    const form: any = {
      id: "form", type: "form", configuration: {},
      children: { content: [
        { id: "name", type: "text", configuration: { required: true } },
        { id: "consent", type: "checkbox", configuration: { required: true } },
        { id: "bye", type: "html", configuration: {} }
      ] }
    };
    const journeys: Record<string, any> = {
      page: { id: "j", pages: [{ id: "p1", components: ["name"], routes: [{ when: { kind: "unary", operator: "not", operand: onDay }, to: "$end" }] }, { id: "p2", components: ["consent"] }] },
      route: { id: "j", pages: [{ id: "p1", components: ["name"], routes: [{ when: onDay, to: "p3" }] }, { id: "p2", components: ["consent"] }, { id: "p3", components: [] }] },
      exit: { id: "j", pages: [{ id: "p1", components: ["name"], routes: [{ when: { kind: "unary", operator: "not", operand: onDay }, to: "p2" }] }, { id: "stop", kind: "exit", components: ["bye"] }, { id: "p2", components: ["consent"] }] }
    };
    // Each reads the clock in a route on its first page (a page has no condition of its own).
    const listed: Record<string, string> = { page: "p1", route: "p1", exit: "p1" };
    const abi = new JsonWasmAbi();
    const hosts = { inproc: new InProcessWasmHostAdapter().instantiate([], abi), quickjs: await new QuickJsWasmHostAdapter().instantiate([], abi) };
    for (const [name, host] of Object.entries(hosts)) {
      for (const [kind, journey] of Object.entries(journeys)) {
        const run = async (values: any, day?: string) =>
          abi.deserializeOutcome(await host.run(abi.serializeContext({ formId: "f", values, locale: "en", form, journey, ...(day ? { today: day } : {}) } as never, WasmValidationHost.STRICT_POLICY))) as any;
        const noDay = await run({ name: "a", consent: true });
        expect(noDay.errors.map((e: any) => e.code), name + " " + kind).toEqual(["journey.clockDependent"]);
        expect(noDay.errors[0].parameters, name + " " + kind).toEqual({ journey: "j", page: listed[kind] });
        expect(noDay.values, name + " " + kind).toBeUndefined();
        // A day that does not match takes the other branch, as the browser's does.
        const other = await run({ name: "a", consent: true }, "2026-10-15");
        expect(other.errors, name + " " + kind).toEqual([]);
        // Listed by the page's id, with a day too.
        expect(other.clockDependent, name + " " + kind).toEqual([listed[kind]]);
      }
    }
  });
});
