// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import type { CharacterCount, TextFieldState } from "../form-engine/render/live/contract.js";
import { createAnnouncerFeature } from "../form-engine/render/live/announcer.js";
import type { LiveFeature } from "../form-engine/render/live/mount.js";
import { lit } from "../form-engine/render/live/lit.js";
import { bindingOf, cleanUp, definitionOf, input, mounted, pause, settled, textAdapter, type } from "./live-extras-kit.js";

/*
 * The character-count announcer (render/live/announcer.ts): one polite region for the
 * form, the focused field only, after a pause, and only for an adapter that draws the count and
 * leaves the announcing to the renderer.
 */

afterEach(cleanUp);

const DELAY = 40;
const definition = () =>
  definitionOf([
    { id: "bio", type: "text", configuration: { label: "Bio", maxLength: 10, characterCount: true } },
    { id: "other", type: "text", configuration: { label: "Other", maxLength: 10, characterCount: true } }
  ]);

/** Stands in for the per-kind state builder (fields.ts): the count and its words. */
const counts: LiveFeature = {
  id: "kit-counts",
  fieldState: (state) => {
    const max = 10;
    const count = [...state.value].length;
    const characterCount: CharacterCount = { max, count, left: max - count, over: count > max, limit: `Up to ${max}`, limitId: `${state.id}__count`, status: `${max - count} left` };
    return { ...state, characterCount } as TextFieldState;
  }
};

const region = (root: ShadowRoot): HTMLElement => root.querySelector<HTMLElement>("[data-count-announcer]") as HTMLElement;

async function typed(root: ShadowRoot, form: Parameters<typeof settled>[0], id: string, value: string): Promise<void> {
  const box = input(root, id);
  box.focus();
  type(box, value);
  await settled(form);
}

describe("live announcer", () => {
  it("draws one polite region for the whole form", async () => {
    const { root } = await mounted(definition(), { features: [counts, createAnnouncerFeature({ delayMs: DELAY })] });
    expect(root.querySelectorAll("[data-count-announcer]")).toHaveLength(1);
    expect(region(root).getAttribute("role")).toBe("status");
    expect(region(root).getAttribute("aria-live")).toBe("polite");
    expect(region(root).textContent).toBe("");
  });

  it("reads the count of the field being typed in once typing pauses, with the words as they then stand", async () => {
    const { root, form } = await mounted(definition(), { features: [counts, createAnnouncerFeature({ delayMs: DELAY })] });
    await typed(root, form, "bio", "ab");
    await typed(root, form, "bio", "abc");
    expect(region(root).textContent).toBe("");
    await pause(DELAY * 3);
    expect(region(root).textContent).toBe("7 left");
  });

  it("restarts the wait on each keystroke", async () => {
    const { root, form } = await mounted(definition(), { features: [counts, createAnnouncerFeature({ delayMs: DELAY * 3 })] });
    await typed(root, form, "bio", "a");
    await pause(DELAY * 2);
    await typed(root, form, "bio", "ab");
    await pause(DELAY * 2);
    expect(region(root).textContent).toBe("");
    await pause(DELAY * 3);
    expect(region(root).textContent).toBe("8 left");
  });

  it("announces nothing for a value set elsewhere, for a field without focus, or on the first draw", async () => {
    const { root, runtime, form } = await mounted(definition(), { features: [counts, createAnnouncerFeature({ delayMs: DELAY })] });
    runtime.setValue("bio", "set by a rule");
    await settled(form);
    input(root, "other").focus();
    runtime.setValue("bio", "set again");
    await settled(form);
    await pause(DELAY * 3);
    expect(region(root).textContent).toBe("");
  });

  it("stays silent for a component that counts and announces by itself, and for a count it draws only in part", async () => {
    for (const adapter of [
      textAdapter(lit, { behaviour: { countsCharacters: "component" } }),
      textAdapter(lit, { capabilities: { characterCount: "degraded" } }),
      textAdapter(lit, { capabilities: { characterCount: "none" } })
    ]) {
      const { root, form } = await mounted(definition(), { binding: bindingOf(lit, adapter), features: [counts, createAnnouncerFeature({ delayMs: DELAY })] });
      await typed(root, form, "bio", "abc");
      await pause(DELAY * 3);
      expect(region(root).textContent).toBe("");
      form.unmount();
    }
  });

  it("does not write after the form unmounts, and does not write a count again that has not changed", async () => {
    const { root, form } = await mounted(definition(), { features: [counts, createAnnouncerFeature({ delayMs: DELAY })] });
    await typed(root, form, "bio", "abc");
    const live = region(root);
    form.unmount();
    await pause(DELAY * 3);
    expect(live.textContent).toBe("");

    const again = await mounted(definition(), { features: [counts, createAnnouncerFeature({ delayMs: DELAY })] });
    const writes: string[] = [];
    await typed(again.root, again.form, "bio", "abc");
    const target = region(again.root);
    new MutationObserver((records) => records.forEach(() => writes.push(target.textContent ?? ""))).observe(target, { childList: true, characterData: true });
    await pause(DELAY * 3);
    await typed(again.root, again.form, "bio", "abcd");
    await typed(again.root, again.form, "bio", "abc");
    await pause(DELAY * 3);
    // The words the wait ended on are the ones already said: a live region would read them again.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(writes).toEqual(["7 left"]);
  });
});
