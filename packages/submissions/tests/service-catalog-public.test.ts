import { describe, expect, it } from "vitest";
import type { ComponentNode, FormDefinition } from "@argusvane/datum-engine";

import { InMemorySubmissionStore, SUBMISSION_ROUTES, createKernelValidator, createSubmissionService } from "../src/index.js";

/**
 * The catalog listing a route can serve carries the public copy of each form, never
 * a `server-secret` rule, its formula text in a problem, or the registered option rows. The
 * registering host reads the entries whole through `listCatalogFull`.
 */

const LIT = "ZZ_SECRET_LITERAL_7731";
const ROW = "ZZ_SNAPSHOT_ROW_5520";
const secret = (formula: string) => ({ formula, run: "server-secret" as const });

function form(): FormDefinition {
  const node = (id: string, rules: Record<string, unknown>): ComponentNode => ({ id, type: "text", configuration: { label: id }, rules: rules as NonNullable<ComponentNode["rules"]> });
  return {
    id: "cat",
    version: "1",
    schemaVersion: "1",
    root: {
      id: "form",
      type: "form",
      configuration: { title: "Catalog" },
      children: {
        content: [
          { id: "gate", type: "text", configuration: {} },
          { id: "city", type: "select", configuration: { data: { sourceId: "cities" } } },
          node("ok", { requiredWhen: secret(`gate = "${LIT}-ok"`) }),
          // does not parse: its problem is stored on the entry with the text
          node("broken", { requiredWhen: secret(`gate = "${LIT}-broken" and (`) }),
          node("shown", { visibleWhen: "gate = 1 and (" })
        ]
      }
    }
  };
}

// The form holds formulas that do not parse on purpose: it registers only under the warn opt-in
// (the default is fail).
async function setup() {
  const service = createSubmissionService({ store: new InMemorySubmissionStore(), validator: createKernelValidator() });
  await service.register(form(), { validation: { unknownFields: "strip", formulaErrors: "warn", optionSnapshot: { cities: [{ value: ROW }] } } });
  return service;
}

describe("the service's catalog listing", () => {
  it("serves the public copy: no secret rule, no secret text in a problem, no option rows", async () => {
    const service = await setup();
    const listed = await service.listCatalog();
    expect(listed).toHaveLength(1);
    const text = JSON.stringify(listed);
    expect(text).not.toContain(LIT);
    expect(text).not.toContain("server-secret");
    expect(text).not.toContain(ROW);
    // the form, its counts and the rest of its settings are all still there
    expect(listed[0]).toMatchObject({ key: "cat@1", title: "Catalog", counts: { accepted: 0, rejected: 0 }, settings: { validation: { unknownFields: "strip" } } });
    expect(listed[0]!.definition.root.children?.content?.map((child) => child.id)).toEqual(["gate", "city", "ok", "broken", "shown"]);
  });

  it("keeps the problem on a secret rule (where and code) and the whole problem on a rule that is not secret", async () => {
    const service = await setup();
    const problems = (await service.listCatalog())[0]!.formulaProblems!;
    expect(problems.find((problem) => problem.where === "rules:broken:requiredWhen")).toEqual({
      where: "rules:broken:requiredWhen",
      code: expect.any(String),
      message: expect.not.stringContaining(LIT)
    });
    expect(problems.find((problem) => problem.where === "rules:shown:visibleWhen")).toMatchObject({ text: "gate = 1 and (" });
  });

  it("listCatalogFull hands the registering host the entries exactly as registered", async () => {
    const service = await setup();
    const full = await service.listCatalogFull();
    const text = JSON.stringify(full);
    expect(text).toContain(`${LIT}-ok`);
    expect(text).toContain(`${LIT}-broken`);
    expect(text).toContain(ROW);
    expect(full[0]!.counts).toEqual({ accepted: 0, rejected: 0 });
    expect(full[0]).toEqual({ ...(await service.getEntry("cat@1")), counts: { accepted: 0, rejected: 0 } });
  });

  it("does not change what the store holds, and the verdict still enforces the secret rule", async () => {
    const service = await setup();
    await service.listCatalog();
    expect(JSON.stringify(await service.getEntry("cat@1"))).toContain(`${LIT}-ok`);
    const envelope = {
      versionContext: { form: { id: "cat", version: "1" }, client: { runtimeVersion: "1", rendererVersion: "1", schemaVersion: "1" } },
      submission: { locale: "en", values: { gate: `${LIT}-ok` } }
    };
    expect((await service.validate({ document: envelope })).errors.map((error) => error.componentId)).toContain("ok");
  });

  it("inspect(check) keeps where and code for a secret rule's problem and drops its text", async () => {
    const service = await setup();
    const answer = await service.inspect("cat@1", "check");
    expect(JSON.stringify(answer)).not.toContain(LIT);
    expect(answer).toMatchObject({ op: "check" });
    if (answer.op === "check") {
      expect(answer.problems.map((problem) => problem.where)).toEqual(["rules:broken:requiredWhen", "rules:shown:visibleWhen"]);
    }
  });

  it("the inspect route is marked operator-only in the route table, since its inventory names secret rules", () => {
    const route = SUBMISSION_ROUTES.find((candidate) => candidate.operation === "inspect")!;
    expect(route.summary.toLowerCase()).toContain("operator only");
  });

  it("the route table documents the listing as the public copy", () => {
    const route = SUBMISSION_ROUTES.find((candidate) => candidate.operation === "listCatalog")!;
    expect(route.summary.toLowerCase()).toContain("public");
    expect(route.responds).not.toContain("compiled");
  });
});
