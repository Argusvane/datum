import { describe, expect, it } from "vitest";
import type { ComponentNode, FormDefinition } from "@argusvane/datum-engine";

import { InMemorySubmissionStore, SUBMISSION_ROUTES, createKernelValidator, createSubmissionService, statusOf, type InspectOp } from "../src/index.js";

/**
 * `SubmissionService.inspect`: the sandbox's three questions about a registered
 * definition, answered by the same kernel code every host runs, over the definition as
 * registered and the server's own policy.
 */

function formWith(rules: Record<string, unknown>, configuration: Record<string, unknown> = { title: "Apply" }): FormDefinition {
  return {
    id: "apply-form",
    version: "1",
    schemaVersion: "1",
    root: {
      id: "form",
      type: "form",
      configuration,
      children: {
        content: [
          { id: "employed", type: "checkbox", configuration: {} },
          { id: "income", type: "number", configuration: {} },
          { id: "reason", type: "text", configuration: {}, rules: rules as NonNullable<ComponentNode["rules"]> }
        ]
      }
    }
  };
}

/** The warn opt-in: a form with a formula that does not parse registers only under it (the default is fail). */
const WARN = { validation: { unknownFields: "strip", formulaErrors: "warn" } } as const;

function make() {
  const store = new InMemorySubmissionStore();
  let n = 0;
  return createSubmissionService({ store, validator: createKernelValidator(), ids: () => `rec-${++n}` });
}

describe("SubmissionService.inspect", () => {
  it("public: serves what publicDefinition serves, the secret rule gone and the registered definition untouched", async () => {
    const service = make();
    const definition = formWith({
      requiredWhen: { formula: "employed = true", run: "server-secret" },
      visibleWhen: { formula: "income > 0", run: "server" }
    });
    const before = JSON.stringify(definition);
    await service.register(definition);

    const answer = await service.inspect("apply-form@1", "public");
    expect(answer).toMatchObject({ ok: true, op: "public" });
    if (answer.op !== "public") {
      throw new Error("not a public answer");
    }
    expect(JSON.stringify(answer.definition)).toBe(JSON.stringify(await service.publicDefinition("apply-form@1")));
    expect(JSON.stringify(answer.definition)).not.toContain("server-secret");
    const reason = (answer.definition.root.children?.content ?? [])[2];
    expect(reason?.rules).toEqual({ visibleWhen: { formula: "income > 0", run: "server" } });
    expect(JSON.stringify((await service.getEntry("apply-form@1"))?.definition)).toBe(before);
  });

  it("check: the compile's problems with the policy, the server's setting over the form's own", async () => {
    const service = make();
    await expect(make().register(formWith({ value: "len(employed", visibleWhen: "regionOk(income)" }))).rejects.toMatchObject({ code: "invalid_definition" });
    await service.register(formWith({ value: "len(employed", visibleWhen: "regionOk(income)" }), WARN);
    const warned = await service.inspect("apply-form@1", "check");
    expect(warned).toMatchObject({ ok: true, op: "check", policy: "warn", verdict: "fail" }); // the server-run visibleWhen has a function nobody wired: the kernel refuses it under warn too
    if (warned.op !== "check") {
      throw new Error("not a check answer");
    }
    expect(warned.problems.map((problem) => `${problem.where}:${problem.code}`)).toEqual(["rules:reason:value:unclosedParen", "rules:reason:visibleWhen:unknownFunction"]);

    await service.updateSettings("apply-form@1", { validation: { formulaErrors: "fail" } });
    expect(await service.inspect("apply-form@1", "check")).toMatchObject({ policy: "fail", verdict: "fail" });

    const strict = make();
    await strict.register(formWith({ visibleWhen: "income > 0" }, { formulaErrors: "fail" }));
    expect(await strict.inspect("apply-form@1", "check")).toMatchObject({ ok: true, op: "check", problems: [], warnings: [], policy: "fail", structure: [], structureWarnings: [], verdict: "ok" });
  });

  it("inspect: the rules inventory with scopes, reads and the functions no built-in provides", async () => {
    const service = make();
    await service.register(
      formWith({
        requiredWhen: { formula: "employed = true and income > 1000", run: "server-secret" },
        visibleWhen: "not(empty(employed)) or regionOk(host.region)",
        defaultValue: 'upper("x")'
      }),
      WARN
    );
    const answer = await service.inspect("apply-form@1", "inspect");
    expect(answer).toEqual({
      ok: true,
      op: "inspect",
      rules: [
        { componentId: "reason", key: "requiredWhen", run: "server-secret", reads: ["employed", "income"], readsHost: false, readsClock: false, functions: [] },
        { componentId: "reason", key: "visibleWhen", run: "both", reads: ["employed"], readsHost: true, readsClock: false, functions: ["empty", "regionOk"] },
        { componentId: "reason", key: "defaultValue", run: "browser", reads: [], readsHost: false, readsClock: false, functions: ["upper"] }
      ],
      functionsUsed: ["empty", "regionOk", "upper"],
      pluginsNeeded: ["regionOk"],
      // Every value path the kernel reads.
      paths: [
        { path: "employed", componentId: "employed", type: "checkbox", holdsData: true },
        { path: "income", componentId: "income", type: "number", holdsData: true },
        { path: "reason", componentId: "reason", type: "text", holdsData: true }
      ]
    });
  });

  it("refuses an unknown form and an op of no shape, and the route is on the map", async () => {
    const service = make();
    await expect(service.inspect("none@1", "public")).rejects.toMatchObject({ code: "unknown_form" });
    await service.register(formWith({}));
    await expect(service.inspect("apply-form@1", "nope" as InspectOp)).rejects.toMatchObject({ code: "bad_document" });
    expect(statusOf({ code: "bad_document" })).toBe(400);
    const route = SUBMISSION_ROUTES.find((one) => one.operation === "inspect");
    expect(route).toMatchObject({ method: "GET", path: "/api/forms/:key/inspect" });
    expect(route?.summary).toContain("?op=public|check|inspect");
  });
});
