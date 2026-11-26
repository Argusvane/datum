import { describe, expect, it } from "vitest";

import { BuilderPreviewRuntime } from "../form-engine/builder/preview/builder-preview-runtime.js";
import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { FormEventType } from "../form-engine/core/events/event-types.js";
import { HOST_CONTEXT_MAX_DEPTH, plainHostContext } from "../form-engine/core/state/host-context.js";

/**
 * Host values in the builder's preview (Try it's Settings): what a rule reads under `host.`,
 * given to the preview in place, the answers typed kept, and held by the controller as session
 * state the definition never sees. The page property's sanitiser is the engine's.
 */

function form(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "name", type: "text", configuration: { label: "Name" } },
        { id: "note", type: "text", configuration: { label: "Admin note" }, rules: { visibleWhen: 'host.role = "admin"' } },
        { id: "region", type: "text", configuration: { label: "Region" }, rules: { value: 'coalesce(host.region, "none")' } }
      ]
    }
  } as unknown as ComponentNode;
}

const visible = (preview: BuilderPreviewRuntime, id: string): boolean => preview.effectiveStatesMap().get(id)?.visible ?? false;

describe("BuilderPreviewRuntime.setHostContext", () => {
  it("evaluates a host. rule with nothing until given values, then follows them in place", () => {
    const preview = new BuilderPreviewRuntime(form());
    preview.setValue("name", "Ada");
    expect(visible(preview, "note")).toBe(false);
    expect(preview.state().values.region).toBe("none");
    let initialized = 0;
    preview.events().subscribe(FormEventType.FORM_INITIALIZED, () => {
      initialized += 1;
    });
    preview.setHostContext({ role: "admin", region: "QC" });
    expect(visible(preview, "note")).toBe(true);
    expect(preview.state().values.region).toBe("QC");
    // The answers typed stay, and the form is drawn once.
    expect(preview.state().values.name).toBe("Ada");
    expect(initialized).toBe(1);
    preview.setHostContext({ role: "admin", region: "QC" });
    expect(initialized).toBe(1);
    preview.setHostContext(undefined);
    expect(visible(preview, "note")).toBe(false);
    expect(preview.state().values.region).toBe("none");
    expect(preview.hostContext()).toBeUndefined();
  });

  it("takes values from the start, and keeps them across a changed tree", () => {
    const preview = new BuilderPreviewRuntime(form());
    preview.setHostContext({ role: "admin" });
    const edited = form();
    edited.children!.content!.push({ id: "extra", type: "text", configuration: { label: "Extra" } } as unknown as ComponentNode);
    preview.setFormRoot(edited);
    expect(visible(preview, "note")).toBe(true);
  });

  it("copies what it is given, so the caller's record changing later changes nothing", () => {
    const preview = new BuilderPreviewRuntime(form());
    const given = { role: "admin" };
    preview.setHostContext(given);
    given.role = "visitor";
    expect(preview.hostContext()).toEqual({ role: "admin" });
    expect(visible(preview, "note")).toBe(true);
  });
});

describe("BuilderController host values", () => {
  it("holds them as a preview change, never an edit: the tree is as it was and there is nothing to undo", () => {
    const controller = new BuilderController({ initialRoot: form() });
    const before = JSON.stringify(controller.snapshot());
    const reasons: string[] = [];
    controller.on("change", (event) => reasons.push(event.reason));
    controller.setTryHostContext({ role: "admin" });
    expect(controller.tryHostContext()).toEqual({ role: "admin" });
    controller.setTryHostContext({ role: "admin" });
    controller.setTryHostContext(undefined);
    expect(controller.tryHostContext()).toBeUndefined();
    expect(reasons).toEqual(["preview", "preview"]);
    expect(JSON.stringify(controller.snapshot())).toBe(before);
    expect(controller.canUndo()).toBe(false);
  });
});

describe("plainHostContext, the one sanitiser for the page property and Try it's Settings", () => {
  it("keeps plain JSON, leaves out what JSON cannot carry with its path, and takes no list as a context", () => {
    expect(plainHostContext({ role: "admin", site: { id: 7 }, gone: undefined })).toEqual({ context: { role: "admin", site: { id: 7 } }, problems: [] });
    const kept = plainHostContext({ ok: 1, bad: Number.NaN, fn: () => 1 });
    expect(kept.context).toEqual({ ok: 1 });
    expect(kept.problems).toHaveLength(2);
    expect(plainHostContext(["a"]).context).toBeUndefined();
    expect(plainHostContext(null)).toEqual({ context: undefined, problems: [] });
    let deep: Record<string, unknown> = { leaf: true };
    for (let level = 0; level < HOST_CONTEXT_MAX_DEPTH + 2; level += 1) {
      deep = { next: deep };
    }
    expect(plainHostContext(deep).problems.length).toBeGreaterThan(0);
  });
});
