import { describe, expect, it } from "vitest";

import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { FORMULA_FUNCTION_TABLE } from "../form-engine/core/expressions/function-table.js";
import { FORMULA_FUNCTION_DOCS } from "../form-engine/core/expressions/function-docs.js";
import { buildNestedTreeView } from "../form-engine/builder/tree-editor/nested-tree-view.js";
import { buildVariablesModel, builtInFunctionRows, feelPath, type VariableGroup } from "../form-engine/builder/web-component/builder-variables-panel.js";

/**
 * A form with every shape the panel must describe: a plain field, a field in a data-scoping
 * container, a field in a purely visual container, a repeating section holding a nested one,
 * and two things that carry no answer (a button, static HTML).
 */
function root(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Order" },
    children: {
      content: [
        { id: "fullName", type: "text", configuration: { label: "Full name" } },
        {
          id: "applicant",
          type: "container",
          configuration: { label: "Applicant" },
          children: { content: [{ id: "email", type: "text", configuration: { label: "Email" } }] }
        },
        {
          id: "contact",
          type: "panel",
          configuration: { label: "Contact" },
          children: { content: [{ id: "phone", type: "text", configuration: { label: "Phone" } }] }
        },
        {
          id: "items",
          type: "panel",
          configuration: { label: "Items" },
          collection: { collectionPath: "items", itemFields: ["qty"] },
          children: {
            content: [
              { id: "qty", type: "number", configuration: { label: "Qty" } },
              {
                id: "lines",
                type: "panel",
                configuration: { label: "Lines" },
                collection: { collectionPath: "lines" },
                children: { content: [{ id: "sku", type: "text", configuration: { label: "SKU" } }] }
              }
            ]
          }
        },
        { id: "blurb", type: "html", configuration: { html: "<p>Hi</p>" } },
        { id: "send", type: "button", configuration: { label: "Send", action: "submit" } }
      ]
    }
  };
}

const group = (groups: VariableGroup[], id: string): VariableGroup => {
  const found = groups.find((entry) => entry.id === id);
  if (!found) {
    throw new Error(`No group ${id}: ${groups.map((entry) => entry.id).join(", ")}`);
  }
  return found;
};
const refs = (groups: VariableGroup[], id: string): string[] => group(groups, id).entries.map((entry) => entry.reference);

describe("the Variables panel's model", () => {
  it("lists the Rules tab's paths on the form side: ids wherever a field sits, the scopes and the functions", () => {
    const model = buildVariablesModel(buildNestedTreeView(root()), "rules");
    expect(model.syntax).toBe("rules");
    expect(model.intro).toContain("rule");
    expect(model.groups.map((entry) => entry.id)).toEqual(["fields", "collection:items", "collection:lines", "scopes", "functions:logic", "functions:text", "functions:number", "functions:list", "functions:date", "functions:scope"]);
    // A rule addresses a field by its id, so the container adds nothing; a repeating section is
    // listed as itself (its entries), its fields only through an entry; a button and static HTML
    // carry no answer.
    expect(refs(model.groups, "fields")).toEqual(["fullName", "email", "phone", "items"]);
    expect(group(model.groups, "fields").entries[1]).toEqual({ reference: "email", label: "Email", note: "text" });
    expect(group(model.groups, "fields").entries[3]?.note).toBe("repeating section: its entries");
    expect(refs(model.groups, "collection:items")).toEqual(["row.qty"]);
    expect(refs(model.groups, "collection:lines")).toEqual(["row.sku"]);
    expect(group(model.groups, "collection:items").title).toBe("In Items");
    expect(refs(model.groups, "scopes")).toEqual(["component", "component.part", "row.key", "ancestor.containerId", "host.key"]);
    expect(refs(model.groups, "functions:number")).toContain("roundTo(number, scale)");
    // The host names no page: the intro carries no link.
    expect(model.introLink).toBeUndefined();
    expect(buildVariablesModel(buildNestedTreeView(root()), "rules", { referenceHref: "https://example.test/f" }).introLink).toEqual({ label: "Formula reference", href: "https://example.test/f" });
  });

  it("lists the PDF text placeholders on a layout: value paths in braces, the row aliases, the enclosing entry, the page tokens and the host", () => {
    const model = buildVariablesModel(buildNestedTreeView(root()), "placeholders");
    expect(model.syntax).toBe("placeholders");
    expect(model.groups.map((entry) => entry.id)).toEqual(["fields", "collection:items", "collection:lines", "page", "host"]);
    // The PDF's form scope is keyed by value path: the data-scoping container is a level, the
    // visual one is not, and the repeating section is not an answer to print.
    expect(refs(model.groups, "fields")).toEqual(["{{fullName}}", "{{applicant.email}}", "{{phone}}"]);
    expect(refs(model.groups, "collection:items")).toEqual(["{{row.qty}}", "{{rowNumber}}", "{{rowIndex}}", "{{rowCount}}"]);
    expect(group(model.groups, "collection:items").note).toBe("Inside a repeat or a table bound to this section");
    // A nested section reaches the entry around it through the outer section's path.
    expect(refs(model.groups, "collection:lines")).toEqual(["{{row.sku}}", "{{rowNumber}}", "{{rowIndex}}", "{{rowCount}}", "{{ancestor.items.qty}}"]);
    expect(group(model.groups, "collection:lines").entries[4]?.note).toBe("the enclosing Items entry");
    expect(refs(model.groups, "page")).toEqual(["{{page}}", "{{pages}}"]);
    expect(group(model.groups, "page").note).toBe("In a header or footer only");
    expect(refs(model.groups, "host")).toEqual(["{{host.key}}"]);
  });

  it("lists what a print header or footer line reads in the Print workspace: value paths, the page tokens, the title, date and receipt, the host; no repeat's rows", () => {
    const model = buildVariablesModel(buildNestedTreeView(root()), "placeholders", { workspace: "print" });
    expect(model.groups.map((entry) => entry.id)).toEqual(["fields", "page", "print", "host"]);
    expect(refs(model.groups, "fields")).toEqual(["{{fullName}}", "{{applicant.email}}", "{{phone}}"]);
    expect(refs(model.groups, "print")).toEqual(["{{title}}", "{{date}}", "{{receipt.reference}}"]);
    expect(model.intro).toContain("printed header or footer");
    // Any other workspace keeps the layout's own list.
    expect(buildVariablesModel(buildNestedTreeView(root()), "placeholders", { workspace: "pdf" }).groups.some((entry) => entry.id === "print")).toBe(false);
  });

  it("lists what a journey condition may read: fields and sections by id, the functions, and no scoped path", () => {
    const model = buildVariablesModel(buildNestedTreeView(root()), "conditions");
    expect(model.syntax).toBe("conditions");
    expect(model.intro).toContain("journey");
    // No entry of a section is reachable (no row.), nor any scope (row., ancestor., host., component).
    expect(model.groups.map((entry) => entry.id)).toEqual(["fields", "functions:logic", "functions:text", "functions:number", "functions:list", "functions:date"]);
    expect(refs(model.groups, "fields")).toEqual(["fullName", "email", "phone", "items"]);
    expect(group(model.groups, "fields").entries[3]?.note).toBe("repeating section: its entries");
    expect(model.groups.flatMap((entry) => entry.entries).some((entry) => entry.reference.startsWith("contains("))).toBe(true);
    const everything = model.groups.flatMap((entry) => entry.entries.map((row) => row.reference));
    expect(everything.some((reference) => /^(row|ancestor|host|component)\b/.test(reference))).toBe(false);
  });

  it("describes an empty form as having no fields yet, with the fixed names still listed", () => {
    const model = buildVariablesModel(buildNestedTreeView({ id: "root", type: "form", configuration: {}, children: { content: [] } }), "placeholders");
    expect(group(model.groups, "fields").entries).toEqual([]);
    expect(model.groups.map((entry) => entry.id)).toEqual(["fields", "page", "host"]);
  });

  it("lists the functions as the function table groups them: signature, summary, and a call with blanks to copy", () => {
    const model = buildVariablesModel(buildNestedTreeView(root()), "rules");
    const table = FORMULA_FUNCTION_TABLE.map((row) => row.name);
    const listed = model.groups.filter((entry) => entry.id.startsWith("functions:")).flatMap((entry) => entry.entries);
    expect(listed).toHaveLength(table.length);
    const round = group(model.groups, "functions:number").entries.find((entry) => entry.reference.startsWith("roundTo("));
    expect(round?.label).toBe(FORMULA_FUNCTION_DOCS.roundTo?.summary);
    expect(round?.copy).toBe("roundTo(number, scale)");
    // An optional parameter is shown with its mark and left out of the copied call; a repeating one says so.
    const substring = group(model.groups, "functions:text").entries.find((entry) => entry.reference.startsWith("substring("));
    expect(substring?.reference).toContain("?");
    expect(substring?.copy).not.toContain("?");
    const sum = group(model.groups, "functions:number").entries.find((entry) => entry.reference.startsWith("sum("));
    expect(sum?.reference).toContain("…");
    expect(sum?.note).toBe("takes any number of arguments");
    expect(group(model.groups, "functions:date").entries.find((entry) => entry.reference === "today()")?.copy).toBe("today()");
  });

  it("lists a plugin's function under Plugins, after the table's groups", () => {
    const model = buildVariablesModel(buildNestedTreeView(root()), "rules", {
      functions: [...builtInFunctionRows(), { name: "regionTax", params: ["region", "amount"], group: "tax", summary: "The tax for a region." }],
      referenceHref: "https://example.test/formulas"
    });
    const plugins = group(model.groups, "functions:plugins");
    expect(plugins.title).toBe("Plugins");
    expect(plugins.entries).toEqual([{ reference: "regionTax(region, amount)", copy: "regionTax(region, amount)", label: "The tax for a region." }]);
    expect(model.groups[model.groups.length - 1]?.id).toBe("functions:plugins");
    expect(model.introLink?.href).toBe("https://example.test/formulas");
  });

  it("copies a field as the formula spells it: bare when the grammar reads one name, backticked when not", () => {
    expect(feelPath("fullName")).toBe("fullName");
    expect(feelPath("first-name")).toBe("first-name");
    expect(feelPath("row.qty")).toBe("row.qty");
    expect(feelPath("full name")).toBe("`full name`");
    expect(feelPath("2nd")).toBe("`2nd`");
    expect(feelPath("in")).toBe("`in`");
    const tree: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: { content: [{ id: "date of birth", type: "text", configuration: { label: "Birth" } }] }
    };
    expect(refs(buildVariablesModel(buildNestedTreeView(tree), "rules").groups, "fields")).toEqual(["`date of birth`"]);
    // A PDF placeholder keeps its value path.
    expect(refs(buildVariablesModel(buildNestedTreeView(tree), "placeholders").groups, "fields")).toEqual(["{{date of birth}}"]);
  });

  it("says rules are formulas in the intro and links the reference, on the formula syntaxes only", () => {
    const host = { referenceHref: "https://example.test/formulas" };
    const rules = buildVariablesModel(buildNestedTreeView(root()), "rules", host);
    expect(rules.intro).toContain("formula");
    expect(rules.introLink?.label).toBe("Formula reference");
    expect(buildVariablesModel(buildNestedTreeView(root()), "conditions", host).introLink).toBeDefined();
    expect(buildVariablesModel(buildNestedTreeView(root()), "placeholders", host).introLink).toBeUndefined();
  });
});

describe("a data grid in the Variables panel", () => {
  /** A grid lists as a repeating section does: itself in Fields, its row fields under "In <label>", by the collection and not the type. */
  function gridRoot(): ComponentNode {
    return {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "name", type: "text", configuration: { label: "Name" } },
          {
            id: "dependants",
            type: "dataGrid",
            configuration: { label: "Dependants" },
            collection: { collectionPath: "family.dependants" },
            children: {
              content: [
                { id: "given", type: "text", configuration: { label: "Given name", dataKey: "first" } },
                { id: "born", type: "date", configuration: { label: "Born" } },
                { id: "go", type: "button", configuration: { label: "Go" } }
              ]
            }
          }
        ]
      }
    };
  }

  it("lists the grid's fields as row.<key> under In <label>, and the grid itself as its entries", () => {
    const rules = buildVariablesModel(buildNestedTreeView(gridRoot()), "rules");
    expect(rules.groups.map((entry) => entry.id).slice(0, 2)).toEqual(["fields", "collection:family.dependants"]);
    expect(refs(rules.groups, "fields")).toEqual(["name", "dependants"]);
    expect(group(rules.groups, "fields").entries[1]?.note).toBe("repeating section: its entries");
    expect(group(rules.groups, "collection:family.dependants").title).toBe("In Dependants");
    expect(refs(rules.groups, "collection:family.dependants")).toEqual(["row.first", "row.born"]);

    const placeholders = buildVariablesModel(buildNestedTreeView(gridRoot()), "placeholders");
    expect(refs(placeholders.groups, "collection:family.dependants").slice(0, 2)).toEqual(["{{row.first}}", "{{row.born}}"]);
  });
});
