import { builtProgramText, wrapEntryPoint } from "./programs.js";

/**
 * Programs for the DEF vectors' tests: the program built from source with its `__datum_inspect`
 * answer post-processed, each one breaking one promise the DEF rows check.
 *
 * - {@link withoutStructure}: `check` answers lose the structure pass (`structure`,
 *   `structureWarnings`, `limits`, `error.where`, `error.limit`), with the verdict decided by the
 *   problems alone: every row that needs the pass must FAIL.
 */
const STRIP_STRUCTURE = `function (original) {
  return function (text) {
    var out = original(text);
    var answer;
    try { answer = JSON.parse(out); } catch (error) { return out; }
    if (answer && answer.ok === true && answer.op === "check") {
      if (answer.problems && answer.problems.length === 0) { answer.verdict = "ok"; }
      delete answer.structure; delete answer.structureWarnings; delete answer.limits;
    }
    if (answer && answer.ok === false && answer.error) { delete answer.error.where; delete answer.error.limit; }
    return JSON.stringify(answer);
  };
}`;

/** The program's `__datum_inspect` replaced by `wrapper(original)` (the entry points cannot be reassigned from outside the program). */
const inspectWrapped = (text: string, wrapper: string): string => wrapEntryPoint(text, "__datum_inspect", wrapper);

export function withoutStructure(): string {
  return inspectWrapped(builtProgramText(), STRIP_STRUCTURE);
}

/** A program whose `public` op serves the definition whole (secrets included): DEF-09 must fail. */
export function publicServesSecrets(): string {
  return inspectWrapped(
    builtProgramText(),
    `function (original) {
  return function (text) {
    var request;
    try { request = JSON.parse(text); } catch (error) { return original(text); }
    if (request && request.op === "public" && request.definition && request.definition.root) {
      return JSON.stringify({ ok: true, op: "public", definition: request.definition });
    }
    return original(text);
  };
}`
  );
}

/** A program whose inspect throws on a request holding an own "__proto__" key: DEF-07 must fail. */
export function throwsOnProto(): string {
  return inspectWrapped(
    builtProgramText(),
    `function (original) {
  return function (text) {
    if (String(text).indexOf('"__proto__"') >= 0) { throw new Error("cannot read property of undefined"); }
    return original(text);
  };
}`
  );
}

/** A program whose `check` answers 10,000 structure problems for a many-duplicates definition: DEF-13 must fail. */
export function unboundedProblems(): string {
  return inspectWrapped(
    builtProgramText(),
    `function (original) {
  return function (text) {
    if (String(text).length > 100000 && String(text).indexOf('"op":"check"') >= 0) {
      var list = [];
      for (var i = 0; i < 10000; i += 1) { list.push({ code: "component.id.duplicate", where: "root > content > dup" }); }
      return JSON.stringify({ ok: true, op: "check", problems: [], warnings: [], policy: "fail", structure: list, structureWarnings: [], verdict: "fail" });
    }
    return original(text);
  };
}`
  );
}
