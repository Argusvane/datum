import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { FIXTURE_FORM } from "@argusvane/datum-engine/testing";

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "../a11y/form.json");

describe("the canonical fixture form", () => {
  it("is what the browser accessibility audit renders: a11y/form.json is the engine's fixture, byte for byte", () => {
    const copy = JSON.parse(readFileSync(FIXTURE, "utf8")) as unknown;
    expect(copy).toEqual(FIXTURE_FORM);
  });
});
