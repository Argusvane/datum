import { describe, expect, it } from "vitest";

import { journeyOwnership } from "../form-engine/core/journey/journey-path.js";
import {
  PRESENTATION_SLOT,
  buildPresentationIndex,
  isPresentationKey,
  presentationContainerId,
  type PresentationIndex
} from "../form-engine/core/journey/presentation.js";
import { validateJourneyShape, type Journey, type PresentationNode } from "../form-engine/core/schema/journey.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { buildValuePaths } from "../form-engine/core/tree/data-scope.js";
import { parseComponentPath } from "../form-engine/core/tree/component-path.js";
import { collectFieldConstraints } from "../form-engine/validation/core/field-constraints.js";
import { kernelDefinesKey, kernelIsJourney, kernelKnownKeyShapes } from "../form-engine/validation/wasm/portable-kernel.js";
import { applyJourney, incomeExpression, presentationRoot, publicVariant } from "./fixtures/presentation-form.js";

/*
 * The presentation index: the nodes a journey owns as the browser runtime reads
 * them — where each answer lives, what fills and what works out which form field, and the
 * synthetic container a page is drawn from. It decides nothing about placement: that is the
 * ownership's, which the kernel reads too.
 */

function indexOf(journey: Journey, root: ComponentNode = presentationRoot()): PresentationIndex | undefined {
  const shapes = kernelKnownKeyShapes(root);
  return buildPresentationIndex(root, journey, journeyOwnership(root, journey), (key) => kernelDefinesKey(shapes, key));
}

describe("presentation index", () => {
  it("is absent for a journey of component ids alone", () => {
    expect(indexOf({ id: "plain", pages: [{ id: "one", components: ["email", "name"] }] })).toBeUndefined();
  });

  it("says where each own node's answer lives: an alias and a worked-out copy at the form field, any other field at its `@` key", () => {
    const index = indexOf(applyJourney()) as PresentationIndex;
    expect(index.presentationId).toBe("apply");
    expect(index.containerId).toBe("@apply");
    expect(index.order).toEqual(["work_email", "m1", "m2", "m3", "income_total"]);
    expect({ ...index.kindOf }).toEqual({ work_email: "alias", m1: "field", m2: "field", m3: "field", income_total: "worked-out" });
    expect({ ...index.pageOf }).toEqual({ work_email: "details", m1: "income", m2: "income", m3: "income", income_total: "income" });
    expect(index.order.map((id) => index.keyOf(id))).toEqual(["email", "@apply.m1", "@apply.m2", "@apply.m3", "annual_income"]);
    expect(index.keyOf("email")).toBeUndefined();
    expect(index.keyOf("nobody")).toBeUndefined();
    expect(index.idOfKey("@apply.m2")).toBe("m2");
    expect(index.idOfKey("email")).toBeUndefined();
    expect(index.idOfKey("@public.m2")).toBeUndefined();

    expect(index.aliases).toEqual([{ nodeId: "work_email", targetId: "email", targetPath: "email", pageId: "details" }]);
    expect(index.workedOut).toEqual([
      { nodeId: "income_total", targetId: "annual_income", targetPath: "annual_income", expression: incomeExpression(), sourceIds: ["m1", "m2", "m3"], pageId: "income" }
    ]);
    expect({ ...index.mapped }).toEqual({ work_email: true, income_total: true });
    // `assist` lists a form component; the other pages draw none themselves.
    expect(Object.keys(index.drawnOf)).toEqual(["assist"]);
    expect({ ...index.drawnOf.assist }).toEqual({ approved_amount: true });
  });

  it("follows the form field's own value path: a data key, a data-scoping container", () => {
    const root = presentationRoot();
    root.children?.content?.push({
      id: "contact",
      type: "container",
      configuration: { dataKey: "reach" },
      children: { content: [{ id: "phone", type: "text", configuration: { dataKey: "tel" } }] }
    });
    const journey: Journey = {
      id: "apply",
      pages: [
        {
          id: "only",
          components: [
            { id: "their_phone", type: "text", configuration: { fills: "phone" } },
            { id: "digits", type: "number" },
            { id: "phone_total", type: "journey-value", configuration: { to: "approved_amount", value: { kind: "path", path: "digits" } } }
          ]
        }
      ]
    };
    const index = indexOf(journey, root) as PresentationIndex;
    expect(index.keyOf("their_phone")).toBe("reach.tel");
    expect(index.aliasOf.their_phone).toEqual({ nodeId: "their_phone", targetId: "phone", targetPath: "reach.tel", pageId: "only" });
    // An alias is an own value field of its page: a worked-out value may read it.
    expect(index.workedOutOf.phone_total?.sourceIds).toEqual(["their_phone", "digits"]);
    // The own-field constraints read each answer where it lives.
    const paths = collectFieldConstraints(
      { id: "x", type: "form", configuration: {}, children: { content: [{ id: "their_phone", type: "text", configuration: { required: true } }, { id: "digits", type: "number", configuration: { required: true } }] } },
      { pathOf: (id) => index.keyOf(id) }
    ).map((constraint) => `${constraint.componentId}@${constraint.path}`);
    expect(paths).toEqual(["their_phone@reach.tel", "digits@@apply.digits"]);
  });

  it("builds a data-scoping container whose own path builder gives the `@` keys, a read-only copy for a worked-out value and a placeholder for each reference", () => {
    const index = indexOf(applyJourney()) as PresentationIndex;
    expect(index.root).toEqual({ id: "form", type: "form", configuration: {}, children: { [PRESENTATION_SLOT]: [index.container] } });
    expect(index.container.id).toBe("@apply");
    expect(index.container.type).toBe("container");
    const paths = buildValuePaths(index.root);
    expect(index.order.map((id) => paths.get(id))).toEqual(["@apply.work_email", "@apply.m1", "@apply.m2", "@apply.m3", "@apply.income_total"]);
    for (const id of ["m1", "m2", "m3"]) {
      expect(paths.get(id)).toBe(index.keyOf(id));
      expect(() => parseComponentPath(index.keyOf(id) as string)).not.toThrow();
    }
    expect(index.tree.find("income_total")).toEqual({
      id: "income_total",
      type: "number",
      configuration: { label: "Annual income", max: 1_000_000, readOnly: true, presentation: { kind: "worked-out", to: "annual_income" } }
    });
    expect(index.tree.ancestorsOf("m1").map((node) => node.id)).toEqual(["@apply", "form"]);

    // Its own label wins over the target's; with none, the target's stands.
    const relabelled = applyJourney();
    (relabelled.pages[1]?.components?.[3] as { configuration: Record<string, unknown> }).configuration = { to: "annual_income", value: incomeExpression() };
    expect((indexOf(relabelled) as PresentationIndex).nodeById.income_total?.configuration).toMatchObject({ label: "Annual income" });
    (relabelled.pages[1]?.components?.[3] as { configuration: Record<string, unknown> }).configuration = { to: "annual_income", value: incomeExpression(), label: "Yearly total" };
    expect((indexOf(relabelled) as PresentationIndex).nodeById.income_total?.configuration).toMatchObject({ label: "Yearly total", readOnly: true });

    const variant = indexOf(publicVariant()) as PresentationIndex;
    expect(variant.order).toEqual(["contact", "@public/ref-1", "@public/ref-2", "public_note"]);
    expect({ ...variant.kindOf }).toEqual({ contact: "layout", "@public/ref-1": "reference", "@public/ref-2": "reference", public_note: "content" });
    expect({ ...variant.parentOf }).toEqual({ "@public/ref-1": "contact", "@public/ref-2": "contact" });
    expect({ ...variant.referenceOf }).toEqual({
      "@public/ref-1": { id: "@public/ref-1", componentId: "email", pageId: "all" },
      "@public/ref-2": { id: "@public/ref-2", componentId: "name", pageId: "all" }
    });
    expect({ ...variant.mapped }).toEqual({ contact: true, "@public/ref-1": true, "@public/ref-2": true });
    expect({ ...variant.drawnOf.all }).toEqual({ email: true, name: true });
    expect(variant.keyOf("contact")).toBeUndefined();
    expect(variant.keyOf("public_note")).toBeUndefined();
    expect(variant.keyOf("@public/ref-1")).toBeUndefined();
  });

  it("uses what the ownership decided: an entry, a reference or a worked-out value it ignores is not in the index", () => {
    const journey: Journey = {
      id: "apply",
      pages: [
        {
          id: "details",
          components: [
            { id: "email", type: "text", configuration: { fills: "name" } },
            { id: "upload", type: "file" },
            { id: "box", type: "fieldset", children: { content: [{ type: "journey-field", configuration: { componentId: "ghost" } }, { type: "journey-field", configuration: { componentId: "name" } }] } },
            { id: "to_section", type: "text", configuration: { fills: "money" } },
            { id: "note", type: "html", configuration: { fills: "name" } },
            { id: "first_total", type: "journey-value", configuration: { to: "annual_income", value: { kind: "path", path: "to_section" } } },
            { id: "second_total", type: "journey-value", configuration: { to: "annual_income", value: { kind: "path", path: "to_section" } } },
            { type: "journey-field", configuration: { componentId: "approved_amount" } }
          ]
        }
      ]
    };
    const index = indexOf(journey) as PresentationIndex;
    expect(index.order).toEqual(["box", "@apply/ref-1", "to_section", "note", "first_total"]);
    expect({ ...index.kindOf }).toEqual({ box: "layout", "@apply/ref-1": "reference", to_section: "field", note: "content", first_total: "worked-out" });
    expect(index.referenceOf["@apply/ref-1"]?.componentId).toBe("name");
    expect(index.aliases).toEqual([]);
    expect(index.workedOut.map((mapping) => [mapping.nodeId, mapping.sourceIds])).toEqual([["first_total", ["to_section"]]]);
    // A reference at the top of a page is the component itself: drawn, and no node of the container.
    expect({ ...index.drawnOf.details }).toEqual({ name: true, approved_amount: true });
    const ownership = journeyOwnership(presentationRoot(), journey);
    expect(Object.keys(ownership.ownNodes ?? {}).sort()).toEqual(index.order.filter((id) => !id.startsWith("@")).sort());
  });

  it("tells an own answer's key from a form value: `@` and not defined by the form", () => {
    const defines = (key: string): boolean => key === "@rows" || key === "email";
    expect(isPresentationKey("@apply.m1", defines)).toBe(true);
    expect(isPresentationKey("@rows", defines)).toBe(false);
    expect(isPresentationKey("email", defines)).toBe(false);
    expect(isPresentationKey("apply.@m1", defines)).toBe(false);
    const index = indexOf(applyJourney()) as PresentationIndex;
    expect(index.isPresentationKey("@apply.m1")).toBe(true);
    expect(index.isPresentationKey("@anything")).toBe(true);
    expect(index.isPresentationKey("annual_income")).toBe(false);
  });

  it("keys own answers under `@<journey id>` exactly, and gives a journey whose id is outside the grammar nothing of its own (rule H)", () => {
    expect(presentationContainerId("apply")).toBe("@apply");
    expect(presentationContainerId("short_form-2")).toBe("@short_form-2");
    const own = (id: string): Journey => ({ id, pages: [{ id: "one", components: ["name", { id: "note", type: "text" }, { type: "journey-field", configuration: { componentId: "email" } }] }] });
    for (const id of ["my journey.v2", "a.b", "staff view"]) {
      const index = indexOf(own(id)) as PresentationIndex;
      expect(index.order, id).toEqual([]);
      expect(index.keyOf("note"), id).toBeUndefined();
      expect(index.container.children, id).toEqual({ content: [] });
      // What the page lists or references at its top is still drawn.
      expect({ ...index.drawnOf.one }, id).toEqual({ name: true, email: true });
    }
    // Ids that differ only outside the grammar no longer share a key space: `a_b` keeps its own.
    const kept = indexOf(own("a_b")) as PresentationIndex;
    expect(kept.keyOf("note")).toBe("@a_b.note");
    expect(parseComponentPath(kept.keyOf("note") as string).segments).toEqual([{ key: "@a_b" }, { key: "note" }]);
  });

  it("drops an entry whose own answer would live at a key the form defines, as the ownership does (rule I)", () => {
    const root = presentationRoot();
    root.children?.content?.push({ id: "rows", type: "repeatingSection", configuration: {}, collection: { collectionPath: "@apply.items" }, children: { content: [{ id: "sku", type: "text", configuration: {} }] } });
    const journey = applyJourney();
    journey.pages[0]?.components?.push({ id: "items", type: "textarea", configuration: { label: "Private notes" } }, { id: "items_note", type: "text" });
    const index = indexOf(journey, root) as PresentationIndex;
    expect(index.order).toEqual(["work_email", "items_note", "m1", "m2", "m3", "income_total"]);
    expect(index.keyOf("items")).toBeUndefined();
    expect(index.isPresentationKey("@apply.items")).toBe(false);
    const ownership = journeyOwnership(root, journey);
    expect(Object.keys(ownership.ownNodes ?? {}).sort()).toEqual([...index.order].sort());
    expect(ownership.membersOf.details).toEqual(["work_email", "items_note"]);
  });

  it("builds a slot named `__proto__` as a slot like any other: its fields are checked and its references drawn", () => {
    const journey = JSON.parse(
      '{"id":"j","pages":[{"id":"p","components":["annual_income",{"id":"box","type":"fieldset","children":{"__proto__":[{"type":"journey-field","configuration":{"componentId":"email"}},{"id":"own_req","type":"text","configuration":{"required":true}}]}}]}]}'
    ) as Journey;
    const index = indexOf(journey) as PresentationIndex;
    expect(index.order).toEqual(["box", "@j/ref-1", "own_req"]);
    const box = index.nodeById.box as ComponentNode;
    expect(Object.keys(box.children ?? {})).toEqual(["__proto__"]);
    expect(Object.prototype.hasOwnProperty.call(box.children, "__proto__")).toBe(true);
    expect((box.children as Record<string, ComponentNode[]>)["__proto__"]?.map((node) => node.id)).toEqual(["@j/ref-1", "own_req"]);
    expect(index.tree.find("own_req")?.id).toBe("own_req");
    expect(collectFieldConstraints(index.root, { pathOf: (id) => index.keyOf(id) }).map((constraint) => [constraint.componentId, constraint.path, constraint.required])).toEqual([["own_req", "@j.own_req", true]]);
  });

  it("builds an own layout nested 3,000 deep, which both shape checks accept, without running out of stack", () => {
    let deep: PresentationNode = { id: "bottom", type: "text", configuration: { fills: "email" } };
    for (let level = 0; level < 3000; level += 1) {
      deep = { id: `layer_${level}`, type: "fieldset", children: { content: [deep, ...(level === 1500 ? [{ id: "middle", type: "text" } as PresentationNode] : [])] } };
    }
    const journey: Journey = { id: "deep", pages: [{ id: "p", components: [deep, "annual_income"] }] };
    expect(validateJourneyShape(journey)).toEqual([]);
    expect(kernelIsJourney(journey)).toBe(true);
    const index = indexOf(journey) as PresentationIndex;
    expect(index.order).toHaveLength(3002);
    // Document order: each layer before what it holds, the middle field after the layers under it.
    expect(index.order.slice(0, 2)).toEqual(["layer_2999", "layer_2998"]);
    expect(index.order.indexOf("middle")).toBe(3001);
    expect(index.order[3000]).toBe("bottom");
    expect(index.keyOf("bottom")).toBe("email");
    expect(index.keyOf("middle")).toBe("@deep.middle");
    expect(index.parentOf.middle).toBe("layer_1500");
    expect({ ...index.mapped }.layer_2999).toBe(true);
    expect(index.aliases.map((alias) => alias.nodeId)).toEqual(["bottom"]);
    expect(index.tree.getRoot().id).toBe("form");
  });
});
