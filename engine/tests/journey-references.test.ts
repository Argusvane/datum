import { describe, expect, it } from "vitest";

import type { Expression } from "../form-engine/core/expressions/expression.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { validateJourneyShape, type Journey, type JourneyConfiguration, type JourneyPageEntry } from "../form-engine/core/schema/journey.js";
import {
  conditionReadsComponent,
  journeyOwnNodeIds,
  journeyOwnRenames,
  journeyReferencesComponent,
  journeyRenameEdits,
  journeyTreeOwnIds,
  journeyTreeRenames,
  type JourneyTreeRename,
  renameConditionPaths,
  renameJourneyReferences,
  renamePathSegment,
  renameReferencesInConfiguration
} from "../form-engine/builder/journey-designer/journey-references.js";
import { journeyFromTree, treeFromJourney } from "../form-engine/builder/journey-designer/journey-tree.js";
import { applyJourney, presentationForm, publicVariant } from "./fixtures/presentation-form.js";

function path(value: string): Expression {
  return { kind: "path", path: value };
}

function eq(read: string, value: string): Expression {
  return { kind: "binary", operator: "eq", left: path(read), right: { kind: "literal", value } };
}

const JOURNEY: Journey = {
  id: "intake",
  name: "Step by step",
  pages: [
    {
      id: "about",
      components: ["text_1", "contactMethod"],
      routes: [{ when: eq("contactMethod", "phone"), to: "details" }, { when: eq("contactMethod", "mail"), to: "address" }, { to: "$end" }]
    },
    {
      id: "address",
      components: ["mailingAddress"],
      routes: [
        {
          when: {
            kind: "logical",
            operator: "and",
            left: { kind: "unary", operator: "not", operand: eq("contactMethod", "none") },
            right: { kind: "call", name: "contains", args: [path("applicants[0].name"), path("contactMethodology")] }
          },
          to: "details"
        },
        { to: "$end" }
      ]
    },
    { id: "details", components: ["notes", "contactMethod"] }
  ]
};

describe("renamePathSegment", () => {
  it("renames the leading segment only, before a dot or a bracket", () => {
    expect(renamePathSegment("contactMethod", "contactMethod", "contact")).toBe("contact");
    expect(renamePathSegment("applicants[0].name", "applicants", "people")).toBe("people[0].name");
    expect(renamePathSegment("mailingAddress.street", "mailingAddress", "address")).toBe("address.street");
    expect(renamePathSegment("contactMethodology", "contactMethod", "contact")).toBe("contactMethodology");
    expect(renamePathSegment("applicants[0].name", "name", "fullName")).toBe("applicants[0].name");
  });

  it("never renames a path read from outside the form's answers", () => {
    expect(renamePathSegment("row.name", "row", "line")).toBe("row.name");
    expect(renamePathSegment("host.user", "host", "server")).toBe("host.user");
    expect(renamePathSegment("ancestor.items.x", "ancestor", "parent")).toBe("ancestor.items.x");
    expect(renamePathSegment("component", "component", "part")).toBe("component");
    // A component that happens to be called "row" is still the form's own answer.
    expect(renamePathSegment("row", "row", "line")).toBe("line");
  });
});

describe("renameConditionPaths", () => {
  it("renames every path node that reads the component, however deep, and nothing else", () => {
    const condition = JOURNEY.pages[1]?.routes?.[0]?.when as Expression;
    const renamed = renameConditionPaths(condition, "contactMethod", "contact");
    expect(renamed).toEqual({
      kind: "logical",
      operator: "and",
      left: { kind: "unary", operator: "not", operand: eq("contact", "none") },
      right: { kind: "call", name: "contains", args: [path("applicants[0].name"), path("contactMethodology")] }
    });
    // Unchanged branches are the same objects; the input is left alone.
    expect((renamed as { right: unknown }).right).toBe((condition as { right: unknown }).right);
    expect(condition).toEqual(JOURNEY.pages[1]?.routes?.[0]?.when);
  });

  it("gives back the same condition when nothing reads the component", () => {
    const condition = eq("country", "CA");
    expect(renameConditionPaths(condition, "contactMethod", "contact")).toBe(condition);
    expect(renameConditionPaths(condition, "country", "country")).toBe(condition);
    expect(renameConditionPaths(undefined, "country", "nation")).toBeUndefined();
  });
});

describe("renameJourneyReferences", () => {
  it("renames page components and route conditions", () => {
    const renamed = renameJourneyReferences(JOURNEY, "contactMethod", "contact");
    expect(renamed.pages.map((page) => page.components)).toEqual([["text_1", "contact"], ["mailingAddress"], ["notes", "contact"]]);
    expect(renamed.pages[0]?.routes?.[0]?.when).toEqual(eq("contact", "phone"));
    expect(renamed.pages[0]?.routes?.[1]?.when).toEqual(eq("contact", "mail"));
    expect(renamed.pages[0]?.routes?.[2]).toBe(JOURNEY.pages[0]?.routes?.[2]);
    expect(renamed.pages[1]?.routes?.[1]).toBe(JOURNEY.pages[1]?.routes?.[1]);
    expect(JOURNEY.pages[0]?.components).toEqual(["text_1", "contactMethod"]);
    expect(journeyReferencesComponent(renamed, "contactMethod")).toBe(false);
    expect(journeyReferencesComponent(renamed, "contact")).toBe(true);
  });

  it("gives back the same journey, page by page, when nothing names the component", () => {
    expect(renameJourneyReferences(JOURNEY, "birthDate", "dob")).toBe(JOURNEY);
    const renamed = renameJourneyReferences(JOURNEY, "notes", "comments");
    expect(renamed.pages[0]).toBe(JOURNEY.pages[0]);
    expect(renamed.pages[2]?.components).toEqual(["comments", "contactMethod"]);
  });

  it("knows which components a journey reads", () => {
    expect(journeyReferencesComponent(JOURNEY, "mailingAddress")).toBe(true);
    expect(journeyReferencesComponent(JOURNEY, "applicants")).toBe(true);
    expect(journeyReferencesComponent(JOURNEY, "birthDate")).toBe(false);
    expect(conditionReadsComponent(JOURNEY.pages[1]?.routes?.[0]?.when, "contactMethodology")).toBe(true);
    expect(conditionReadsComponent({ kind: "path", path: "row.contactMethod" }, "row")).toBe(false);
  });
});

describe("renameReferencesInConfiguration", () => {
  it("renames across every usable journey and keeps the rest of the block as it was", () => {
    const unreadable = { id: "broken", pages: [{ id: "p", components: ["contactMethod"], routes: [{}] }] };
    const other: Journey = { id: "short", pages: [{ id: "only", components: ["contactMethod"] }] };
    const duplicate: Journey = { id: "short", pages: [{ id: "again", components: ["notes"], routes: [{ when: eq("contactMethod", "x"), to: "$end" }] }] };
    const configuration = {
      journeys: [JOURNEY, unreadable, other, duplicate],
      defaultJourneyId: "short",
      "x-owner": "forms-team"
    } as unknown as JourneyConfiguration;
    const renamed = renameReferencesInConfiguration(configuration, "contactMethod", "contact") as JourneyConfiguration;
    const journeys = renamed.journeys as unknown[];
    expect(journeys[1]).toBe(unreadable);
    expect((journeys[2] as Journey).pages[0]?.components).toEqual(["contact"]);
    expect((journeys[3] as Journey).pages[0]?.routes?.[0]?.when).toEqual(eq("contact", "x"));
    expect((renamed as unknown as Record<string, unknown>)["x-owner"]).toBe("forms-team");
    expect(Object.keys(renamed)).toEqual(Object.keys(configuration));

    expect(renameReferencesInConfiguration(configuration, "birthDate", "dob")).toBe(configuration);
    expect(renameReferencesInConfiguration(undefined, "a", "b")).toBeUndefined();
  });
});

describe("journeyTreeRenames", () => {
  it("names the property edits that follow a rename in a built designer, which then write the renamed journey", () => {
    const root = treeFromJourney(JOURNEY);
    const edits = journeyTreeRenames(root, "contactMethod", "contact");
    expect(edits.map((edit) => `${edit.nodeId}.${edit.property}`)).toEqual([
      "journey-field_2.componentId",
      "journey-route_1.when",
      "journey-route_2.when",
      "journey-route_4.when",
      "journey-field_5.componentId"
    ]);

    // Applied as the mode applies them (setProperty on each node), the tree writes what the
    // catalog-side rename writes.
    const byId = new Map<string, ComponentNode>();
    const index = (node: ComponentNode): void => {
      byId.set(node.id, node);
      Object.values(node.children ?? {}).flat().forEach(index);
    };
    index(root);
    for (const edit of edits) {
      (byId.get(edit.nodeId)?.configuration as Record<string, unknown>)[edit.property] = edit.value;
    }
    expect(journeyFromTree(root, "intake")).toEqual(renameJourneyReferences(JOURNEY, "contactMethod", "contact"));
    expect(journeyTreeRenames(root, "contactMethod", "contact")).toEqual([]);
  });
});

/**
 * A presentation's own nodes name form components too: a reference, an alias's
 * `fills`, a worked-out value's `to`, and the form paths an own node's rules read. A journey
 * holding them follows a rename in the stored journey and, once its designer is built, in the
 * tree (below) — and everything the rename does not touch must come back exactly as written.
 */
describe("a rename followed into a presentation's own nodes", () => {
  /** One page holding `entries`, in a journey that passes the shape check. */
  function journeyWith(...entries: JourneyPageEntry[]): Journey {
    const journey: Journey = { id: "apply", pages: [{ id: "only", components: entries }] };
    expect(validateJourneyShape(journey)).toEqual([]);
    return journey;
  }

  function entriesOf(journey: Journey): JourneyPageEntry[] {
    return journey.pages[0]?.components ?? [];
  }

  it("renames what an alias fills, keeping the alias's id, its other keys and their order", () => {
    const alias = { id: "work_email", type: "text", configuration: { label: "Work email", fills: "email", required: true }, "x-note": "kept" };
    const journey = journeyWith(alias as unknown as JourneyPageEntry, "name");
    const renamed = renameJourneyReferences(journey, "email", "contact_email");
    expect(JSON.stringify(entriesOf(renamed))).toBe(
      JSON.stringify([{ id: "work_email", type: "text", configuration: { label: "Work email", fills: "contact_email", required: true }, "x-note": "kept" }, "name"])
    );
    // The journey given is left alone, and an own node's id is never taken for a form id.
    expect((alias.configuration as { fills: string }).fills).toBe("email");
    expect(renameJourneyReferences(journey, "work_email", "other")).toBe(journey);
    expect(journeyReferencesComponent(journey, "email")).toBe(true);
    expect(journeyReferencesComponent(journey, "work_email")).toBe(false);
    expect(journeyReferencesComponent(renamed, "email")).toBe(false);
  });

  it("renames the field a worked-out value sets, and leaves its expression as written", () => {
    const journey = applyJourney();
    const renamed = renameJourneyReferences(journey, "annual_income", "income");
    const total = renamed.pages[1]?.components?.[3] as unknown as { configuration: { to: string; value: unknown; label: string } };
    expect(total.configuration.to).toBe("income");
    // The expression reads the page's own fields (m1…m3): the same object, untouched.
    expect(total.configuration.value).toBe((journey.pages[1]?.components?.[3] as unknown as { configuration: { value: unknown } }).configuration.value);
    expect(Object.keys(total.configuration)).toEqual(["to", "value", "label"]);
    // The own fields beside it are the same objects; the route reading the form field follows.
    expect(renamed.pages[1]?.components?.[0]).toBe(journey.pages[1]?.components?.[0]);
    expect(renamed.pages[1]?.routes?.[0]?.when).toEqual({
      kind: "binary",
      operator: "gte",
      left: path("income"),
      right: { kind: "literal", value: 50000 }
    });
    expect(renamed.pages[0]).toBe(journey.pages[0]);
    expect(validateJourneyShape(renamed)).toEqual([]);
  });

  it("never renames a worked-out value's expression, even where it spells the old id", () => {
    const value: Expression = { kind: "call", name: "sum", args: [path("m1"), path("bonus")] };
    const journey = journeyWith(
      { id: "m1", type: "number", configuration: { label: "Month 1" } },
      { id: "total", type: "journey-value", configuration: { to: "annual_income", value } }
    );
    // `bonus` is renamed on the form; the expression reads own fields only, so it is not the form's `bonus`.
    expect(renameJourneyReferences(journey, "bonus", "extra")).toBe(journey);
    // `to` on anything but a worked-out value is the node's own business.
    const plain = journeyWith({ id: "note", type: "text", configuration: { to: "email" } });
    expect(renameJourneyReferences(plain, "email", "contact_email")).toBe(plain);
  });

  it("renames a reference's component, at the top of a page and inside an own layout", () => {
    const top = journeyWith({ type: "journey-field", configuration: { componentId: "email" } }, "email");
    expect(entriesOf(renameJourneyReferences(top, "email", "contact_email"))).toEqual([
      { type: "journey-field", configuration: { componentId: "contact_email" } },
      "contact_email"
    ]);

    const variant = publicVariant();
    const renamed = renameJourneyReferences(variant, "name", "full_name");
    const columns = entriesOf(renamed)[0] as unknown as { children: { content: unknown[] } };
    expect(columns.children.content).toEqual([
      { type: "journey-field", configuration: { componentId: "email" } },
      { type: "journey-field", configuration: { componentId: "full_name" } }
    ]);
    // The reference beside it and the entry after it are the same objects.
    const before = entriesOf(variant)[0] as unknown as { children: { content: unknown[] } };
    expect(columns.children.content[0]).toBe(before.children.content[0]);
    expect(entriesOf(renamed)[1]).toBe(entriesOf(variant)[1]);
    expect(journeyReferencesComponent(variant, "name")).toBe(true);
    expect(journeyReferencesComponent(variant, "contact")).toBe(false);
  });

  it.each(["visibleWhen", "enabledWhen", "readonlyWhen", "requiredWhen"])("renames the form paths an own node's %s reads, nested nodes included", (rule) => {
    const nested = { id: "detail", type: "text", configuration: { label: "Detail" }, rules: { [rule]: eq("contactMethod", "phone") } };
    const journey = journeyWith(
      { id: "extra", type: "text", configuration: { label: "Extra" }, rules: { [rule]: eq("contactMethod", "phone"), "x-rule": eq("contactMethod", "kept") } },
      { id: "box", type: "fieldset", configuration: { label: "Box" }, children: { content: [nested, { id: "other", type: "text" }] } } as unknown as JourneyPageEntry
    );
    const renamed = entriesOf(renameJourneyReferences(journey, "contactMethod", "contact")) as unknown as Array<Record<string, unknown>>;
    expect(renamed[0]?.rules).toEqual({ [rule]: eq("contact", "phone"), "x-rule": eq("contactMethod", "kept") });
    const box = renamed[1] as { children: { content: Array<Record<string, unknown>> } };
    expect(box.children.content[0]?.rules).toEqual({ [rule]: eq("contact", "phone") });
    expect(box.children.content[1]).toBe(((entriesOf(journey)[1] as unknown) as { children: { content: unknown[] } }).children.content[1]);
    expect(journeyReferencesComponent(journey, "contactMethod")).toBe(true);
  });

  it("leaves an own rule's scoped paths, and paths that only begin like the old id, alone", () => {
    const journey = journeyWith({
      id: "extra",
      type: "text",
      rules: { visibleWhen: { kind: "logical", operator: "and", left: eq("host.contactMethod", "x"), right: eq("contactMethodology", "y") } }
    });
    expect(renameJourneyReferences(journey, "contactMethod", "contact")).toBe(journey);
  });

  it("gives back the very journey, byte for byte, when no own node names the component", () => {
    for (const journey of [applyJourney(), publicVariant()]) {
      const before = JSON.stringify(journey);
      expect(renameJourneyReferences(journey, "approved", "granted")).toBe(journey);
      expect(JSON.stringify(journey)).toBe(before);
    }
  });

  it("follows a rename through every presentation of a definition, the rest of each as written", () => {
    const configuration = presentationForm().journey as JourneyConfiguration;
    const before = JSON.stringify(configuration);
    const renamed = renameReferencesInConfiguration(configuration, "email", "contact_email") as JourneyConfiguration;
    expect(JSON.stringify(configuration)).toBe(before);
    // Exactly the two places that named it changed: the alias's `fills`, and the variant's reference.
    expect(JSON.stringify(renamed)).toBe(before.replace('"fills":"email"', '"fills":"contact_email"').replace('"componentId":"email"', '"componentId":"contact_email"'));
    expect(JSON.stringify(renamed)).not.toBe(before);
  });

  it("keeps a __proto__ key inside an own node's rule as a key of the copy, byte for byte", () => {
    const text =
      '{"journeys":[{"id":"g","pages":[{"id":"p","title":"P","components":["email",' +
      '{"id":"own","type":"text","configuration":{"label":"Own"},"rules":{"visibleWhen":{"kind":"binary","operator":"eq","__proto__":{"note":"kept"},"left":{"kind":"path","path":"name"},"right":{"kind":"literal","value":"x"}}}}]}]}]}';
    const renamed = renameReferencesInConfiguration(JSON.parse(text) as JourneyConfiguration, "name", "full_name");
    expect(JSON.stringify(renamed)).toBe(text.replace('"path":"name"', '"path":"full_name"'));
    const own = renamed?.journeys?.[0]?.pages[0]?.components?.[1] as unknown as { rules: { visibleWhen: object } };
    expect(Object.getPrototypeOf(own.rules.visibleWhen)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(own.rules.visibleWhen, "__proto__")).toBe(true);
    // A condition of a page, the same.
    const when = JSON.parse('{"kind":"binary","operator":"eq","__proto__":{"x":1},"left":{"kind":"path","path":"name"},"right":{"kind":"literal","value":1}}');
    expect(JSON.stringify(renameConditionPaths(when, "name", "full_name"))).toBe(JSON.stringify(when).replace('"path":"name"', '"path":"full_name"'));
  });

  it("lists every id a presentation's own nodes carry, all the way down, in every journey and variant", () => {
    const configuration = presentationForm().journey as JourneyConfiguration;
    expect([...journeyOwnNodeIds(configuration)].sort()).toEqual(["contact", "income_total", "m1", "m2", "m3", "public_note", "work_email"]);
    expect(journeyOwnNodeIds({ journeys: [{ id: "plain", pages: [{ id: "one", components: ["email"] }] }] }).size).toBe(0);
    expect(journeyOwnNodeIds(undefined).size).toBe(0);
  });
});

/**
 * An open designer's tree follows the same renames: a form component's into
 * the nodes the journey owns, and a node of its own renamed inside the tree into its own rules
 * and worked-out values — edits the mode writes in one `setProperties` step.
 */
describe("renames in a designer's tree holding a presentation's own nodes", () => {
  /** Applies edits as the controller's `setProperties` does: a configuration property, or a rule (`rules`). */
  function applied(root: ComponentNode, edits: readonly JourneyTreeRename[]): ComponentNode {
    const byId = new Map<string, ComponentNode>();
    const stack = [root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      byId.set(node.id, node);
      stack.push(...Object.values(node.children ?? {}).flat());
    }
    for (const edit of edits) {
      const node = byId.get(edit.nodeId)!;
      if (edit.rules) {
        node.rules = { ...(node.rules ?? {}), [edit.property]: edit.value } as NonNullable<ComponentNode["rules"]>;
      } else {
        (node.configuration as Record<string, unknown>)[edit.property] = edit.value;
      }
    }
    return root;
  }

  /** The fixture's journey with an own field whose rules read form fields and the page's own field. */
  function withRules(): Journey {
    const journey = applyJourney();
    journey.pages[1]!.components!.splice(1, 0, {
      id: "why",
      type: "text",
      configuration: { label: "Why?" },
      rules: { visibleWhen: eq("email", "x"), enabledWhen: path("m1"), readonlyWhen: { kind: "call", name: "not", args: [path("name")] } }
    });
    return journey;
  }

  it("follows a form rename into an alias's fills, a worked-out value's to, nested references and own rules, writing the catalog's rename", () => {
    for (const [journey, from, to] of [
      [withRules(), "email", "contact_email"],
      [withRules(), "annual_income", "income"],
      [withRules(), "name", "full_name"],
      [publicVariant(), "email", "contact_email"],
      [publicVariant(), "name", "full_name"]
    ] as const) {
      const root = treeFromJourney(journey);
      const edits = journeyTreeRenames(root, from, to);
      expect(edits.length).toBeGreaterThan(0);
      expect(JSON.stringify(journeyFromTree(applied(root, edits), journey.id))).toBe(JSON.stringify(renameJourneyReferences(journey, from, to)));
      expect(journeyTreeRenames(root, from, to)).toEqual([]);
    }
    const root = treeFromJourney(withRules());
    expect(journeyTreeRenames(root, "email", "contact_email")).toEqual([
      { nodeId: "work_email", property: "fills", value: "contact_email" },
      { nodeId: "why", property: "visibleWhen", value: eq("contact_email", "x"), rules: true }
    ]);
    expect(journeyTreeRenames(root, "annual_income", "income").map((edit) => `${edit.nodeId}.${edit.property}`)).toEqual(["income_total.to", "journey-route_1.when"]);
    // The worked-out value's expression reads own fields; a form rename never touches it.
    expect(journeyTreeRenames(root, "m1", "month_1").filter((edit) => !edit.rules)).toEqual([]);
  });

  it("follows an own node's rename into the presentation's own rules and worked-out values, and nothing else", () => {
    const journey = withRules();
    const root = treeFromJourney(journey);
    const edits = journeyOwnRenames(root, "m1", "month_1");
    expect(edits).toEqual([
      { nodeId: "why", property: "enabledWhen", value: path("month_1"), rules: true },
      { nodeId: "income_total", property: "value", value: { kind: "call", name: "sum", args: [path("month_1"), path("m2"), path("m3")] } }
    ]);
    // Renamed with its reads, the tree writes the journey with the new id everywhere it was read.
    const m1 = treeFromJourney(journey);
    const renamed = applied(m1, journeyOwnRenames(m1, "m1", "month_1"));
    const page = renamed.children!.pages![1]!;
    page.children!.content![0]!.id = "month_1";
    const written = JSON.stringify(journeyFromTree(renamed, "apply"));
    expect(written).toBe(JSON.stringify(journey).replace('"id":"m1"', '"id":"month_1"').replace(/"path":"m1"/g, '"path":"month_1"'));
    // A page's condition or a route reads form values only: never rewritten by an own rename.
    const routed = treeFromJourney({ id: "j", pages: [{ id: "p", components: [{ id: "own", type: "text" }], routes: [{ when: path("own"), to: "$end" }] }] });
    expect(journeyOwnRenames(routed, "own", "mine")).toEqual([]);
    expect(journeyOwnRenames(root, "m1", "m1")).toEqual([]);
  });

  it("lists the ids of the nodes a tree holds of the journey's own, however deep, and none of the designer's", () => {
    expect(journeyTreeOwnIds(treeFromJourney(applyJourney()))).toEqual(["work_email", "m1", "m2", "m3", "income_total"]);
    expect(journeyTreeOwnIds(treeFromJourney(publicVariant()))).toEqual(["contact", "public_note"]);
    expect(journeyTreeOwnIds(treeFromJourney({ id: "j", pages: [{ id: "p", components: ["email"] }] }))).toEqual([]);
  });
});

describe("journeyRenameEdits", () => {
  /** A journey whose own nodes share ids: one named as the designer's root, and two named alike. */
  function sharing(): Journey {
    return JSON.parse(
      JSON.stringify({
        id: "j",
        pages: [
          {
            id: "one",
            components: [
              "email",
              { id: "journey", type: "text", configuration: { label: "J", fills: "name" } },
              { id: "dup", type: "text", configuration: { label: "D1", fills: "name" }, rules: { visibleWhen: path("name") } },
              { id: "dup", type: "text", configuration: { label: "D2", fills: "name" } }
            ]
          }
        ]
      })
    ) as Journey;
  }

  it("goes by node id while every id is one node's", () => {
    const root = treeFromJourney(applyJourney());
    expect(journeyRenameEdits(root, "form", "email", "mail")).toEqual([{ componentId: "work_email", propertyPath: "fills", value: "mail" }]);
    expect(journeyRenameEdits(root, "own", "m1", "month_1")).toEqual([
      { componentId: "income_total", propertyPath: "value", value: { kind: "call", name: "sum", args: [path("month_1"), path("m2"), path("m3")] } }
    ]);
  });

  it("puts the root's slots back with every rename in its own place when ids are shared — never onto the root, never only the first", () => {
    const root = treeFromJourney(sharing());
    const edits = journeyRenameEdits(root, "form", "name", "fullname");
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ componentId: root.id, propertyPath: "", target: "children" });
    const renamed = { ...root, children: edits[0]!.value as Record<string, ComponentNode[]> };
    const expected = JSON.stringify(sharing()).replace(/"fills":"name"/g, '"fills":"fullname"').replace('"path":"name"', '"path":"fullname"');
    expect(JSON.stringify(journeyFromTree(renamed, "j"))).toBe(expected);
    // The tree it was given is left as it was; nothing to rename, nothing to write.
    expect(JSON.stringify(journeyFromTree(root, "j"))).toBe(JSON.stringify(sharing()));
    expect(journeyRenameEdits(root, "form", "approved_amount", "approved")).toEqual([]);
  });

  it("renames a Check answers step's row wording inside its review when ids are shared, as setProperties' nested path does", () => {
    const journey: Journey = {
      id: "j",
      name: "J",
      pages: [
        { id: "one", components: ["fullName", { id: "dup", type: "text" }, { id: "dup", type: "text" }] },
        { id: "check", kind: "review", review: { labels: { fullName: "Your name" } } }
      ]
    } as Journey;
    const root = treeFromJourney(journey);
    const edits = journeyRenameEdits(root, "form", "fullName", "name");
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ componentId: root.id, propertyPath: "", target: "children" });
    const written = journeyFromTree({ ...root, children: edits[0]!.value as Record<string, ComponentNode[]> }, "j");
    expect(written?.pages[1]).toEqual({ id: "check", kind: "review", review: { labels: { name: "Your name" } } });
  });
});

describe("journeyOwnNodeIds and references written with an id", () => {
  it("claims no id a reference carries, at the top of a page or inside a layout", () => {
    const configuration = {
      journeys: [
        {
          id: "j",
          pages: [
            {
              id: "one",
              components: [
                { id: "contact_email", type: "journey-field", configuration: { componentId: "email" } },
                { id: "box", type: "fieldset", configuration: {}, children: { content: [{ id: "inner_ref", type: "journey-field", configuration: { componentId: "name" } }, { id: "own", type: "text", configuration: {} }] } }
              ]
            }
          ]
        }
      ]
    };
    expect([...journeyOwnNodeIds(configuration)].sort()).toEqual(["box", "own"]);
  });
});

describe("a journey condition stored as a formula", () => {
  const journeyWithWhen = (when: unknown, routeWhen: unknown): Journey => ({
    id: "j",
    name: "J",
    pages: [
      { id: "p1", components: ["contactMethod"], routes: [{ when: routeWhen as Expression, to: "p2" }, { to: "$end" }] },
      { id: "p2", components: ["notes"], routes: [{ when: when as Expression, to: "$end" }] }
    ]
  });

  it("renames a route's when written as a string, the author's spacing kept", () => {
    const journey = journeyWithWhen('contactMethod  = "mail"', "contactMethod.kind in (\"phone\", \"sms\")");
    const renamed = renameJourneyReferences(journey, "contactMethod", "contact");
    expect(renamed.pages[1]?.routes?.[0]?.when).toBe('contact  = "mail"');
    expect(renamed.pages[0]?.routes?.[0]?.when).toBe('contact.kind in ("phone", "sms")');
    expect(renamed.pages[0]?.routes?.[1]).toBe(journey.pages[0]?.routes?.[1]);
    expect(journeyReferencesComponent(renamed, "contact")).toBe(true);
    expect(conditionReadsComponent('contactMethod = "mail"', "contactMethod")).toBe(true);
    expect(conditionReadsComponent('other = "contactMethod"', "contactMethod")).toBe(false);
  });

  it("renames the object form's formula and expression both, and keeps its run scope", () => {
    const when = { formula: "`contactMethod` = \"mail\"", expression: eq("contactMethod", "mail"), run: "server" as const };
    const renamed = renameConditionPaths(when, "contactMethod", "contact");
    expect(renamed).toEqual({ formula: 'contact = "mail"', expression: eq("contact", "mail"), run: "server" });
    expect(conditionReadsComponent(when, "contactMethod")).toBe(true);
    expect(conditionReadsComponent({ formula: "other = 1" }, "contactMethod")).toBe(false);
  });

  it("leaves an unrelated string, a string inside a tree and a formula that does not parse byte for byte", () => {
    const unrelated = 'country = "CA"';
    expect(renameConditionPaths(unrelated, "contactMethod", "contact")).toBe(unrelated);
    const literal: Expression = { kind: "binary", operator: "eq", left: path("other"), right: { kind: "literal", value: "contactMethod = 1" } };
    expect(renameConditionPaths(literal, "contactMethod", "contact")).toBe(literal);
    const broken = "contactMethod = ";
    expect(renameConditionPaths(broken, "contactMethod", "contact")).toBe(broken);
    const journey = journeyWithWhen(unrelated, broken);
    const renamed = renameJourneyReferences(journey, "contactMethod", "contact");
    // The page lists the component, so the id follows; the conditions are the very same strings.
    expect(renamed.pages[0]?.components).toEqual(["contact"]);
    expect(renamed.pages[0]?.routes?.[0]?.when).toBe(broken);
    expect(renamed.pages[1]).toBe(journey.pages[1]);
  });

  it("follows a form rename into a built designer's string conditions, and an own rename into a worked-out value's string", () => {
    const tree = treeFromJourney(journeyWithWhen('contactMethod = "mail"', 'contactMethod = "phone"'));
    const edits = journeyTreeRenames(tree, "contactMethod", "contact");
    expect(edits.map((edit) => [edit.property, edit.value])).toEqual([
      ["componentId", "contact"],
      ["when", 'contact = "phone"'],
      ["when", 'contact = "mail"']
    ]);
    const own = treeFromJourney({
      id: "apply",
      pages: [
        {
          id: "only",
          components: [
            { id: "m1", type: "number", configuration: { label: "Month 1" } },
            { id: "total", type: "journey-value", configuration: { to: "annual_income", value: "m1 * 12" } }
          ]
        }
      ]
    });
    expect(journeyOwnRenames(own, "m1", "month1").map((edit) => [edit.nodeId, edit.property, edit.value])).toEqual([["total", "value", "month1 * 12"]]);
  });
});
