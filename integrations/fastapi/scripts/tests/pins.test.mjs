// The pin test: every sibling "==" pin equals the member it names, and editing one pin fails the check.
// Run: node --test integrations/fastapi/scripts/tests
import assert from "node:assert/strict";
import { test } from "node:test";

import { VERSION_PATTERN, findPins, pinProblems, readMembers, rewritePins } from "../release-lib.mjs";

test("every member has a static version and every sibling pin equals the member it names", () => {
  const members = readMembers();
  assert.equal(members.length, 8);
  assert.deepEqual(pinProblems(members), []);
});

test("the fastapi member pins at least its own core, and the pins really are read", () => {
  const pins = readMembers().flatMap((member) => findPins(member.text));
  assert.ok(pins.length >= 10, `only ${pins.length} pins found`);
  assert.ok(pins.some((pin) => pin.name === "argusvane-datum-core" && pin.extras === "[aio]"));
});

test("editing one pin makes the check fail, naming the pin", () => {
  const members = readMembers();
  const target = members.find((member) => findPins(member.text).length > 0);
  const first = findPins(target.text)[0];
  const edited = target.text.replace(`${first.name}${first.extras}==${first.version}`, `${first.name}${first.extras}==${first.version}.1`);
  assert.notEqual(edited, target.text);
  const problems = pinProblems(members.map((member) => (member === target ? { ...member, text: edited } : member)));
  assert.equal(problems.length, 1);
  assert.match(problems[0], new RegExp(`${target.name}: pins ${first.name}`));
});

test("editing one member's version fails every pin that names it", () => {
  const members = readMembers();
  const bumped = members.map((member) => (member.name === "argusvane-datum-core" ? { ...member, version: "9.9.9" } : member));
  const problems = pinProblems(bumped);
  assert.ok(problems.some((problem) => /disagree/.test(problem)));
  assert.ok(problems.some((problem) => /pins argusvane-datum-core.*but argusvane-datum-core is 9\.9\.9/.test(problem)));
});

test("rewritePins sets every sibling pin and leaves third-party pins and extras references alone", () => {
  const names = ["argusvane-datum-core", "argusvane-datum-fastapi"];
  const text = 'dependencies = ["argusvane-datum-core[aio]==0.1.0", "pydantic==2.0", "argusvane-datum-fastapi[ui]", "other==1.0"]\nx = ["argusvane-datum-core==0.1.0"]';
  const out = rewritePins(text, names, "0.2.0.dev1");
  assert.equal(out, 'dependencies = ["argusvane-datum-core[aio]==0.2.0.dev1", "pydantic==2.0", "argusvane-datum-fastapi[ui]", "other==1.0"]\nx = ["argusvane-datum-core==0.2.0.dev1"]');
  assert.deepEqual(findPins(out).map((pin) => pin.version), ["0.2.0.dev1", "0.2.0.dev1"]);
});

test("pinProblems with an expected version names every member that is not at it", () => {
  const members = readMembers();
  const problems = pinProblems(members, "9.9.9");
  for (const member of members) {
    assert.ok(problems.some((problem) => problem.startsWith(`${member.name}: version ${member.version}, expected 9.9.9`)), member.name);
  }
});

test("a pin naming a non-member and a member without a static version are reported", () => {
  const members = readMembers();
  const target = members[0];
  const withStray = members.map((member) => (member === target ? { ...member, text: `${member.text}\n"argusvane-datum-other==1.0"` } : member));
  assert.ok(pinProblems(withStray).some((problem) => problem === `${target.name}: pins argusvane-datum-other, which is not a member`));
  const withoutVersion = members.map((member) => (member === target ? { ...member, version: undefined } : member));
  assert.ok(pinProblems(withoutVersion).some((problem) => problem === `${target.name}: no static [project] version`));
});

test("rewritePins leaves a pin on a non-member that matches the pin pattern alone", () => {
  const text = 'x = ["argusvane-datum-other==1.0", "argusvane-datum-core==1.0"]';
  assert.equal(rewritePins(text, ["argusvane-datum-core"], "2.0"), 'x = ["argusvane-datum-other==1.0", "argusvane-datum-core==2.0"]');
});

test("VERSION_PATTERN accepts publishable PEP 440 versions and refuses epochs, local parts and non-PEP 440 spellings", () => {
  for (const ok of ["0.1.0", "0.1.0rc1", "0.0.1.dev0", "1.0.post1"]) {
    assert.ok(VERSION_PATTERN.test(ok), ok);
  }
  for (const bad of ["1!0.1", "0.1+local", "v0.1", "0.1.0-rc1"]) {
    assert.ok(!VERSION_PATTERN.test(bad), bad);
  }
});
