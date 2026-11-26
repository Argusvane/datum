// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ValidationResult, ValidationStage } from "../form-engine/core/schema/contracts.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { lit } from "../form-engine/render/live/lit.js";
import { html, render } from "../form-engine/render/live/lit.js";
import { noticesView } from "../form-engine/render/live/notices.js";
import type { RenderOutput } from "../form-engine/render/core/render-orchestrator.js";
import type { LiveFeature } from "../form-engine/render/live/mount.js";
import { bindingOf, cleanUp, definitionOf, input, mounted, runtimeOf, settled, textAdapter, wrapper } from "./live-extras-kit.js";

/*
 * Warnings and info (render/live/notices.ts) and a field's pending state: drawn by
 * the adapter per its capability answer, never as errors.
 */

afterEach(cleanUp);

const advice = (severity: "warning" | "info", message = "That is short."): ValidationStage => ({
  id: "advice",
  version: "1",
  validate: () => ({ errors: [{ code: "short", componentId: "nick", path: "nick", severity, stage: "advice", source: "client", message }] })
});

const definition = () => definitionOf([{ id: "nick", type: "text", configuration: { label: "Nickname", description: "What friends call you", messages: { short: "That is short." } } }]);

async function withNotice(severity: "warning" | "info", options: Parameters<typeof mounted>[1] = {}) {
  const def = definition();
  const m = await mounted(def, { runtime: runtimeOf(def, [createFieldConstraintsStage(def.root), advice(severity)]), ...options });
  await m.runtime.validate();
  await settled(m.form);
  return m;
}

describe("live notices: the standard drawing", () => {
  const words = (key: string): string => ({ noticeWarning: "Warning: ", noticeInfo: "Information: " })[key] ?? key;

  it("leads each message with its severity word, under the id the control is described by, and announces nothing", () => {
    const host = document.createElement("div");
    render(
      html`${noticesView({
        noticeId: "n__notice",
        words: words as never,
        notices: [
          { code: "a", severity: "warning", message: "Short." },
          { code: "b", severity: "info", message: "Saved." }
        ]
      })}`,
      host
    );
    const block = host.querySelector("#n__notice") as HTMLElement;
    expect(block.hasAttribute("role")).toBe(false);
    expect(block.hasAttribute("aria-live")).toBe(false);
    const lines = Array.from(block.querySelectorAll("p"));
    expect(lines.map((line) => line.textContent)).toEqual(["Warning: Short.", "Information: Saved."]);
    expect(lines.map((line) => line.getAttribute("data-severity"))).toEqual(["warning", "info"]);
  });

  it("draws nothing for a field without notices", () => {
    const host = document.createElement("div");
    render(html`${noticesView({ words: words as never, notices: [] })}`, host);
    expect(host.querySelector("[data-notices]")).toBeNull();
  });
});

describe("live notices: in a form", () => {
  it("describes the control by the notice, with the severity word from the form's texts, and never as an error", async () => {
    const outputs: RenderOutput[] = [];
    const watch: LiveFeature = { id: "watch", afterDraw: (report) => void outputs.push(report.output) };
    const { root } = await withNotice("warning", { features: [watch] });
    const box = wrapper(root, "nick");
    const notice = box.querySelector("[data-notices]") as HTMLElement;
    expect(notice.id).toBe("nick__notice");
    expect(notice.textContent?.replace(/\s+/g, " ").trim()).toBe("Warning: That is short.");
    const described = (input(root, "nick").getAttribute("aria-describedby") ?? "").split(" ");
    expect(described).toEqual([box.querySelector(".hint")?.id, "nick__notice"]);
    for (const id of described) {
      expect(root.getElementById(id), id).not.toBeNull();
    }
    expect(box.hasAttribute("data-invalid")).toBe(false);
    expect(input(root, "nick").hasAttribute("aria-invalid")).toBe(false);
    expect(box.querySelector(".error")).toBeNull();
    // Not in the summary, and not an error of the form.
    const last = outputs.at(-1);
    expect(last?.meta.errorSummary.entries).toEqual([]);
    expect(last?.meta.errorSummary.formEntries).toEqual([]);
  });

  it("words an info message with its own severity word", async () => {
    const { root } = await withNotice("info");
    expect(wrapper(root, "nick").querySelector("[data-notices]")?.textContent?.replace(/\s+/g, " ").trim()).toBe("Information: That is short.");
  });

  it("takes the severity word from a language pack the binding ships", async () => {
    const binding = bindingOf(lit, textAdapter(lit), { texts: { en: { noticeWarning: "Heads up: " } } });
    const { root } = await withNotice("warning", { binding });
    expect(wrapper(root, "nick").querySelector("[data-notices]")?.textContent?.replace(/\s+/g, " ").trim()).toBe("Heads up: That is short.");
  });

  it("leaves the notice id out of describedBy for a binding that draws no notices, and records the gap", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const binding = bindingOf(lit, textAdapter(lit, { capabilities: { notice: "none" } }));
    const { root, form } = await withNotice("warning", { binding });
    expect(wrapper(root, "nick").querySelector("[data-notices]")).not.toBeNull();
    // The adapter drew them anyway here; what the renderer owns is the id and the record.
    expect(input(root, "nick").getAttribute("aria-describedby")).not.toContain("nick__notice");
    expect(form.unsupported()).toContain("nick: notice");
  });
});

describe("live pending", () => {
  function remote(): { stage: ValidationStage; answer(): void } {
    let resolve!: (result: ValidationResult) => void;
    return {
      stage: { id: "remote", version: "1", kind: "async", paths: () => ["nick"], validate: () => new Promise<ValidationResult>((done) => (resolve = done)) },
      answer: () => resolve({ errors: [] })
    };
  }

  it("marks the wrapper pending and busy while a check of the field runs, and clears both after", async () => {
    const check = remote();
    const def = definition();
    const { root, runtime, form } = await mounted(def, { runtime: runtimeOf(def, [check.stage]) });
    const run = runtime.validate();
    await settled(form);
    const box = wrapper(root, "nick");
    expect(box.hasAttribute("data-pending")).toBe(true);
    expect(box.getAttribute("aria-busy")).toBe("true");
    // The form is busy with the whole-form check as well.
    expect(root.querySelector("form")?.getAttribute("aria-busy")).toBe("true");
    check.answer();
    await run;
    await settled(form);
    expect(box.hasAttribute("data-pending")).toBe(false);
    expect(box.hasAttribute("aria-busy")).toBe(false);
    expect(root.querySelector("form")?.hasAttribute("aria-busy")).toBe(false);
  });

  it("folds a word into the hint for a binding that can only say it in part, and only while the check runs", async () => {
    const check = remote();
    const def = definition();
    const binding = bindingOf(lit, textAdapter(lit, { capabilities: { pending: "degraded" } }));
    const { root, runtime, form } = await mounted(def, { binding, runtime: runtimeOf(def, [check.stage]) });
    const hint = (): string | undefined => wrapper(root, "nick").querySelector(".hint")?.textContent ?? undefined;
    expect(hint()).toBe("What friends call you");
    const run = runtime.validate();
    await settled(form);
    expect(hint()).toBe("What friends call you Checking this answer…");
    expect(input(root, "nick").getAttribute("aria-describedby")).toBe(wrapper(root, "nick").querySelector(".hint")?.id);
    check.answer();
    await run;
    await settled(form);
    expect(hint()).toBe("What friends call you");
    expect(form.unsupported()).toEqual([]);
  });

  it("records a binding that draws no pending state, and still marks the wrapper", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const check = remote();
    const def = definition();
    const binding = bindingOf(lit, textAdapter(lit, { capabilities: { pending: "none" } }));
    const { root, runtime, form } = await mounted(def, { binding, runtime: runtimeOf(def, [check.stage]) });
    const run = runtime.validate();
    await settled(form);
    expect(wrapper(root, "nick").hasAttribute("data-pending")).toBe(true);
    expect(form.unsupported()).toContain("nick: pending");
    check.answer();
    await run;
  });
});
