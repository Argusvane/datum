import { describe, expect, it } from "vitest";

import {
  runHookSeries,
  runValueTransforms,
  type AgentProvenance,
  type AfterSubmitHookContext,
  type BeforeSubmitHookContext
} from "../form-engine/core/events/hooks.js";

describe("hooks", () => {
  it("runs hook series in deterministic order", async () => {
    const trace: string[] = [];

    await runHookSeries(
      [
        async () => {
          trace.push("a");
        },
        async () => {
          trace.push("b");
        },
        async () => {
          trace.push("c");
        }
      ],
      { value: 1 }
    );

    expect(trace).toEqual(["a", "b", "c"]);
  });

  it("runs value transforms in deterministic order", async () => {
    const result = await runValueTransforms(
      [
        async (values) => ({ ...values, first: "Ada" }),
        async (values) => ({ ...values, last: "Lovelace" })
      ],
      {}
    );

    expect(result).toEqual({ first: "Ada", last: "Lovelace" });
  });

  it("the submit hook contexts type an optional agent provenance", async () => {
    // A type assertion with the attestation recipe as its example: a
    // beforeSubmit hook refuses an answer the agent tools wrote. Core only types the field; the
    // runtime fills and freezes it, and its own tests pin that.
    const attest = (context: BeforeSubmitHookContext): void => {
      if (context.agent?.paths.includes("declaration") || (context.agent?.complete === false && context.values.declaration === true)) {
        throw new Error("Please tick the declaration yourself.");
      }
    };
    const agent: Readonly<AgentProvenance> = Object.freeze({
      version: 1,
      involved: true,
      paths: ["declaration"],
      tables: [],
      complete: true,
      submittedBy: "page",
      sessions: 1,
      sessionOpen: false
    });
    await expect(runHookSeries([attest], { values: { declaration: true }, modeId: "default", agent })).rejects.toThrow(
      "Please tick the declaration yourself."
    );
    await expect(
      runHookSeries([attest], { values: { declaration: true }, modeId: "default", agent: { ...agent, paths: [], complete: false } })
    ).rejects.toThrow("Please tick the declaration yourself.");
    // Absent when the agent tools were never registered: the hook lets the person's own answer through.
    await expect(runHookSeries([attest], { values: { declaration: true }, modeId: "default" })).resolves.toBeUndefined();
    const after: AfterSubmitHookContext = { values: {}, modeId: "default", submissionId: "s-1", agent };
    const seen: Array<Readonly<AgentProvenance> | undefined> = [];
    await runHookSeries([(context: AfterSubmitHookContext) => void seen.push(context.agent)], after);
    expect(seen).toEqual([agent]);
  });
});
