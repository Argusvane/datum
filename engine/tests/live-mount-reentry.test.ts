// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import type { DataSourceSet } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { resolveAdapter, type FieldAdapter, type LiveBinding } from "../form-engine/render/live/contract.js";
import { lit } from "../form-engine/render/live/lit.js";
import { mountLive, type FormRegion, type LiveFeature, type TraceEntry } from "../form-engine/render/live/mount.js";
import { bindingOf, cleanUp, definitionOf, input, mounted, pause, quiet, runtimeOf, settled, textAdapter } from "./live-extras-kit.js";

/*
 * The draw loop against what runs inside it:
 * - a host listener that unmounts the form on an event raised mid-draw runs once the draw is
 *   over, and nothing is drawn, made or called after the unmount;
 * - nothing is drawn while an input method composes, whatever asks for the draw (a build already
 *   out, its provisional twin, a redraw); the end of the composition builds afresh;
 * - an adapter's `when` that throws is reported and counts as not holding: the next adapter draws;
 * - a region's views are keyed by feature, so one feature's view coming or going leaves the
 *   others' nodes (and the focus in them) in place.
 */

afterEach(cleanUp);

const text = (id: string, configuration: Record<string, unknown> = {}): ComponentNode => ({ id, type: "text", configuration: { label: id, ...configuration } }) as ComponentNode;

function shadowHost(): { host: HTMLElement; root: ShadowRoot } {
  const host = document.createElement("div");
  document.body.append(host);
  return { host, root: host.attachShadow({ mode: "open" }) };
}

describe("an unmount from a listener of an event raised mid-draw", () => {
  it("runs once the draw is over: no hook runs and nothing is drawn after it", async () => {
    quiet();
    const runtime = runtimeOf(definitionOf([text("good"), text("bad")]));
    const { host, root } = shadowHost();
    const base = textAdapter(lit);
    let unmounted = false;
    const hooksAfterUnmount: string[] = [];
    const adapter: FieldAdapter = {
      ...base,
      template: (s, on) => {
        if (s.key === "bad") {
          throw new Error("boom");
        }
        return base.template(s as never, on);
      },
      after: (_wrapper, s) => {
        if (unmounted) {
          hooksAfterUnmount.push(`after:${s.key}`);
        }
      }
    } as FieldAdapter;
    const feature: LiveFeature = {
      id: "watcher",
      afterDraw: () => {
        if (unmounted) {
          hooksAfterUnmount.push("afterDraw");
        }
      }
    };
    let form: { unmount(): void } | undefined;
    let formInRootAtEvent: boolean | undefined;
    host.addEventListener("datum-binding-error", () => {
      if (!unmounted && form) {
        // The draw is over when the host hears of the failure: the form it drew is in the root.
        formInRootAtEvent = root.querySelector("form.datum-live") !== null;
        unmounted = true;
        form.unmount();
      }
    });
    const trace: string[] = [];
    const mountedForm = mountLive(root, {
      runtime,
      binding: bindingOf(lit, adapter as never),
      datum: bindingOf(lit),
      features: [feature],
      trace: (entry: TraceEntry) => trace.push(`${entry.hook}:${entry.id ?? ""}`)
    });
    form = mountedForm;
    await mountedForm.ready.catch(() => undefined);
    await pause(5);
    expect(unmounted).toBe(true);
    expect(formInRootAtEvent).toBe(true);
    expect({
      formInRoot: root.querySelector("form.datum-live") !== null,
      afterUnmount: trace.slice(trace.indexOf("unmount:") + 1),
      hooksAfterUnmount
    }).toEqual({ formInRoot: false, afterUnmount: [], hooksAfterUnmount: [] });
  });

  it("hears every event the draw raised, in order, and none raised after the unmount", async () => {
    quiet();
    const runtime = runtimeOf(definitionOf([text("one"), text("two")]));
    const { host, root } = shadowHost();
    const base = textAdapter(lit);
    const adapter = { ...base, template: () => { throw new Error("no"); } } as unknown as FieldAdapter;
    const heard: string[] = [];
    let form: { unmount(): void } | undefined;
    host.addEventListener("datum-binding-error", (event) => {
      const detail = (event as CustomEvent<{ hook: string; id?: string }>).detail;
      heard.push(`${detail.hook}:${detail.id ?? ""}`);
      if (heard.length === 1) {
        form?.unmount();
      }
    });
    form = mountLive(root, { runtime, binding: bindingOf(lit, adapter as never), datum: bindingOf(lit) });
    await (form as unknown as { ready: Promise<void> }).ready.catch(() => undefined);
    await pause(5);
    // Both templates threw in one draw; the listener unmounted on the first, so the second was dropped.
    expect(heard).toEqual(["template:one"]);
    expect(root.querySelector("form.datum-live")).toBeNull();
  });

  it("an adapter hook that unmounts the form stops the draw where it is", async () => {
    quiet();
    const runtime = runtimeOf(definitionOf([text("first"), text("second")]));
    const { root } = shadowHost();
    const base = textAdapter(lit);
    let form: { unmount(): void } | undefined;
    const calls: string[] = [];
    const adapter = {
      ...base,
      after: (_wrapper: HTMLElement, s: { key: string }) => {
        calls.push(`after:${s.key}`);
        if (s.key === "first") {
          form?.unmount();
        }
      }
    } as unknown as FieldAdapter;
    const feature: LiveFeature = { id: "late", afterDraw: () => calls.push("afterDraw") };
    form = mountLive(root, { runtime, binding: bindingOf(lit, adapter as never), features: [feature] });
    await (form as unknown as { ready: Promise<void> }).ready.catch(() => undefined);
    await pause(5);
    expect(calls).toEqual(["after:first"]);
    expect(root.querySelector("form.datum-live")).toBeNull();
  });
});

describe("an input method composing", () => {
  const compose = (box: HTMLInputElement, phase: "start" | "end"): void => {
    box.dispatchEvent(new CompositionEvent(phase === "start" ? "compositionstart" : "compositionend", { bubbles: true, composed: true }));
  };

  it("holds the draw of a build already out, and draws the composed text afterwards", async () => {
    quiet();
    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    const sources: DataSourceSet = {
      has: (id) => id === "cities",
      ids: () => ["cities"],
      load: async () => {
        await gate;
        return { items: [{ value: "a", label: "Alpha" }] };
      }
    } as DataSourceSet;
    const definition = definitionOf([text("name"), { id: "city", type: "select", configuration: { label: "City", data: { sourceId: "cities" } } } as ComponentNode]);
    const { root, form, runtime } = await mounted(definition, { dataSources: sources });
    const box = input(root, "name");
    const before = form.draws();
    compose(box, "start");
    box.value = "ab";
    box.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    // The source the first build waits on answers mid-composition.
    release();
    await pause(10);
    expect({ draws: form.draws() - before, value: box.value }).toEqual({ draws: 0, value: "ab" });
    // A redraw a feature asks for is held too.
    form.redraw();
    expect(form.draws() - before).toBe(0);
    compose(box, "end");
    await settled(form);
    expect(form.draws() - before).toBeGreaterThan(0);
    expect(input(root, "name")).toBe(box);
    expect(box.value).toBe("ab");
    expect(runtime.state().values["name"]).toBe("ab");
  });
});

describe("an adapter's `when` that throws", () => {
  const picky = (throwWhen: () => boolean): FieldAdapter => {
    const base = textAdapter(lit);
    return {
      ...base,
      name: "picky",
      when: () => {
        if (throwWhen()) {
          throw new TypeError("variant is undefined");
        }
        return true;
      },
      template: (s, on) => lit.html`<div class="picky">${base.template(s as never, on)}</div>`
    } as FieldAdapter;
  };

  it("is reported under hook `when` and the next adapter draws", async () => {
    quiet();
    const base = textAdapter(lit);
    const binding: LiveBinding = bindingOf(lit, base);
    (binding.components as Record<string, unknown>).text = [picky(() => true), base];
    const { root, errors } = await mounted(definitionOf([text("name"), text("other")]), { binding });
    expect(root.querySelectorAll(".datum-live-field")).toHaveLength(2);
    expect(root.querySelector(".picky")).toBeNull();
    expect(errors.map((e) => `${e.hook}:${e.id ?? ""}`)).toEqual(["when:name", "when:other"]);
  });

  it("on a later draw, does not freeze the form or throw into the redraw's caller", async () => {
    quiet();
    let throwing = false;
    const base = textAdapter(lit);
    const binding: LiveBinding = bindingOf(lit, base);
    (binding.components as Record<string, unknown>).text = [picky(() => throwing), base];
    const { root, form, errors } = await mounted(definitionOf([text("name")]), { binding });
    expect(root.querySelector(".picky")).not.toBeNull();
    throwing = true;
    expect(() => form.redraw()).not.toThrow();
    expect(root.querySelector(".picky")).toBeNull();
    expect(root.querySelectorAll(".datum-live-field")).toHaveLength(1);
    expect(errors.map((e) => e.hook)).toEqual(["when"]);
  });

  it("counts as not holding in the lookup the renderer passes a test to", () => {
    const adapter = picky(() => true);
    const fallback = textAdapter(lit);
    const binding: LiveBinding = { id: "b", label: "B", components: { text: [adapter, fallback] } };
    expect(() => resolveAdapter(binding, undefined, "field", "text", "text", {})).toThrow(TypeError);
    const seen: string[] = [];
    const resolved = resolveAdapter(binding, undefined, "field", "text", "text", {}, (candidate, state) => {
      seen.push(candidate.name ?? "");
      try {
        return candidate.when(state) === true;
      } catch {
        return false;
      }
    });
    expect(seen).toEqual(["picky"]);
    expect(resolved?.adapter).toBe(fallback);
  });
});

describe("a region two features fill", () => {
  it("keeps the second feature's nodes, and the focus in them, when the first one's view appears", async () => {
    quiet();
    let noteOn = false;
    const note: LiveFeature = { id: "note", region: (region: FormRegion) => (region === "page-header" && noteOn ? lit.html`<p class="note">Required fields are marked</p>` : undefined) };
    const heading: LiveFeature = { id: "heading", region: (region: FormRegion) => (region === "page-header" ? lit.html`<h2 id="page-h" tabindex="-1">Page</h2>` : undefined) };
    const { root, form } = await mounted(definitionOf([text("name")]), { features: [note, heading] });
    const before = root.getElementById("page-h") as HTMLElement;
    before.focus();
    noteOn = true;
    form.redraw();
    const after = root.getElementById("page-h");
    expect({ sameNode: after === before, focused: root.activeElement === after }).toEqual({ sameNode: true, focused: true });
    expect(root.querySelector(".note + #page-h")).not.toBeNull();
    noteOn = false;
    form.redraw();
    expect(root.getElementById("page-h")).toBe(before);
    expect(root.querySelector(".note")).toBeNull();
  });
});
