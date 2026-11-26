import { afterEach, describe, expect, it } from "vitest";
import "../src/form.js";
import type { DatumFormElement } from "../src/form.js";
import { sampleDefinition } from "./helpers.js";

const LIMIT = 65_536;
const bytesOf = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

afterEach(async () => {
  document.body.innerHTML = "";
  await new Promise((resolve) => setTimeout(resolve, 30));
});

async function mount(id?: string): Promise<DatumFormElement> {
  const element = document.createElement("datum-form") as DatumFormElement;
  element.setAttribute("features", "all agent");
  element.setAttribute("agent-access", "always");
  if (id !== undefined) {
    element.id = id;
  }
  element.definition = sampleDefinition();
  document.body.append(element);
  await element.ready;
  await element.agentTools();
  return element;
}

describe("form agent results stay under the cap", () => {
  it("an unknown answers key of 200 000 characters answers a refusal under the cap", async () => {
    const element = await mount();
    const result: any = await element.executeAgentTool("set_answers", { answers: { ["k".repeat(200_000)]: 1 } });
    expect(result.ok).toBe(false);
    expect(typeof result.code).toBe("string");
    expect(bytesOf(result)).toBeLessThanOrEqual(LIMIT);
  });

  it("an element id of 70 000 characters is not taken as a handle, so the listing stays under the cap", async () => {
    const first = await mount();
    const second = await mount("x".repeat(70_000));
    const listing: any = await first.executeAgentTool("describe_form", {});
    expect(Array.isArray(listing.forms)).toBe(true);
    expect(listing.forms).toHaveLength(2);
    expect(bytesOf(listing)).toBeLessThanOrEqual(LIMIT);
    const handles: string[] = listing.forms.map((row: { form: string }) => row.form);
    expect(handles.every((handle) => handle.length <= 128)).toBe(true);
    expect(new Set(handles).size).toBe(2);
    const routed: any = await second.executeAgentTool("describe_form", { form: handles[1] });
    expect(routed.ok).toBe(true);
  });
});
