import { describe, expect, it } from "vitest";
import type { FormDefinition } from "@argusvane/datum-engine";

import { InMemorySubmissionStore, createKernelValidator, createSubmissionService, statusOf } from "../src/index.js";

/** `register` runs the kernel's structural check: a definition the gate cannot judge is refused at registration. */

const text = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: "text", configuration: {}, ...extra });
const form = (content: unknown[], extra: Record<string, unknown> = {}): FormDefinition =>
  ({ id: "f", version: "1", schemaVersion: "1", root: { id: "form", type: "form", configuration: {}, children: { content } }, ...extra }) as unknown as FormDefinition;
const make = () => createSubmissionService({ store: new InMemorySubmissionStore(), validator: createKernelValidator() });
const refusal = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error as { code?: string; message?: string });

describe("register refuses a definition whose structure the kernel refuses", () => {
  it("repeated ids: invalid_definition, 422, nothing stored", async () => {
    const service = make();
    const error = await refusal(service.register(form([text("dup"), text("dup")])));
    expect(error).toMatchObject({ code: "invalid_definition" });
    expect(error?.message).toContain("component.id.duplicate at root > content > dup");
    expect(statusOf(error as never)).toBe(422);
    expect(await service.listCatalog()).toEqual([]);
  });

  it("a definition 33 levels deep is a 422 and not a thrown Error", async () => {
    let leaf: Record<string, unknown> = text("leaf");
    for (let level = 0; level < 33; level += 1) {
      leaf = { id: `c${level}`, type: "container", configuration: {}, children: { content: [leaf] } };
    }
    const error = await refusal(make().register(form([leaf])));
    expect(error).toMatchObject({ code: "invalid_definition" });
    expect(error?.message).toContain("nest more than 32 levels");
    expect(statusOf(error as never)).toBe(422);
  });

  it("a definition that is not an object is invalid_definition", async () => {
    expect(await refusal(make().register(null as never))).toMatchObject({ code: "invalid_definition" });
    expect(await refusal(make().register({ id: "f", version: "1", schemaVersion: "1" } as never))).toMatchObject({ code: "invalid_definition" });
  });

  it("two fields in one stored place, and a malformed journey, are refused", async () => {
    const service = make();
    expect(await refusal(service.register(form([text("a", { configuration: { dataKey: "k" } }), text("b", { configuration: { dataKey: "k" } })])))).toMatchObject({ code: "invalid_definition" });
    expect(await refusal(service.register(form([text("a")], { journey: { journeys: [{ id: "j", pages: "x" }] } })))).toMatchObject({ code: "invalid_definition" });
  });
});

describe("register keeps what the kernel only warns of", () => {
  it("stores the form and lists the structure warnings on the entry", async () => {
    const service = make();
    const entry = await service.register(
      form([text("a"), { id: "x", type: "mystery", configuration: {} }], { journey: { journeys: [{ id: "j", pages: [{ id: "p", components: ["a", "ghost"], routes: [{ to: "nowhere" }] }] }] } }),
      undefined,
      { componentTypes: ["text"] }
    );
    expect(entry.structureWarnings?.map((problem) => `${problem.code}@${problem.where}`)).toEqual([
      "component.type.unknown@root > content > x",
      "journey.page.unknownComponent@journey:j:page:p",
      "journey.route.unknownTarget@journey:j:page:p:route:0"
    ]);
    expect((await service.listCatalog())[0]?.structureWarnings).toHaveLength(3);
  });

  it("a clean form has no structureWarnings key", async () => {
    const entry = await make().register(form([text("a")]));
    expect("structureWarnings" in entry).toBe(false);
  });
});

describe("inspect(check) carries the structure members", () => {
  it("structure, structureWarnings and limits ride in the answer", async () => {
    const service = make();
    await service.register(form([text("a")]));
    const answer = await service.inspect("f@1", "check");
    expect(answer).toMatchObject({ ok: true, op: "check", structure: [], structureWarnings: [], verdict: "ok", limits: { components: 10000 } });
  });
});

describe("a secret value where no server scope is allowed is not served by the catalog (SEC-06)", () => {
  it("listCatalog and publicDefinition lack the text, listCatalogFull keeps it", async () => {
    const secret = { formula: 'a = "ZZ_REG_SECRET_3301"', run: "server-secret" };
    const service = make();
    await service.register(form([text("a")], { journey: { journeys: [{ id: "j", pages: [{ id: "p", components: ["a"], routes: [{ to: "$end", when: secret }] }] }] } }), { validation: { formulaErrors: "warn" } } as never);
    expect(JSON.stringify(await service.listCatalog())).not.toContain("ZZ_REG_SECRET_3301");
    expect(JSON.stringify(await service.publicDefinition("f@1"))).not.toContain("ZZ_REG_SECRET_3301");
    expect(JSON.stringify(await service.listCatalogFull())).toContain("ZZ_REG_SECRET_3301");
  });
});
