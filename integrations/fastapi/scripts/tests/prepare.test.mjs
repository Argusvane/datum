// The fresh-clone preparation: the steps run in the order the generated resources need, each step's failure stops it with the
// step named, and a missing uv is reported before anything is built. Run: node --test integrations/fastapi/scripts/tests
import assert from "node:assert/strict";
import { test } from "node:test";

import { UNITS, main, steps } from "../prepare.mjs";
import { units } from "../../../../scripts/setup.mjs";

const recorder = (failAt = -1, missingUv = false) => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args].join(" "));
    if (command === "uv" && args[0] === "--version") {
      return missingUv ? { error: new Error("ENOENT"), status: null } : { status: 0 };
    }
    return { status: calls.filter((call) => !call.startsWith("uv --version")).length - 1 === failAt ? 3 : 0 };
  };
  return { calls, run };
};

test("the steps run installs, the bundles, the conformance commands, the assets, the sync and the schema, in that order", () => {
  const labels = steps().map((step) => step.label);
  assert.deepEqual(labels, [
    "install the JavaScript units",
    "build the datum bundles",
    "build the conformance suite commands",
    "build the generated resources",
    "sync the Python workspace",
    "write the settings schema"
  ]);
});

test("every unit it installs is a unit of the root setup script, installed in its dependency order", () => {
  const all = units();
  for (const unit of UNITS) assert.ok(all.includes(unit), unit);
  const positions = UNITS.map((unit) => all.indexOf(unit));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.ok(UNITS.indexOf("packages/submissions") < UNITS.indexOf("packages/conformance-suite"));
});

test("a run executes every step and reports ready", () => {
  const { calls, run } = recorder();
  const logs = [];
  assert.equal(main({ run, log: (line) => logs.push(line), error: () => {} }), 0);
  assert.equal(calls.length, 1 + steps().length);
  assert.match(logs.at(-1), /ready/);
});

test("a failing step stops the run, names the step and passes its exit status on", () => {
  const { calls, run } = recorder(2);
  const errors = [];
  assert.equal(main({ run, log: () => {}, error: (line) => errors.push(line) }), 3);
  assert.equal(calls.length, 1 + 3, "nothing after the failed step ran");
  assert.match(errors[0], /build the conformance suite commands/);
});

test("a missing uv is reported before any step runs", () => {
  const { calls, run } = recorder(-1, true);
  const errors = [];
  assert.equal(main({ run, log: () => {}, error: (line) => errors.push(line) }), 1);
  assert.equal(calls.length, 1);
  assert.match(errors[0], /uv is not on the PATH/);
});
