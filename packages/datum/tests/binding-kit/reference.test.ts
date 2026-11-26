import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { KIT, REPO, load } from "./load.js";

const mod = () => load(join(KIT, "lib", "reference.mjs"));
const pkgMod = () => load(join(KIT, "lib", "binding-package.mjs"));

const file = (meta: object, html = "<form></form>") => `<!-- datum-reference\n${JSON.stringify(meta)}\n-->\n${html}`;

describe("reference files", () => {
  it("parses the leading comment and keeps the markup", async () => {
    const { parseReference } = await mod();
    const parsed = parseReference(file({ source: "a template", components: [{ id: "a", type: "text", configuration: {} }], root: "form" }, "<form><input></form>"), "c1");
    expect(parsed.problems).toEqual([]);
    expect(parsed.meta.root).toBe("form");
    expect(parsed.html).toBe("<form><input></form>");
  });

  it("says what is wrong with a file", async () => {
    const { parseReference } = await mod();
    expect(parseReference("<form></form>", "x").problems[0]).toMatch(/no leading/);
    expect(parseReference("<!-- datum-reference { nope -->", "x").problems[0]).toMatch(/not JSON/);
    expect(parseReference(file({ components: [] }), "x").problems.join()).toMatch(/"source" is required/);
    expect(parseReference(file({ source: "s" }), "x").problems.join()).toMatch(/components/);
    expect(parseReference(file({ source: "s", components: [], ignoreText: [{ match: "a" }] }), "x").problems.join()).toMatch(/reason/);
    expect(parseReference(file({ source: "s", components: [], ignoreBoxes: [{ match: "(", reason: "r" }] }), "x").problems.join()).toMatch(/not a regular expression/);
  });

  it("wraps a component list as a form definition", async () => {
    const { formOf, definitionOf } = await mod();
    const form = formOf([{ id: "a", type: "text" }], "case");
    expect(form.root.children.content).toHaveLength(1);
    expect(definitionOf({ components: [{ id: "b", type: "text" }] }, "k").root.children.content[0].id).toBe("b");
    expect(definitionOf({ definition: { id: "own" } }, "k").id).toBe("own");
  });

  it("reads the govuk reference cases of this repository without problems, each naming its source", async () => {
    const { loadReferences } = await mod();
    const { loadBindingPackage } = await pkgMod();
    const cases = loadReferences(loadBindingPackage("govuk"));
    expect(cases.length).toBeGreaterThanOrEqual(8);
    for (const entry of cases) {
      expect(entry.problems, entry.id).toEqual([]);
      expect(entry.meta.source).toMatch(/govuk-frontend 6\.6\.0/);
      expect(entry.html).toMatch(/govuk-/);
    }
    expect(REPO).toBeTruthy();
  });
});
