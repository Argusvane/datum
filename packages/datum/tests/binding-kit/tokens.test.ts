import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { KIT, load } from "./load.js";

const tokens = () => load(join(KIT, "tokens.mjs"));
const units = () => load(join(KIT, "lib", "token-units.mjs"));

const contract = (over: object = {}) => ({
  generatedFrom: { package: "@ds/tokens", version: "1.0.0" },
  tokens: [{ name: "--ds-text", unit: "color" }, { name: "--ds-gap", unit: "rem" }],
  ...over
});

describe("token contract", () => {
  it("validates the contract file", async () => {
    const { contractProblems } = await tokens();
    expect(contractProblems(contract())).toEqual([]);
    expect(contractProblems(contract({ generatedFrom: {} })).join()).toMatch(/generatedFrom/);
    expect(contractProblems(contract({ tokens: [{ name: "gap", unit: "rem" }] })).join()).toMatch(/not a custom property/);
    expect(contractProblems(contract({ tokens: [{ name: "--a", unit: "em" }] })).join()).toMatch(/unit/);
    expect(contractProblems(contract({ tokens: [{ name: "--a", unit: "px" }, { name: "--a", unit: "px" }] })).join()).toMatch(/twice/);
    expect(contractProblems(contract({ inferred: [{ name: "pdf.margin", reason: "a guess" }] })).join()).toMatch(/INFERRED/);
  });

  it("reads var() uses and the release's declarations", async () => {
    const { varsUsed, declarationsOf } = await tokens();
    expect([...varsUsed(".a { color: var(--ds-text, #000); margin: var( --ds-gap ) }")].sort()).toEqual(["--ds-gap", "--ds-text"]);
    expect(declarationsOf(":root { --ds-text: #333; --ds-gap: 1.25rem; --ds-alias: var(--ds-gap) }")).toEqual({ "--ds-text": "#333", "--ds-gap": "1.25rem", "--ds-alias": "var(--ds-gap)" });
  });

  it("checks each listed token against the release's CSS", async () => {
    const { checkContract } = await tokens();
    const release = [":root { --ds-text: #333; --ds-gap: 1.25rem }"];
    expect(checkContract({ contract: contract(), sources: [".a { color: var(--ds-text); gap: var(--ds-gap) }"], releaseCss: release })).toEqual([]);
    // read but not listed
    expect(checkContract({ contract: contract(), sources: ["var(--ds-text) var(--ds-gap) var(--ds-extra)"], releaseCss: [...release, ":root{--ds-extra: 3px}"] }).join()).toMatch(/--ds-extra .* does not list it/);
    // listed but unused, and not declared by the release
    const problems = checkContract({ contract: contract({ tokens: [{ name: "--ds-text", unit: "color" }, { name: "--ds-gone", unit: "px" }] }), sources: ["var(--ds-text)"], releaseCss: release }).join();
    expect(problems).toMatch(/--ds-gone is listed .* nothing reads it/);
    expect(problems).toMatch(/--ds-gone is not declared by the pinned release/);
    // a unit that is not what the release writes (followed through var())
    expect(checkContract({ contract: contract({ tokens: [{ name: "--ds-gap", unit: "px" }, { name: "--ds-text", unit: "color" }] }), sources: ["var(--ds-gap) var(--ds-text)"], releaseCss: [":root { --ds-base: 1rem; --ds-gap: var(--ds-base); --ds-text: #333 }"] }).join()).toMatch(/--ds-gap: tokens.json says px, the release's value "var\(--ds-base\)" is rem/);
  });

  it("converts px, rem and pt to points and refuses everything else", async () => {
    const { lengthToPt, TokenUnitError, missingTokens, unitOf } = await units();
    expect(lengthToPt("12pt")).toBe(12);
    expect(lengthToPt("16px")).toBe(12);
    expect(lengthToPt("1.5rem")).toBe(18);
    expect(lengthToPt("1rem", { remPt: 15 })).toBe(15);
    for (const bad of ["2em", "50%", "10vw", "calc(1rem + 2px)", "var(--x)", "auto", "#fff"]) expect(() => lengthToPt(bad, { token: "--t" }), bad).toThrow(TokenUnitError);
    expect(() => lengthToPt("2em", { token: "--ds-gap" })).toThrow(/--ds-gap/);
    expect(unitOf("#fff")).toBe("color");
    expect(unitOf("1.25rem")).toBe("rem");
    expect(unitOf('"Noto Sans", sans-serif')).toBe("font-family");
    expect(missingTokens(contract(), (name: string) => (name === "--ds-text" ? "#333" : ""))).toEqual(["--ds-gap"]);
  });
});
