import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseSimulatedOptions } from "../form-engine/builder/controller/simulated-options.js";
import { BuilderWords } from "../form-engine/builder/logic/builder-texts.js";
import { MAX_IMPORTED_OPTIONS, MAX_IMPORTED_OPTIONS_BYTES } from "../form-engine/core/schema/inline-options.js";

/**
 * A stand-in option list as the Settings panel reads it, from the module the shell and
 * the browser-assistant tools share (`try_it { action: 'settings' }`): the same
 * caps as an options file, the same messages, the same shapes.
 */

const words = new BuilderWords();
const TOO_LARGE = `The list is too large: at most ${MAX_IMPORTED_OPTIONS} options and 2 MiB.`;

describe("parseSimulatedOptions", () => {
  it("reads one option a line, value | label, the label optional", () => {
    expect(parseSimulatedOptions("on | Ontario\n\n  qc|Québec  \nab", words)).toEqual([
      { value: "on", label: "Ontario" },
      { value: "qc", label: "Québec" },
      { value: "ab", label: "ab" }
    ]);
    // A bar with nothing after it labels the option with its value.
    expect(parseSimulatedOptions("nb |", words)).toEqual([{ value: "nb", label: "nb" }]);
  });

  it("reads a JSON list of strings or { value, label }, a localized label kept as authored", () => {
    const label = { default: "Ontario", locales: { fr: "Ontario (fr)" } };
    expect(parseSimulatedOptions(JSON.stringify(["a", { value: 2, label: "Two" }, { value: "on", label }, { value: "x" }]), words)).toEqual([
      { value: "a", label: "a" },
      { value: "2", label: "Two" },
      { value: "on", label },
      { value: "x", label: "x" }
    ]);
  });

  it("takes exactly 2,000 options, and refuses 2,001 lines or JSON entries with the cap's message", () => {
    const lines = (count: number): string => Array.from({ length: count }, (_, index) => `v${index}`).join("\n");
    expect(parseSimulatedOptions(lines(MAX_IMPORTED_OPTIONS), words)).toHaveLength(MAX_IMPORTED_OPTIONS);
    expect(parseSimulatedOptions(lines(MAX_IMPORTED_OPTIONS + 1), words)).toBe(TOO_LARGE);
    const json = (count: number): string => JSON.stringify(Array.from({ length: count }, (_, index) => ({ value: `v${index}` })));
    expect(parseSimulatedOptions(json(MAX_IMPORTED_OPTIONS), words)).toHaveLength(MAX_IMPORTED_OPTIONS);
    expect(parseSimulatedOptions(json(MAX_IMPORTED_OPTIONS + 1), words)).toBe(TOO_LARGE);
  });

  it("refuses more than 2 MiB of text before reading it, and takes 2 MiB exactly", () => {
    expect(MAX_IMPORTED_OPTIONS_BYTES).toBe(2 * 1024 * 1024);
    expect(parseSimulatedOptions("x".repeat(MAX_IMPORTED_OPTIONS_BYTES + 1), words)).toBe(TOO_LARGE);
    // One long line under the byte cap is one option, not a refusal.
    expect(parseSimulatedOptions("x".repeat(MAX_IMPORTED_OPTIONS_BYTES), words)).toEqual([{ value: "x".repeat(MAX_IMPORTED_OPTIONS_BYTES), label: "x".repeat(MAX_IMPORTED_OPTIONS_BYTES) }]);
  });

  it("says what is wrong with a JSON list it cannot use", () => {
    expect(parseSimulatedOptions("[1, 2", words)).toBe("The JSON could not be read.");
    expect(parseSimulatedOptions('[{ "label": "No value" }]', words)).toBe("Each entry needs a value.");
    // Read as JSON only when it opens a list: an object is read as one line.
    expect(parseSimulatedOptions('{"value":"a"}', words)).toEqual([{ value: '{"value":"a"}', label: '{"value":"a"}' }]);
  });

  it("words its messages in the builder's language through the host's catalog", () => {
    const french = new BuilderWords();
    french.locale = "fr";
    french.catalog = { fr: { "settings.sources.tooLarge": "Liste trop longue : {max} options au plus." } };
    expect(parseSimulatedOptions(Array.from({ length: MAX_IMPORTED_OPTIONS + 1 }, () => "v").join("\n"), french)).toBe(`Liste trop longue : ${MAX_IMPORTED_OPTIONS} options au plus.`);
  });

  it("lives below the shell: the module imports nothing from the web components", () => {
    const source = readFileSync(join(import.meta.dirname, "..", "form-engine", "builder", "controller", "simulated-options.ts"), "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    expect(imports.some((path) => path!.includes("web-component"))).toBe(false);
    expect(imports.some((path) => path!.includes("/agent/"))).toBe(false);
  });
});
