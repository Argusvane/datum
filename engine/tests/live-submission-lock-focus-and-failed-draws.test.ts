// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import type { FieldAdapter, TextFieldState } from "../form-engine/render/live/contract.js";
import { lit } from "../form-engine/render/live/lit.js";
import type { LiveFeature } from "../form-engine/render/live/mount.js";
import { bindingOf, cleanUp, definitionOf, input, mounted, quiet, settled, textAdapter, wrapper } from "./live-extras-kit.js";

/*
 * The submission lock: where focus goes when it lifts (a control the person moved to elsewhere on
 * the page keeps it; a design system's component that does not delegate focus gets it through its
 * field's focus target), and a draw whose commit throws (reported, the lock still applied, the
 * unmount still complete).
 */

afterEach(cleanUp);

const text = (id: string) => ({ id, type: "text", configuration: { label: id } }) as never;

class LockBox extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" }).innerHTML = "<input id=inner>";
  }
}
if (!customElements.get("lock-box")) {
  customElements.define("lock-box", LockBox);
}
class LockOuter extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" }).innerHTML = "<input id=search>";
  }
}
if (!customElements.get("lock-outer")) {
  customElements.define("lock-outer", LockOuter);
}

/** A text adapter whose template adds an element with a ref callback that throws while `boom()` holds. */
function throwingRefAdapter(boom: () => boolean): FieldAdapter<TextFieldState> {
  const base = textAdapter(lit);
  const cb = (element?: Element): void => {
    if (boom() && element) {
      throw new Error("ref boom");
    }
  };
  return { ...base, template: (s, on) => (boom() ? lit.html`<span ${lit.ref(cb)}></span>${base.template(s, on)}` : base.template(s, on)) };
}

describe("focus when the submission lock lifts", () => {
  it("leaves focus on a control elsewhere on the page that the person moved to while the lock held", async () => {
    quiet();
    const m = await mounted(definitionOf([text("a")]));
    const outside = document.createElement("input");
    document.body.append(outside);
    input(m.root, "a").focus();
    m.form.setBusy("submitting", true);
    await settled(m.form);
    // A browser moves focus out of the inert field; the person then goes to the page's own box.
    input(m.root, "a").blur();
    outside.focus();
    m.form.setBusy("submitting", false);
    await settled(m.form);
    expect(document.activeElement).toBe(outside);
    expect(m.root.activeElement).toBeNull();
  });

  it("leaves focus on a control inside another shadow root on the page", async () => {
    quiet();
    const m = await mounted(definitionOf([text("a")]));
    const outer = document.createElement("lock-outer");
    document.body.append(outer);
    input(m.root, "a").focus();
    m.form.setBusy("submitting", true);
    await settled(m.form);
    input(m.root, "a").blur();
    const search = outer.shadowRoot?.getElementById("search") as HTMLInputElement;
    search.focus();
    m.form.setBusy("submitting", false);
    await settled(m.form);
    expect(outer.shadowRoot?.activeElement).toBe(search);
    expect(m.root.activeElement).toBeNull();
  });

  it("puts focus back on the control that had it when focus was left on the page's body", async () => {
    quiet();
    const m = await mounted(definitionOf([text("a")]));
    input(m.root, "a").focus();
    m.form.setBusy("submitting", true);
    await settled(m.form);
    input(m.root, "a").blur();
    expect(document.activeElement).toBe(document.body);
    m.form.setBusy("submitting", false);
    await settled(m.form);
    expect(m.root.activeElement).toBe(input(m.root, "a"));
  });

  it("reaches a design system's component that does not delegate focus through the field's focus target", async () => {
    quiet();
    const adapter: FieldAdapter = {
      kind: "field",
      name: "lock-box",
      template: (s) => lit.html`<lock-box id=${s.id}></lock-box>`,
      focusTarget: (w) => (w.querySelector("lock-box") as HTMLElement).shadowRoot?.getElementById("inner") as HTMLElement
    };
    const m = await mounted(definitionOf([text("a")]), { binding: bindingOf(lit, adapter as never) });
    const box = m.root.querySelector("lock-box") as HTMLElement;
    const inner = box.shadowRoot?.getElementById("inner") as HTMLInputElement;
    inner.focus();
    expect(m.root.activeElement).toBe(box);
    m.form.setBusy("submitting", true);
    await settled(m.form);
    inner.blur();
    m.form.setBusy("submitting", false);
    await settled(m.form);
    expect(box.shadowRoot?.activeElement).toBe(inner);
    expect(m.errors).toEqual([]);
  });
});

describe("a draw whose commit throws", () => {
  it("is reported (hook render) and the submission lock is still applied, setBusy throwing nothing", async () => {
    quiet();
    let boom = false;
    const m = await mounted(definitionOf([text("a"), text("b")]), { binding: bindingOf(lit, throwingRefAdapter(() => boom)) });
    boom = true;
    expect(() => m.form.setBusy("submitting", true)).not.toThrow();
    expect(m.errors.map((e) => `${e.hook}: ${e.message}`)).toContain("render: ref boom");
    expect(wrapper(m.root, "a").hasAttribute("inert")).toBe(true);
    expect(wrapper(m.root, "b").hasAttribute("inert")).toBe(true);
  });

  it("thrown on a redraw is reported, not thrown at the caller", async () => {
    quiet();
    let boom = false;
    const m = await mounted(definitionOf([text("a")]), { binding: bindingOf(lit, throwingRefAdapter(() => boom)) });
    boom = true;
    expect(() => m.form.redraw()).not.toThrow();
    expect(m.errors.filter((e) => e.hook === "render")).toHaveLength(1);
  });

  it("thrown as the form is taken out on unmount still lets the unmount finish", async () => {
    quiet();
    let boom = false;
    // A callback that throws even as its element goes (lit calls it with nothing then).
    const cb = (): void => {
      if (boom) {
        throw new Error("ref boom");
      }
    };
    const base = textAdapter(lit);
    const adapter: FieldAdapter<TextFieldState> = { ...base, template: (s, on) => lit.html`<span ${lit.ref(cb)}></span>${base.template(s, on)}` };
    let stopped = false;
    const feature: LiveFeature = { id: "kit-stop", start: () => () => (stopped = true) };
    const m = await mounted(definitionOf([text("a")]), { binding: bindingOf(lit, adapter), features: [feature] });
    boom = true;
    expect(() => m.form.unmount()).not.toThrow();
    expect(stopped).toBe(true);
    expect(m.root.querySelector("form")).toBeNull();
    expect(m.form.fields()).toEqual([]);
  });
});
