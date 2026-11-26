import { describe, expect, it } from "vitest";
import { agentBuilder } from "./fixtures/agent-builder.js";

function configOf(builder: ReturnType<typeof agentBuilder>, id: string): Record<string, unknown> | undefined {
  const walk = (node: any): any => {
    if (node.id === id) {
      return node;
    }
    for (const child of Object.values(node.children ?? {}).flat() as any[]) {
      const found = walk(child);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  };
  return walk(builder.controller.snapshot())?.configuration;
}

async function setOne(builder: ReturnType<typeof agentBuilder>, componentId: string, propertyPath: string, value: unknown, extra: Record<string, unknown> = {}): Promise<any> {
  return builder.execute("set_properties", { edits: [{ componentId, propertyPath, value }], ...extra });
}

describe("set_properties refuses a value of the wrong shape for its property", () => {
  it.each([["yes"], [1], [0], [{}], [[true]], ["false "], ["no"]])("required <- %j is bad-input and nothing is stored", async (value) => {
    const builder = agentBuilder();
    const before = JSON.stringify(configOf(builder, "message"));
    const result = await setOne(builder, "message", "required", value);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("bad-input");
    expect(result.details.problems[0].key).toBe("edits[0].value");
    expect(JSON.stringify(configOf(builder, "message"))).toBe(before);
  });

  it.each([["True", true], ["TRUE", true], ["false", false], ["FALSE", false], [true, true], [false, false]])("required <- %j is written as %j", async (value, stored) => {
    const builder = agentBuilder();
    const result = await setOne(builder, "message", "required", value);
    expect(result.ok).toBe(true);
    expect(configOf(builder, "message")?.required).toBe(stored);
    if (typeof value === "string") {
      expect(result.warnings).toContain(`coerced: message.required "${value}" was written as ${stored}.`);
    } else {
      expect(result.warnings ?? []).toEqual([]);
    }
  });

  it("null still clears the property", async () => {
    const builder = agentBuilder();
    expect((await setOne(builder, "message", "required", true)).ok).toBe(true);
    const result = await setOne(builder, "message", "required", null);
    expect(result.ok).toBe(true);
    expect(configOf(builder, "message")?.required).toBeUndefined();
  });

  it.each([["abc"], ["1e999"], [true], [{}], ["x"], [""]])("a number property <- %j is bad-input", async (value) => {
    const builder = agentBuilder();
    expect((await builder.execute("add_components", { components: [{ type: "number", id: "qty", label: "Qty" }] })).ok).toBe(true);
    const result = await setOne(builder, "qty", "min", value);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("bad-input");
    expect(configOf(builder, "qty")?.min).toBeUndefined();
  });

  it("a number property takes a finite number and a numeral text (with the coerced warning)", async () => {
    const builder = agentBuilder();
    expect((await builder.execute("add_components", { components: [{ type: "number", id: "qty", label: "Qty" }] })).ok).toBe(true);
    expect((await setOne(builder, "qty", "min", -1)).ok).toBe(true);
    expect(configOf(builder, "qty")?.min).toBe(-1);
    const text = await setOne(builder, "qty", "max", "12.5");
    expect(text.ok).toBe(true);
    expect(text.warnings).toContain('coerced: qty.max "12.5" was written as 12.5.');
    expect(configOf(builder, "qty")?.max).toBe(12.5);
  });

  it("under partial the wrong-shaped edit is skipped and the others are written", async () => {
    const builder = agentBuilder();
    const result: any = await builder.execute("set_properties", {
      partial: true,
      edits: [
        { componentId: "message", propertyPath: "required", value: "yes" },
        { componentId: "message", propertyPath: "label", value: "Changed" }
      ]
    });
    expect(result.ok).toBe(true);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ componentId: "message", propertyPath: "required", code: "bad-input" });
    expect(configOf(builder, "message")?.label).toBe("Changed");
    expect(configOf(builder, "message")?.required).toBeUndefined();
  });

  it.each([["chrome", "allowed"], ["messages", "x"], ["print", 5]])("the root's %s <- %j is bad-input", async (path, value) => {
    const builder = agentBuilder();
    const root = builder.controller.snapshot().id;
    const result = await setOne(builder, root, path, value);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("bad-input");
  });
});

describe("set_properties refuses a dotted path under a scalar property", () => {
  it.each([
    ["message", "required.x", "checkbox"],
    ["message", "required.when.y", "checkbox"]
  ])("%s %s is bad-input and the boolean stays", async (componentId, path) => {
    const builder = agentBuilder();
    expect((await setOne(builder, componentId, "required", true)).ok).toBe(true);
    const result = await setOne(builder, componentId, path, { a: 1 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("bad-input");
    expect(result.details.problems[0].key).toBe("edits[0].propertyPath");
    expect(result.details.problems[0].expected).toBe("required takes a checkbox; write it at required");
    expect(configOf(builder, componentId)?.required).toBe(true);
  });

  it("a number property's min.x is bad-input and the number stays", async () => {
    const builder = agentBuilder();
    expect((await builder.execute("add_components", { components: [{ type: "number", id: "qty", label: "Qty" }] })).ok).toBe(true);
    expect((await setOne(builder, "qty", "min", 3)).ok).toBe(true);
    const result = await setOne(builder, "qty", "min.x", { a: 1 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("bad-input");
    expect(result.details.problems[0].expected).toBe("min takes a number; write it at min");
    expect(configOf(builder, "qty")?.min).toBe(3);
  });

  it("under partial the dotted path is skipped and the others are written", async () => {
    const builder = agentBuilder();
    const result: any = await builder.execute("set_properties", {
      partial: true,
      edits: [
        { componentId: "message", propertyPath: "required.x", value: 1 },
        { componentId: "message", propertyPath: "label", value: "Changed" }
      ]
    });
    expect(result.ok).toBe(true);
    expect(result.skipped[0]).toMatchObject({ componentId: "message", propertyPath: "required.x", code: "bad-input" });
    expect(configOf(builder, "message")?.label).toBe("Changed");
  });
});

describe("set_properties refuses a dotted path under a scalar property whose own path is dotted", () => {
  it("data.answersFree.x is bad-input naming the real head and the checkbox stays", async () => {
    const builder = agentBuilder();
    expect((await setOne(builder, "topic", "data.answersFree", true)).ok).toBe(true);
    const result = await setOne(builder, "topic", "data.answersFree.x", { a: 1 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("bad-input");
    expect(result.details.problems[0].key).toBe("edits[0].propertyPath");
    expect(result.details.problems[0].expected).toBe("data.answersFree takes a checkbox; write it at data.answersFree");
    expect((configOf(builder, "topic")?.data as any)?.answersFree).toBe(true);
  });

  it("chrome.frame.x on the form root is bad-input and the select stays unwritten", async () => {
    const builder = agentBuilder();
    const before = JSON.stringify(configOf(builder, "root"));
    const result = await setOne(builder, "root", "chrome.frame.x", { a: 1 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("bad-input");
    expect(result.details.problems[0].expected).toBe("chrome.frame takes a select; write it at chrome.frame");
    expect(JSON.stringify(configOf(builder, "root"))).toBe(before);
  });
});
