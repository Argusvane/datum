// The two server hosts pin one engine module: runtime.json (this host) and the qjs.* properties of the JVM host's
// datum-sandbox-endive pom must name the same quickjs-ng release, sha256 and size, and pin-runtime.mjs writes both by default.
// Run: node --test integrations/fastapi/scripts/tests
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FASTAPI_PIN, JVM_POM, parseArgs, pinDifferences, readJvmPin, readPins } from "../../../shared/scripts/pin-runtime.mjs";

test("runtime.json and the JVM pom pin the same qjs-wasi.wasm: version, sha256 and size", () => {
  const pins = readPins();
  assert.deepEqual(pinDifferences(pins), []);
  assert.match(pins.fastapi.sha256, /^[0-9a-f]{64}$/);
  assert.ok(Number.isInteger(pins.fastapi.size) && pins.fastapi.size > 0);
  assert.match(pins.fastapi.version, /^\d+\.\d+\.\d+$/);
});

test("a pom pin that differs in any field fails, naming the field", () => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-pins-"));
  try {
    const pom = readFileSync(JVM_POM, "utf8");
    const { sha256, size, version } = readJvmPin();
    const edits = {
      sha256: pom.replace(`<qjs.sha256>${sha256}</qjs.sha256>`, `<qjs.sha256>${"0".repeat(64)}</qjs.sha256>`),
      size: pom.replace(`<qjs.size>${size}</qjs.size>`, `<qjs.size>${size + 1}</qjs.size>`),
      version: pom.replace(`<qjs.version>${version}</qjs.version>`, "<qjs.version>0.0.1</qjs.version>")
    };
    for (const [field, edited] of Object.entries(edits)) {
      assert.notEqual(edited, pom, field);
      const path = join(dir, `${field}.xml`);
      writeFileSync(path, edited);
      const problems = pinDifferences(readPins({ jvm: path }));
      assert.equal(problems.length, 1, `${field}: ${problems.join("; ")}`);
      assert.match(problems[0], new RegExp(`^${field}: `));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a runtime.json that differs, or a pin that leaves a field out, fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-pins-"));
  try {
    const pin = JSON.parse(readFileSync(FASTAPI_PIN, "utf8"));
    const other = join(dir, "other.json");
    writeFileSync(other, JSON.stringify({ ...pin, sha256: "f".repeat(64) }));
    assert.match(pinDifferences(readPins({ fastapi: other })).join("\n"), /^sha256: /);
    const noSize = join(dir, "no-size.json");
    const { size: _size, ...rest } = pin;
    writeFileSync(noSize, JSON.stringify(rest));
    assert.match(pinDifferences(readPins({ fastapi: noSize })).join("\n"), /^size: .*both must name it/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pin-runtime.mjs writes both pins unless one target is named", () => {
  assert.equal(parseArgs([]).target, "all");
  assert.equal(parseArgs(["v0.16.2"]).target, "all");
  assert.equal(parseArgs(["--target", "jvm", "v0.16.2"]).target, "jvm");
  assert.equal(parseArgs(["--target=fastapi"]).target, "fastapi");
  assert.throws(() => parseArgs(["--target", "python"]), /--target must be jvm, fastapi or all/);
  // The npm scripts name no target, so each writes both.
  const scripts = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "package.json"), "utf8")).scripts;
  for (const name of ["jvm:pin-runtime", "fastapi:pin-runtime"]) {
    assert.match(scripts[name], /pin-runtime\.mjs$/, name);
  }
});
