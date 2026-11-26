import { describe, expect, it } from "vitest";

import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { ComponentTree, assertAcyclicComponentTree, duplicateComponentIds } from "../form-engine/core/tree/component-tree.js";
import { assertValidComponentId, isValidComponentId } from "../form-engine/core/tree/component-id.js";

function fixture(): ComponentNode {
  return {
    id: "rootForm",
    type: "container",
    configuration: {},
    children: {
      children: [
        {
          id: "personalSection",
          type: "section",
          configuration: {},
          children: {
            content: [
              { id: "firstName", type: "text", configuration: {} },
              { id: "lastName", type: "text", configuration: {} }
            ]
          }
        }
      ]
    }
  };
}

describe("component tree", () => {
  it("finds relationships", () => {
    const tree = new ComponentTree(fixture());

    expect(tree.find("firstName")?.type).toBe("text");
    expect(tree.parentOf("firstName")?.id).toBe("personalSection");
    expect(tree.ancestorsOf("firstName").map((n) => n.id)).toEqual([
      "personalSection",
      "rootForm"
    ]);
  });

  it("inserts and removes nodes", () => {
    const tree = new ComponentTree(fixture());

    tree.insert(
      { id: "email", type: "text", configuration: {} },
      "personalSection",
      "content"
    );
    expect(tree.find("email")).toBeDefined();

    tree.remove("email");
    expect(tree.find("email")).toBeUndefined();
  });

  it("moves nodes across slots", () => {
    const tree = new ComponentTree(fixture());

    tree.insert(
      {
        id: "addressSection",
        type: "section",
        configuration: {},
        children: { content: [] }
      },
      "rootForm",
      "children"
    );

    tree.move("lastName", "addressSection", "content", 0);

    expect(tree.parentOf("lastName")?.id).toBe("addressSection");
    expect(tree.childrenOf("personalSection", "content").map((n) => n.id)).toEqual([
      "firstName"
    ]);
  });
});

describe("ComponentTree ids and cycles", () => {
  const leaf = (id: string): ComponentNode => ({ id, type: "text", configuration: {} });
  const box = (id: string, kids: ComponentNode[]): ComponentNode => ({ id, type: "container", configuration: {}, children: { content: kids } });

  it("insert refuses a subtree whose nested id is one the tree already has", () => {
    const tree = new ComponentTree(box("root", [leaf("a")]));
    expect(() => tree.insert(box("bx", [leaf("a")]), "root", "content")).toThrow(/Duplicate component id: a/);
    expect(tree.descendantsOf("root").map((n) => n.id)).toEqual(["a"]);
  });

  it("insert refuses a subtree that repeats an id of its own", () => {
    const tree = new ComponentTree(box("root", []));
    expect(() => tree.insert(box("bx", [leaf("q"), leaf("q")]), "root", "content")).toThrow(/Duplicate component id: q/);
    expect(tree.descendantsOf("root")).toEqual([]);
  });

  it("insert still places a subtree whose ids are all new", () => {
    const tree = new ComponentTree(box("root", [leaf("a")]));
    tree.insert(box("bx", [leaf("p"), leaf("q")]), "root", "content");
    expect(tree.descendantsOf("root").map((n) => n.id)).toEqual(["a", "bx", "p", "q"]);
  });

  function cyclic(): ComponentNode {
    const root: ComponentNode = box("root", []);
    const section = box("s", [leaf("t"), root]);
    root.children!.content!.push(section);
    return root;
  }

  it("a cyclic definition fails with a message that names the component, instead of exhausting the heap", () => {
    expect(() => new ComponentTree(cyclic())).toThrow(/cycle at component "root"/);
    expect(() => assertAcyclicComponentTree(cyclic())).toThrow(/cycle at component "root"/);
    const tree = new ComponentTree(box("top", []));
    expect(() => tree.insert(cyclic(), "top", "content")).toThrow(/cycle/);
  });

  it("the same object under two parents is not a cycle", () => {
    const shared = leaf("x");
    expect(() => assertAcyclicComponentTree(box("root", [box("a", [shared]), box("b", [shared])]))).not.toThrow();
  });

  it("a very deep tree is checked and copied without exhausting the stack", () => {
    let node: ComponentNode = leaf("n0");
    for (let i = 1; i < 20000; i += 1) {
      node = box(`n${i}`, [node]);
    }
    expect(() => assertAcyclicComponentTree(node)).not.toThrow();
    expect(() => new ComponentTree(node)).not.toThrow();
  });

  it("duplicateComponentIds lists each repeated id once", () => {
    expect(duplicateComponentIds(box("root", [leaf("x"), box("g", [leaf("x"), leaf("y")]), leaf("y"), leaf("x")]))).toEqual(["x", "y"]);
    expect(duplicateComponentIds(box("root", [leaf("a"), leaf("b")]))).toEqual([]);
    expect(duplicateComponentIds(cyclic())).toEqual([]);
  });
});

describe("component ids the translations map cannot key", () => {
  it("refuses __proto__, constructor and prototype, and accepts their lookalikes", () => {
    for (const id of ["__proto__", "constructor", "prototype"]) {
      expect(isValidComponentId(id), id).toBe(false);
      expect(() => assertValidComponentId(id), id).toThrow(/cannot be a component id/);
    }
    for (const id of ["constructors", "Constructor", "prototype2", "my-prototype", "proto"]) {
      expect(isValidComponentId(id), id).toBe(true);
    }
  });
});
