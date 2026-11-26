import { describe, expect, it } from "vitest";
import { agentBuilder } from "./fixtures/agent-builder.js";

const RISKY = "(a+)+$";
const riskyTree = {
  kind: "call",
  name: "matches",
  args: [
    { kind: "path", path: "name" },
    { kind: "literal", value: RISKY }
  ]
};

describe("agent-written rules go through the compile's guards", () => {
  it("set_properties refuses a formula holding a risky literal pattern, as formula-error", async () => {
    const builder = agentBuilder();
    const before = JSON.stringify(builder.controller.snapshot());
    const result: any = await builder.execute("set_properties", {
      edits: [{ componentId: "email", propertyPath: "rules.visibleWhen", value: `matches(email, "${RISKY}")` }]
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("formula-error");
    expect(result.details.problems[0].code).toBe("pattern.risky");
    expect(result.details.problems[0].message).toContain(RISKY);
    expect(JSON.stringify(builder.controller.snapshot())).toBe(before);
  });

  it("under partial the risky formula is skipped, not written", async () => {
    const builder = agentBuilder();
    const result: any = await builder.execute("set_properties", {
      partial: true,
      edits: [{ componentId: "email", propertyPath: "rules.visibleWhen", value: `matches(email, "${RISKY}")` }]
    });
    expect(result.ok).toBe(true);
    expect(result.written).toEqual([]);
    expect(result.skipped[0].problem.code).toBe("pattern.risky");
  });

  it("a safe pattern still parses", async () => {
    const builder = agentBuilder();
    const result: any = await builder.execute("set_properties", {
      edits: [{ componentId: "email", propertyPath: "rules.visibleWhen", value: 'matches(email, "^a+$")' }]
    });
    expect(result.ok).toBe(true);
  });

  it("check_form reports a tree rule holding a risky pattern, and a tree of no shape", async () => {
    const builder = agentBuilder();
    const root = builder.controller.snapshot();
    const put = (rule: unknown): void => {
      const walk = (node: any): void => {
        if (node.id === "email") {
          node.rules = { visibleWhen: rule };
        }
        for (const child of Object.values(node.children ?? {}).flat() as any[]) {
          walk(child);
        }
      };
      walk(root);
    };
    // A tree reaches a form through an import; `loadDefinition`-style hosts hand it to the controller whole.
    put(riskyTree);
    const loaded = agentBuilder({ root });
    const risky: any = await loaded.execute("check_form", {});
    const findings = (risky.findings ?? []) as Array<{ area: string; code: string; componentId?: string }>;
    expect(findings.some((finding) => finding.area === "formula" && finding.code === "pattern.risky" && finding.componentId === "email")).toBe(true);

    put({ kind: "binary", operator: "nope" });
    const malformed = agentBuilder({ root });
    const bad: any = await malformed.execute("check_form", {});
    expect(((bad.findings ?? []) as Array<{ area: string; componentId?: string }>).some((finding) => finding.area === "formula" && finding.componentId === "email")).toBe(true);
  });

  it("check_form and get_component report a stored rule of no recognised shape", async () => {
    for (const rule of [5, true, [1], { foo: 1 }, { expression: 5 }, { formula: 5 }]) {
      const root = agentBuilder().controller.snapshot();
      const walk = (node: any): void => {
        if (node.id === "email") {
          node.rules = { visibleWhen: rule };
        }
        for (const child of Object.values(node.children ?? {}).flat() as any[]) {
          walk(child);
        }
      };
      walk(root);
      const loaded = agentBuilder({ root });
      const checked: any = await loaded.execute("check_form", {});
      const findings = (checked.findings ?? []) as Array<{ area: string; componentId?: string }>;
      expect(checked.clean, JSON.stringify(rule)).toBe(false);
      expect(findings.some((finding) => finding.area === "formula" && finding.componentId === "email"), JSON.stringify(rule)).toBe(true);
    }
  });

  it("a cleared rule (null) and a blank formula are still fine", async () => {
    const root = agentBuilder().controller.snapshot();
    const walk = (node: any): void => {
      if (node.id === "email") {
        node.rules = { visibleWhen: null, requiredWhen: "" };
      }
      for (const child of Object.values(node.children ?? {}).flat() as any[]) {
        walk(child);
      }
    };
    walk(root);
    const checked: any = await agentBuilder({ root }).execute("check_form", {});
    expect(((checked.findings ?? []) as Array<{ area: string; componentId?: string }>).some((finding) => finding.area === "formula" && finding.componentId === "email")).toBe(false);
  });
});
