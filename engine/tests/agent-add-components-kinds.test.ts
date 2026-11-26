import { describe, expect, it } from "vitest";
import { agentBuilder } from "./fixtures/agent-builder.js";

function nodeOf(builder: ReturnType<typeof agentBuilder>, id: string): any {
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
  return walk(builder.controller.snapshot());
}

const ROUTES: Array<[string, (components: unknown[]) => Record<string, unknown>]> = [
  ["add_components", (components) => ({ components })],
  ["replace_form", (components) => ({ components, keep: ["submit"] })]
];

describe.each(ROUTES)("%s refuses a configuration value of the wrong shape for its property", (tool, input) => {
  it.each([["yes"], [1], [{}], ["no"]])("configuration.required <- %j is bad-input and nothing changes", async (value) => {
    const builder = agentBuilder();
    const before = JSON.stringify(builder.controller.snapshot());
    const result: any = await builder.execute(tool, input([{ type: "text", id: "fresh", label: "Fresh", configuration: { required: value } }]));
    expect(result.ok).toBe(false);
    expect(result.code).toBe("bad-input");
    expect(result.details.problems[0].key).toBe("components[0].configuration.required");
    expect(JSON.stringify(builder.controller.snapshot())).toBe(before);
  });

  it.each([["min", "abc"], ["max", true], ["max", "1e999"]])("a number's configuration.%s <- %j is bad-input", async (key, value) => {
    const builder = agentBuilder();
    const result: any = await builder.execute(tool, input([{ type: "number", id: "qty", label: "Qty", configuration: { [key]: value } }]));
    expect(result.ok).toBe(false);
    expect(result.code).toBe("bad-input");
    expect(result.details.problems[0].key).toBe(`components[0].configuration.${key}`);
  });

  it("the documented coercions still land, with the same warning", async () => {
    const builder = agentBuilder();
    const result: any = await builder.execute(tool, input([{ type: "number", id: "qty", label: "Qty", configuration: { required: "TRUE", min: "3" } }]));
    expect(result.ok).toBe(true);
    expect(nodeOf(builder, "qty").configuration.required).toBe(true);
    expect(nodeOf(builder, "qty").configuration.min).toBe(3);
    expect(result.warnings).toContain('coerced: qty.required "TRUE" was written as true.');
    expect(result.warnings).toContain('coerced: qty.min "3" was written as 3.');
  });

  it("a right-shaped configuration passes unchanged", async () => {
    const builder = agentBuilder();
    const result: any = await builder.execute(tool, input([{ type: "number", id: "qty", label: "Qty", configuration: { required: true, min: 1, max: 9 } }]));
    expect(result.ok).toBe(true);
    expect(nodeOf(builder, "qty").configuration).toMatchObject({ required: true, min: 1, max: 9 });
  });
});
