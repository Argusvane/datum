// The member test runner's plan: the minutes-long members get an xdist bulk and a quiet marked pass, the rest one serial run,
// and the marker expressions of the two passes partition every test. Run: node --test integrations/fastapi/scripts/tests
import assert from "node:assert/strict";
import { test } from "node:test";

import { PARALLEL_MEMBERS, SERIAL_MARKERS, defaultWorkers, plan, readMemberNames } from "../test-members.mjs";

test("the workspace's members are read, and the parallel ones are among them", () => {
  const members = readMemberNames();
  assert.equal(members.length, 8);
  for (const member of PARALLEL_MEMBERS) assert.ok(members.includes(member), member);
});

test("a parallel member gets a bulk under xdist in phase 1 and its marked tests alone in phase 2", () => {
  const [first, second] = plan(["argusvane-datum-core"], 3);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.deepEqual(first[0].args.slice(0, 7), ["run", "--frozen", "--no-sync", "--package", "argusvane-datum-core", "pytest", "packages/argusvane-datum-core"]);
  assert.deepEqual(first[0].args.slice(7), ["-n", "3", "-m", `not (${SERIAL_MARKERS})`]);
  assert.deepEqual(second[0].args.slice(7), ["-p", "no:randomly", "-m", SERIAL_MARKERS]);
});

test("a small member runs once, serially, with no marker expression, and nothing of it in phase 2", () => {
  const [first, second] = plan(["argusvane-datum-programs"], 4);
  assert.deepEqual(first, [{ member: "argusvane-datum-programs", pass: "all", args: ["run", "--frozen", "--no-sync", "--package", "argusvane-datum-programs", "pytest", "packages/argusvane-datum-programs"] }]);
  assert.deepEqual(second, []);
});

test("the serial markers are the three the conftests keep off xdist workers", () => {
  assert.equal(SERIAL_MARKERS, "runtime or openssl or server");
});

test("the default worker count is half the cores and never below two", () => {
  assert.equal(defaultWorkers(8), 4);
  assert.equal(defaultWorkers(4), 2);
  assert.equal(defaultWorkers(1), 2);
});
