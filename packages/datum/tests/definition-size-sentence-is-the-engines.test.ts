import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/form.js";
import "../src/builder.js";
import type { DatumFormElement } from "../src/form.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import { bytesInWords, definitionSizeProblem } from "@argusvane/datum-engine";
import { until } from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

/*
 * A definition past `max-definition-bytes` is refused in one sentence, whichever route brought
 * it: the engine's, which the bar's Open uses too.
 */
describe("the sentence a definition past its cap is refused with", () => {
  const text = JSON.stringify({ id: "big", version: "1.0.0", schemaVersion: "1", root: { id: "root", type: "form", configuration: {}, children: { content: [] } }, pad: "x".repeat(4000) });

  it("is the engine's for a fetched src and for an Open, whole to the byte", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", async () => new Response(text, { status: 200, headers: { "content-type": "application/json" } }));
    const el = document.createElement("datum-form") as DatumFormElement;
    const heard: string[] = [];
    el.addEventListener("datum-error", (event) => heard.push((event as CustomEvent<{ message: string }>).detail.message));
    el.maxDefinitionBytes = 1000;
    document.body.append(el);
    el.src = "/forms/big.json";
    await until(() => heard.length > 0);
    const bytes = new TextEncoder().encode(text).length;
    // A fetched body is read only as far as the cap lets it, so its size is "over" what was read.
    expect(heard[0]).toMatch(/it is over \d+ KB; up to 1,000 bytes is read$/);
    expect(heard[0]).toContain(definitionSizeProblem(4096, 1000, true)!);

    const builder = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    builder.maxDefinitionBytes = 1000;
    document.body.append(builder);
    await until(() => builder.controller);
    expect(() => builder.fileActions.open!({ name: "big.json", text })).toThrow(definitionSizeProblem(bytes, 1000)!);
  });

  it("says the cap in whole units", () => {
    expect(bytesInWords(2 * 1024 * 1024)).toBe("2 MB");
    expect(bytesInWords(1000)).toBe("1,000 bytes");
  });
});
