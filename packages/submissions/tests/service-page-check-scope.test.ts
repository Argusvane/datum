import { expect, it } from "vitest";
import { ServerValidationRunner, type FormDefinition } from "@argusvane/datum-engine";
import { InMemorySubmissionStore, createKernelValidator, createSubmissionService } from "../src/index.js";

// A page check hands the server's hooks only the answers of the pages
// up to and including the one checked, so a hook cannot read or echo a later page's answer.
const FORM = {
  id: "f", version: "1", schemaVersion: "1",
  root: { id: "form", type: "form", configuration: {}, children: { content: [
    { id: "name", type: "text", configuration: {} },
    { id: "middle", type: "text", configuration: {} },
    { id: "secret", type: "text", configuration: {} }
  ] } },
  journey: { journeys: [{ id: "j", pages: [
    { id: "a", components: ["name"] },
    { id: "b", components: ["middle"] },
    { id: "c", components: ["secret"], routes: [{ to: "$end" }] }
  ] }] }
} as unknown as FormDefinition;
const env = (values: object) => ({ versionContext: { form: { id: "f", version: "1" }, client: { runtimeVersion: "1", rendererVersion: "1", schemaVersion: "1" } }, submission: { locale: "en", journey: "j", values } });

it("a page check's hook sees the checked page's answers and the pages before it, not the pages after", async () => {
  const seen: Array<{ page?: string; values: Record<string, unknown> }> = [];
  const runner = new ServerValidationRunner([{ id: "h", version: "1", async validate(ctx: any) {
    seen.push({ page: ctx.scope?.pageId, values: { ...ctx.values } });
    return { errors: [{ code: "server.custom", parameters: { other: String(ctx.values.secret) }, message: "m", severity: "error", stage: "server", source: "server" }] } as never;
  } }]);
  const service = createSubmissionService({ store: new InMemorySubmissionStore(), validator: createKernelValidator(), ids: () => "r1", serverValidationRunner: runner });
  await service.register(FORM);
  const values = { name: "x", middle: "m", secret: "PAGE-C-SECRET" };
  const onA = await service.validate({ document: env(values) as never, scope: "page", pageId: "a" } as never);
  const onB = await service.validate({ document: env(values) as never, scope: "page", pageId: "b" } as never);
  expect(JSON.stringify(onA.errors)).not.toContain("PAGE-C-SECRET");
  expect(JSON.stringify(onB.errors)).not.toContain("PAGE-C-SECRET");
  // Judged as the whole journey, the hook sees every answer, as it always did.
  const whole = await service.validate({ document: env(values) as never, scope: "journey" } as never);
  expect(JSON.stringify(whole.errors)).toContain("PAGE-C-SECRET");
  expect(seen.slice(0, 2).map((s) => Object.keys(s.values).sort())).toEqual([["name"], ["middle", "name"]]);
});
