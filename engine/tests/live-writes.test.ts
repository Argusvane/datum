// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { FormEventType } from "../form-engine/core/events/event-types.js";
import type { DateFieldState, FieldAdapter } from "../form-engine/render/live/contract.js";
import { lit } from "../form-engine/render/live/lit.js";
import type { LiveFeature } from "../form-engine/render/live/mount.js";
import { bindingOf, cleanUp, definitionOf, handed, input, mounted, settled, textAdapter, type, wrapper } from "./live-extras-kit.js";

/*
 * What the renderer does with the writes an adapter reports (render/live/mount.ts): an interim
 * write (typing) is reported as committed once when the field is left, a final one (a pick) never
 * is, the leave-field check (validatePath) follows the form's `validateOn`, a date's parts are
 * composed by the runtime, and nothing is written into a box while an input method composes.
 */

afterEach(cleanUp);

const text = () => definitionOf([{ id: "name", type: "text", configuration: { label: "Name", required: true } }]);

function committed(runtime: { events(): { subscribe(type: string, listener: (event: { path?: unknown }) => void): () => void } }): string[] {
  const paths: string[] = [];
  runtime.events().subscribe(FormEventType.COMPONENT_COMMITTED, (event) => paths.push(JSON.stringify(event.path)));
  return paths;
}

describe("live writes: interim and commit", () => {
  it("reports an answer typed in as committed once, when the field is left", async () => {
    const { root, runtime } = await mounted(text());
    const heard: unknown[] = [];
    runtime.events().subscribe(FormEventType.COMPONENT_COMMITTED, (event) => heard.push(event.data));
    type(input(root, "name"), "Ann");
    expect(heard).toEqual([]);
    input(root, "name").dispatchEvent(new Event("change", { bubbles: true }));
    expect(heard).toEqual([{ value: "Ann" }]);
    input(root, "name").dispatchEvent(new Event("change", { bubbles: true }));
    expect(heard).toHaveLength(1);
  });

  it("reports nothing as committed for a field that was never typed in, but still runs the leave-field check", async () => {
    const { root, runtime } = await mounted(text(), { binding: bindingOf(lit, textAdapter(lit, { final: true })) });
    const check = vi.spyOn(runtime, "validatePath");
    const heard: unknown[] = [];
    runtime.events().subscribe(FormEventType.COMPONENT_COMMITTED, (event) => heard.push(event.data));
    type(input(root, "name"), "Ann");
    input(root, "name").dispatchEvent(new Event("change", { bubbles: true }));
    expect(heard).toEqual([]);
    expect(check).toHaveBeenCalledWith("name");
  });

  it("commits every answer still being typed on settleInput, once, and nothing for the rest", async () => {
    const { root, runtime, form } = await mounted(
      definitionOf([
        { id: "a", type: "text", configuration: { label: "A" } },
        { id: "b", type: "text", configuration: { label: "B" } }
      ])
    );
    const heard: unknown[] = [];
    runtime.events().subscribe(FormEventType.COMPONENT_COMMITTED, (event) => heard.push(event.data));
    form.settleInput();
    expect(heard).toEqual([]);
    type(input(root, "a"), "one");
    form.settleInput();
    form.settleInput();
    expect(heard).toEqual([{ value: "one" }]);
    // The commit that follows has nothing left to report.
    input(root, "a").dispatchEvent(new Event("change", { bubbles: true }));
    expect(heard).toHaveLength(1);
  });

  it("settles nothing after unmount", async () => {
    const { root, runtime, form } = await mounted(text());
    const heard: unknown[] = [];
    runtime.events().subscribe(FormEventType.COMPONENT_COMMITTED, (event) => heard.push(event.data));
    type(input(root, "name"), "Ann");
    form.unmount();
    form.settleInput();
    expect(heard).toEqual([]);
  });

  it("does not report a typed answer that a read-only field refused", async () => {
    const { root, runtime } = await mounted(definitionOf([{ id: "kept", type: "text", configuration: { label: "Kept", readOnly: true } }]));
    const heard = committed(runtime as never);
    handed.get("kept")?.input("x", { interim: true });
    handed.get("kept")?.commit();
    expect(heard).toEqual([]);
    expect(root.querySelector("input")?.value).toBe("");
  });
});

describe("live writes: the leave-field check follows validateOn", () => {
  const started = (runtime: { events(): { subscribe(type: string, listener: (event: { data?: unknown }) => void): () => void } }): unknown[] => {
    const seen: unknown[] = [];
    runtime.events().subscribe(FormEventType.VALIDATION_STARTED, (event) => seen.push(event.data));
    return seen;
  };

  it("does not check on a first blur, and checks a field already showing an error", async () => {
    const { root, runtime, form } = await mounted(text());
    const seen = started(runtime as never);
    input(root, "name").dispatchEvent(new Event("change", { bubbles: true }));
    await settled(form);
    expect(seen).toEqual([]);

    await runtime.validate();
    await settled(form);
    expect(wrapper(root, "name").hasAttribute("data-invalid")).toBe(true);
    seen.length = 0;
    type(input(root, "name"), "Ann");
    input(root, "name").dispatchEvent(new Event("change", { bubbles: true }));
    await settled(form);
    expect(seen).toEqual([{ paths: ["name"] }]);
    expect(wrapper(root, "name").hasAttribute("data-invalid")).toBe(false);
  });

  it("checks nothing on commit when the form validates on submit only", async () => {
    const definition = definitionOf([{ id: "name", type: "text", configuration: { label: "Name", required: true } }]);
    definition.root.configuration = { validateOn: "submit" };
    const { root, runtime, form } = await mounted(definition);
    await runtime.validate();
    await settled(form);
    const seen = started(runtime as never);
    type(input(root, "name"), "Ann");
    input(root, "name").dispatchEvent(new Event("change", { bubbles: true }));
    await settled(form);
    expect(seen).toEqual([]);
    // Still showing the error it had: the answer is checked on submit.
    expect(wrapper(root, "name").hasAttribute("data-invalid")).toBe(true);
  });

  it("reports a leave-field check that throws, and keeps the form going", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { root, runtime, errors, form } = await mounted(text());
    vi.spyOn(runtime, "validatePath").mockRejectedValue(new Error("stage blew up"));
    input(root, "name").dispatchEvent(new Event("change", { bubbles: true }));
    await settled(form);
    expect(errors).toEqual([expect.objectContaining({ hook: "validatePath", id: "name", message: "stage blew up" })]);
  });
});

describe("live writes: a date typed in part", () => {
  function dateAdapter({ html, live }: typeof lit): FieldAdapter<DateFieldState> {
    return {
      kind: "field",
      name: "kit-date",
      template: (s, on) => {
        handed.set(s.key, on);
        const read = (event: Event) => {
          const form = (event.target as HTMLElement).closest("fieldset") as HTMLElement;
          const part = (name: string) => (form.querySelector(`.${name}`) as HTMLInputElement).value;
          return { year: part("year"), month: part("month"), day: part("day") };
        };
        return html`<fieldset @input=${(event: Event) => on.parts(read(event), { interim: true })} @focusout=${() => on.commit()}>
          <legend>${s.label}</legend>
          <input class="day" .value=${live(s.parts.day)} /><input class="month" .value=${live(s.parts.month)} /><input class="year" .value=${live(s.parts.year)} />
        </fieldset>`;
      }
    };
  }
  /** Stands in for the per-kind state builder (fields.ts): the boxes' contents, typed or stored. */
  const dateState: LiveFeature = {
    id: "kit-date-state",
    fieldState: (state, _node, draw) => {
      if (state.kind !== "date") {
        return undefined;
      }
      const [year = "", month = "", day = ""] = state.value.split("-");
      return { ...state, parts: draw.live.typedParts(state.key, state.value) ?? { year, month, day }, missingParts: [] } as DateFieldState;
    }
  };
  const definition = () => definitionOf([{ id: "born", type: "date", configuration: { label: "Born" } }]);
  const binding = () => bindingOf(lit, textAdapter(lit), { components: { date: dateAdapter(lit) } });

  function typePart(root: ShadowRoot, part: "day" | "month" | "year", value: string): void {
    const box = wrapper(root, "born").querySelector<HTMLInputElement>(`.${part}`) as HTMLInputElement;
    box.value = value;
    box.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  }

  it("composes the answer through the runtime, keeps what was typed while the date is partial, and commits when the group is left", async () => {
    const { root, runtime, form } = await mounted(definition(), { binding: binding(), features: [dateState] });
    const compose = vi.spyOn(runtime, "setDateParts");
    const heard: unknown[] = [];
    runtime.events().subscribe(FormEventType.COMPONENT_COMMITTED, (event) => heard.push(event.data));
    typePart(root, "day", "5");
    await settled(form);
    expect(compose).toHaveBeenLastCalledWith("born", { year: "", month: "", day: "5" }, { interim: true });
    expect(runtime.state().values["born"] ?? "").toBe("");
    // The box keeps what was typed although the stored answer is empty.
    expect(wrapper(root, "born").querySelector<HTMLInputElement>(".day")?.value).toBe("5");
    expect(runtime.inputState("born")).toEqual({ incomplete: { missing: ["month", "year"] } });
    typePart(root, "month", "2");
    typePart(root, "year", "2020");
    await settled(form);
    expect(runtime.state().values["born"]).toBe("2020-02-05");
    expect(runtime.inputState("born")).toBeUndefined();
    expect(heard).toEqual([]);
    wrapper(root, "born").querySelector("fieldset")?.dispatchEvent(new Event("focusout", { bubbles: true }));
    expect(heard).toEqual([{ value: "2020-02-05" }]);
  });

  it("composes from a pick as a final write, with no interim record", async () => {
    const { root, runtime } = await mounted(definition(), { binding: binding(), features: [dateState] });
    const compose = vi.spyOn(runtime, "setDateParts");
    const heard: unknown[] = [];
    runtime.events().subscribe(FormEventType.COMPONENT_COMMITTED, (event) => heard.push(event.data));
    handed.get("born")?.parts({ year: "2020", month: "2", day: "5" });
    expect(compose).toHaveBeenLastCalledWith("born", { year: "2020", month: "2", day: "5" }, undefined);
    handed.get("born")?.commit();
    expect(heard).toEqual([]);
    expect(root.querySelector("fieldset")).not.toBeNull();
  });

  it("refuses a date typed into a read-only field and draws the stored answer back", async () => {
    const m = await mounted(definitionOf([{ id: "born", type: "date", configuration: { label: "Born", readOnly: true } }]), { binding: binding(), features: [dateState] });
    typePart(m.root, "day", "5");
    await settled(m.form);
    expect(m.runtime.state().values["born"]).toBeUndefined();
    expect(wrapper(m.root, "born").querySelector<HTMLInputElement>(".day")?.value).toBe("");
  });
});

describe("live writes: an input method composing", () => {
  it("holds the draw while text is being composed, so the box is not written into, and draws once it ends", async () => {
    const { root, runtime, form } = await mounted(text());
    const box = input(root, "name");
    const before = form.draws();
    box.dispatchEvent(new Event("compositionstart", { bubbles: true, composed: true }));
    box.value = "に";
    box.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    await settled(form);
    // The answer is stored, nothing was drawn, and the box still holds what the method put there.
    expect(runtime.state().values["name"]).toBe("に");
    expect(form.draws()).toBe(before);
    expect(box.value).toBe("に");
    box.value = "日本";
    box.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    box.dispatchEvent(new Event("compositionend", { bubbles: true, composed: true }));
    await settled(form);
    expect(form.draws()).toBe(before + 1);
    expect(input(root, "name")).toBe(box);
    expect(box.value).toBe("日本");
  });
});
