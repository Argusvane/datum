// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BindingErrorDetail, FieldAdapter, TextFieldState } from "../form-engine/render/live/contract.js";
import { lit } from "../form-engine/render/live/lit.js";
import { mountLive, type LiveFeature, type LiveForm, type LiveMountOptions } from "../form-engine/render/live/mount.js";
import { bindingOf, cleanUp, definitionOf, input, mounted, pause, quiet, runtimeOf, textAdapter, textState } from "./live-extras-kit.js";

/*
 * The mount's life before `ready`: a request while the features prepare, a first build overtaken by
 * one that fails, a field's `ready` hook against an unmounted form, the ready budget's edges; and
 * the order of the ids a field is described by when its hint is made by folding.
 */

const forms: LiveForm[] = [];
afterEach(() => {
  for (const form of forms.splice(0)) {
    form.unmount();
  }
  cleanUp();
});

const text = (id: string, configuration: Record<string, unknown> = {}) => ({ id, type: "text", configuration: { label: id, ...configuration } }) as never;

function mount(options: Partial<LiveMountOptions> & Pick<LiveMountOptions, "runtime">): { root: ShadowRoot; form: LiveForm; errors: BindingErrorDetail[] } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  const errors: BindingErrorDetail[] = [];
  host.addEventListener("datum-binding-error", (event) => errors.push((event as CustomEvent<BindingErrorDetail>).detail));
  const form = mountLive(root, { binding: bindingOf(lit), ...options });
  forms.push(form);
  return { root, form, errors };
}

describe("a request while the features prepare", () => {
  it("draws nothing until the features are prepared and started, then draws once", async () => {
    quiet();
    const log: string[] = [];
    let finish!: () => void;
    const slow: LiveFeature = {
      id: "kit-slow",
      prepare: () => new Promise<void>((done) => (finish = done)),
      start: () => {
        log.push("start");
      },
      afterDraw: (report) => {
        log.push(`afterDraw ${report.draw}`);
      }
    };
    const adapter: FieldAdapter<TextFieldState> = {
      ...textAdapter(lit),
      ready: async () => {
        log.push("ready");
      }
    };
    const { root, form } = mount({ runtime: runtimeOf(definitionOf([text("a")])), binding: bindingOf(lit, adapter), features: [slow] });
    form.request();
    await pause(20);
    expect(root.querySelector("form")).toBeNull();
    expect(form.draws()).toBe(0);
    expect(log).toEqual([]);
    finish();
    await form.ready;
    expect(log).toEqual(["start", "afterDraw 1", "ready"]);
    expect(form.draws()).toBe(1);
    expect(root.querySelector("form")?.hasAttribute("data-settling")).toBe(false);
  });
});

describe("a first build overtaken by one that fails", () => {
  it("rejects ready, draws the alert and reports hook render", async () => {
    quiet();
    let reads = 0;
    // Handed as it is (not spread), so the getter is read at each build.
    const options = {
      runtime: runtimeOf(definitionOf([text("a")])),
      binding: bindingOf(lit),
      get messages() {
        reads += 1;
        if (reads >= 2) {
          throw new Error("bad messages");
        }
        return undefined;
      }
    } as LiveMountOptions;
    const host = document.createElement("div");
    document.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    const errors: BindingErrorDetail[] = [];
    host.addEventListener("datum-binding-error", (event) => errors.push((event as CustomEvent<BindingErrorDetail>).detail));
    const form = mountLive(root, options);
    forms.push(form);
    // A setting changed in the same task as the mount: its build overtakes the first.
    form.request();
    await expect(form.ready).rejects.toThrow("bad messages");
    expect(form.draws()).toBe(0);
    expect(root.querySelector('[role="alert"]')).not.toBeNull();
    expect(errors.map((e) => `${e.hook}: ${e.message}`)).toEqual(["render: bad messages"]);
  });
});

describe("a field's ready hook", () => {
  it("is not run once the form is unmounted before it would run", async () => {
    quiet();
    const seen: boolean[] = [];
    let form: LiveForm | undefined;
    const adapter = { ...textAdapter(lit), ready: async (w: HTMLElement) => {
        seen.push(w.isConnected);
      }
    } as FieldAdapter;
    const killer: LiveFeature = { id: "kit-killer", afterDraw: () => form?.unmount() };
    form = mount({ runtime: runtimeOf(definitionOf([text("a")])), binding: bindingOf(lit, adapter as never), features: [killer] }).form;
    await form.ready.catch(() => undefined);
    await pause(10);
    expect(seen).toEqual([]);
  });

  it("of the binding is not run once the form is unmounted before it would run", async () => {
    quiet();
    let form: LiveForm | undefined;
    const killer: LiveFeature = { id: "kit-killer", afterDraw: () => form?.unmount() };
    const bindingReady = vi.fn();
    form = mount({ runtime: runtimeOf(definitionOf([text("a")])), binding: bindingOf(lit, textAdapter(lit), { ready: bindingReady }), features: [killer] }).form;
    await form.ready.catch(() => undefined);
    await pause(10);
    expect(bindingReady).not.toHaveBeenCalled();
  });
});

describe("the ready budget", () => {
  const slowAdapter = (): FieldAdapter => ({ ...textAdapter(lit), ready: () => pause(40) }) as FieldAdapter;

  for (const budget of [Number.POSITIVE_INFINITY, 2 ** 31, 2 ** 40]) {
    it(`of ${budget} ms reports no field as late`, async () => {
      quiet();
      const { root, form, errors } = mount({ runtime: runtimeOf(definitionOf([text("a")])), binding: bindingOf(lit, slowAdapter() as never), readyBudgetMs: budget });
      await form.ready;
      await pause(20);
      expect(errors).toEqual([]);
      expect(root.querySelector(".datum-live-alert")).toBeNull();
    });
  }

  for (const budget of [-1, Number.NaN]) {
    it(`of ${String(budget)} is warned about and the default budget used`, async () => {
      quiet();
      const { form, errors } = mount({ runtime: runtimeOf(definitionOf([text("a")])), binding: bindingOf(lit, slowAdapter() as never), readyBudgetMs: budget });
      await form.ready;
      expect(errors).toEqual([]);
      expect(vi.mocked(console.warn).mock.calls.some(([message]) => String(message).includes("readyBudgetMs"))).toBe(true);
    });
  }
});

describe("describedBy with a hint made by folding", () => {
  it("names the folded hint before the drawn tooltip", async () => {
    quiet();
    const pending: LiveFeature = { id: "kit-pending", fieldState: (s) => ({ ...s, pending: true }) };
    const adapter = textAdapter(lit, { capabilities: { pending: "degraded", tooltip: "drawn" } });
    const m = await mounted(definitionOf([text("a", { tooltip: "Tip" })]), { binding: bindingOf(lit, adapter), features: [textState, pending] });
    expect(input(m.root, "a").getAttribute("aria-describedby")).toBe("a__description a__tooltip");
  });
});
