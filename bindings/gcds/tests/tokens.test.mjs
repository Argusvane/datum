// The token contract's test, on GCDS: every var() this package's src/, print/ and pdf/ read is
// listed in tokens.json with the unit the pinned release writes it in, and nothing listed is unread
// or undeclared. Run with `node --test tests/tokens.test.mjs` (or `npm run test:tokens`). The negative
// cases prove the check can fail: an unlisted token, a wrong unit, a token the release lacks, a PDF
// length in a unit the converter refuses.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkBindingTokens, checkContract, loadTokenContract, TokenUnitError, lengthToPt } from "../../../packages/datum/binding-kit/tokens.mjs";
import { resolveBinding } from "../../../packages/datum/binding-kit/lib/binding-package.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = resolveBinding(root);

test("tokens.json holds against the pinned release", () => {
  const result = checkBindingTokens(pkg);
  assert.equal(result.applicable, true);
  assert.deepEqual(result.problems, []);
  assert.ok(result.contract.tokens.length > 100);
});

test("every inferred value says it is inferred, outside the generated block", () => {
  const contract = loadTokenContract(join(root, "tokens.json"));
  assert.ok(contract.inferred.length > 0);
  for (const entry of contract.inferred) assert.match(entry.reason, /^INFERRED/);
  assert.equal(contract.generatedFrom.version, "1.6.0");
});

const sources = ["src", "print", "pdf"].flatMap((folder) => readdirSync(join(root, folder)).filter((name) => /\.(ts|mjs)$/.test(name)).map((name) => readFileSync(join(root, folder, name), "utf8")));
const releaseCss = [readFileSync(join(root, "node_modules/gcds-tokens-1.6.0/build/web/css/tokens.css"), "utf8")];
const contract = loadTokenContract(join(root, "tokens.json"));

test("a token read and not listed fails", () => {
  const trimmed = { ...contract, tokens: contract.tokens.filter((entry) => entry.name !== "--gcds-input-padding") };
  assert.match(checkContract({ contract: trimmed, sources, releaseCss }).join("\n"), /--gcds-input-padding is read by the binding/);
});

test("a wrong unit fails", () => {
  const wrong = { ...contract, tokens: contract.tokens.map((entry) => (entry.name === "--gcds-input-padding" ? { ...entry, unit: "px" } : entry)) };
  assert.match(checkContract({ contract: wrong, sources, releaseCss }).join("\n"), /--gcds-input-padding: tokens.json says px/);
});

test("a listed token the release does not declare fails", () => {
  const extra = { ...contract, tokens: [...contract.tokens, { name: "--gcds-not-a-token", unit: "rem" }] };
  assert.match(checkContract({ contract: extra, sources: [...sources, "var(--gcds-not-a-token)"], releaseCss }).join("\n"), /--gcds-not-a-token is not declared by the pinned release/);
});

test("the PDF converter takes px, rem and pt only", () => {
  assert.equal(lengthToPt("1rem", { remPt: 12 }), 12);
  assert.equal(lengthToPt("16px"), 12);
  assert.throws(() => lengthToPt("1.5em"), TokenUnitError);
  assert.throws(() => lengthToPt("calc(1rem + 2px)"), TokenUnitError);
});
