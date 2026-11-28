import { describe, expect, it } from "vitest";

import {
  componentJsonChanges,
  componentJsonText,
  hasComponentJsonChanges,
  lineColumnAt,
  locateJsonSyntaxError,
  readComponentJson
} from "../form-engine/builder/property-editor/component-json.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/** The inspector's editable JSON view: what it shows, what it reads back, what that drafts. */

const field: ComponentNode = {
  id: "fullName",
  type: "text-field",
  configuration: { label: "Full name", placeholder: "First Last" },
  rules: { requiredWhen: "true" }
};

const section: ComponentNode = {
  id: "address",
  type: "section",
  configuration: { title: "Address" },
  children: { content: [{ id: "street", type: "text-field", configuration: { label: "Street" } }] }
};

const read = (text: string, node: ComponentNode = field, idEditable = true) => readComponentJson(text, node, { idEditable });

describe("componentJsonText", () => {
  it("shows the id, type, configuration and rules — never the children", () => {
    expect(JSON.parse(componentJsonText(field))).toEqual({
      id: "fullName",
      type: "text-field",
      configuration: { label: "Full name", placeholder: "First Last" },
      rules: { requiredWhen: "true" }
    });
    expect(JSON.parse(componentJsonText(section))).toEqual({ id: "address", type: "section", configuration: { title: "Address" } });
    expect(Object.keys(JSON.parse(componentJsonText(field)))).toEqual(["id", "type", "configuration", "rules"]);
  });

  it("reads its own text back as no change at all", () => {
    for (const node of [field, section]) {
      const result = read(componentJsonText(node), node);
      expect(result.ok).toBe(true);
      expect(result.ok && hasComponentJsonChanges(componentJsonChanges(node, result.value))).toBe(false);
    }
  });
});

describe("readComponentJson", () => {
  it("places a parse error at its line and column", () => {
    const text = '{\n  "id": "fullName",\n  "type": "text-field"\n  "configuration": {}\n}';
    const result = read(text);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.problem).toMatchObject({ message: "Expected a comma or }.", line: 4, column: 3 });
  });

  it("says what is wrong with JSON that parses but is not this component's", () => {
    const problem = (text: string, node: ComponentNode = field, idEditable = true): string | undefined => {
      const result = read(text, node, idEditable);
      return result.ok ? undefined : result.problem.message;
    };
    expect(problem("[]")).toMatch(/must be one object/);
    expect(problem('{ "id": "fullName", "configuration": {}, "label": "x" }')).toMatch(/"label" is not part of a component.*inside "configuration"/);
    expect(problem('{ "type": "text-field", "configuration": {} }')).toMatch(/needs an "id"/);
    expect(problem('{ "id": 3, "configuration": {} }')).toMatch(/"id" must be text/);
    expect(problem('{ "id": "other", "configuration": {} }', field, false)).toMatch(/ID cannot change here/);
    expect(problem('{ "id": "fullName", "type": "checkbox", "configuration": {} }')).toMatch(/type cannot change/);
    expect(problem('{ "id": "fullName" }')).toMatch(/needs a "configuration" object/);
    expect(problem('{ "id": "fullName", "configuration": [] }')).toMatch(/"configuration" must be an object/);
    expect(problem('{ "id": "fullName", "configuration": { "a.b": 1 } }')).toMatch(/cannot be a configuration key/);
    expect(problem('{ "id": "fullName", "configuration": {}, "rules": { "visibleWhen": { "nope": 1 } } }')).toMatch(/"visibleWhen" is not a valid rule/);
    expect(problem('{ "id": "address", "configuration": {}, "children": { "content": [] } }', section)).toMatch(/children are edited on the canvas/);
  });

  it("places a shape problem at the key it is about", () => {
    const text = '{\n  "id": "fullName",\n  "type": "checkbox",\n  "configuration": {}\n}';
    const result = read(text);
    expect(!result.ok && result.problem).toMatchObject({ line: 3, column: 3 });
  });

  it("takes a whole node pasted from elsewhere: its children and collection apply when they are the component's own", () => {
    const pasted = JSON.stringify({ ...section, configuration: { title: "Where you live" } });
    const result = read(pasted, section);
    expect(result.ok).toBe(true);
    expect(result.ok && componentJsonChanges(section, result.value).set).toEqual([{ key: "title", value: "Where you live" }]);
  });

  it("takes a formula whatever it calls, and refuses an expression tree", () => {
    // A formula string is a rule whatever it calls: the parser, not this check, reads it.
    expect(readComponentJson('{ "id": "fullName", "configuration": {}, "rules": { "visibleWhen": "regionTax() > 1" } }', field, { idEditable: true }).ok).toBe(true);
    const tree = '{ "id": "fullName", "configuration": {}, "rules": { "visibleWhen": { "kind": "call", "name": "regionTax", "args": [] } } }';
    expect(readComponentJson(tree, field, { idEditable: true }).ok).toBe(false);
  });

  it("keeps a rule the component already carries as it is, even one it cannot check", () => {
    const odd: ComponentNode = { ...field, rules: { visibleWhen: { custom: true } as never } };
    expect(read(componentJsonText(odd), odd).ok).toBe(true);
  });
});

describe("componentJsonChanges", () => {
  it("sets changed keys, removes deleted ones, and drafts the rules and the id only when they differ", () => {
    const result = read(
      JSON.stringify({ id: "name", type: "text-field", configuration: { label: "Name", description: "As on your passport" } })
    );
    expect(result.ok).toBe(true);
    const changes = result.ok ? componentJsonChanges(field, result.value) : undefined;
    expect(changes).toEqual({
      id: "name",
      set: [
        { key: "label", value: "Name" },
        { key: "description", value: "As on your passport" }
      ],
      remove: ["placeholder"],
      rules: { value: undefined }
    });
  });

  it("drops null rules, as taking them off", () => {
    const result = read(JSON.stringify({ id: "fullName", configuration: field.configuration, rules: { requiredWhen: null } }));
    expect(result.ok && componentJsonChanges(field, result.value).rules).toEqual({ value: undefined });
  });
});

describe("locateJsonSyntaxError", () => {
  it.each([
    ["", "The box is empty: it needs the component's JSON.", 0],
    ['{ "a": 1, }', "A comma cannot come before }.", 10],
    ["{ 'a': 1 }", "Expected a key in double quotes.", 2],
    ['{ "a" 1 }', "Expected a colon after the key.", 6],
    ['{ "a": tru }', 'Unexpected "t".', 7],
    ['{ "a": [1, ] }', "A comma cannot come before ].", 11],
    ['{ "a": "x', "This text is never closed: a double quote is missing.", 7],
    ['{ "a": 1 } x', "Unexpected text after the JSON: there is one object to write.", 11],
    ['{ "a": {', "The JSON ends too soon: something is not closed.", 8]
  ])("%j: %s", (text, message, offset) => {
    expect(() => JSON.parse(text)).toThrow();
    expect(locateJsonSyntaxError(text)).toEqual({ message, offset });
  });

  it("finds nothing wrong with JSON that parses", () => {
    expect(locateJsonSyntaxError('{ "a": [1, -2.5e3, true, null, "\\u00e9\\n"] }')).toBeUndefined();
  });

  it("counts lines and columns from 1", () => {
    expect(lineColumnAt("ab\ncd", 4)).toEqual({ line: 2, column: 2 });
    expect(lineColumnAt("ab", 0)).toEqual({ line: 1, column: 1 });
  });
});
