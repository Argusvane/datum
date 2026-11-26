import { describe, expect, it } from "vitest";

import type { ComponentNode } from "@argusvane/datum-engine";

import { createQuickJsFreshSandboxHost } from "../src/index.js";
import { createQuickJsWorkerHost } from "../src/worker-host.js";
import { SLOW_FACTOR } from "./slow-machine.js";

/**
 * A run's scaled budget comes from an `inspect` question that needs a sandbox of its own. When
 * that sandbox cannot be built the probe fails; the failure must not be remembered as the
 * definition's budget, or a large definition would stay on the base budget (and be `interrupted`)
 * on every later delivery.
 */

const form = { id: "form", type: "form", configuration: {}, children: { content: [{ id: "a", type: "text", configuration: {} }] } } as unknown as ComponentNode;
const context = JSON.stringify({ formId: "f", values: {}, locale: "en", form });

// A program that will not load inside one window of time, whose run takes 600 ms (more than the
// 250 ms base budget) and whose inspect answer reads enough fields for a budget that covers it.
const windowed = (opens: number, closes: number): string => `
  var now = Date.now();
  if (now >= ${opens} && now < ${closes}) { throw new Error("no sandbox in this window"); }
  globalThis.__datum_register = function () { return 0; };
  globalThis.__datum_run = function () { var e = Date.now() + 600; while (Date.now() < e) {} return '{"errors":[]}'; };
  globalThis.__datum_inspect = function () { var reads = []; for (var i = 0; i < 200; i++) reads.push("a"); return JSON.stringify({ ok: true, rules: [{ reads: reads }] }); };
  "ready";`;

const settle = (promise: Promise<string>): Promise<string> =>
  promise.then(
    () => "answered",
    (error: unknown) => String((error as { code?: string }).code)
  );

describe("a budget probe that fails", () => {
  it.each([
    ["the worker host", (program: string) => createQuickJsWorkerHost({ program, checkProgramAbi: false })],
    ["the fresh-sandbox host (worker: false)", (program: string) => createQuickJsFreshSandboxHost({ program, checkProgramAbi: false })]
  ])("%s: leaves the definition's later runs on the scaled budget, not the base one", async (_name, make) => {
    const opens = Date.now() + 2500 * SLOW_FACTOR;
    const closes = opens + 1500 * SLOW_FACTOR;
    const host = await make(windowed(opens, closes));
    try {
      await new Promise((resolve) => setTimeout(resolve, opens - Date.now() + 20));
      // Uses the sandbox that was built before the window, so the run's own probe must build one inside it and fails.
      await settle(host.inspect("{}"));
      expect(await settle(host.run(context))).not.toBe("answered");
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, closes - Date.now() + 50)));
      // The probe answers now: 250 + 5 * 200 ms covers the 600 ms run. On the base budget it is interrupted.
      expect(await settle(host.run(context))).toBe("answered");
      expect(await settle(host.run(context))).toBe("answered");
    } finally {
      await host.dispose();
    }
  }, 60_000);
});
