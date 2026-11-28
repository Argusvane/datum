/**
 * Reading a stand-in option list (the Settings panel's simulated data sources): the
 * text the author types or pastes into a source's box, as the options Try it and the canvas load
 * in place of the source's own answer.
 *
 * Its own module, below the shell, so the browser-assistant tools
 * (`try_it { action: 'settings' }`) read a list exactly as the Settings panel does without
 * reaching into `default-builder-element.ts`, which the agent layer may only name as a type.
 */
import type { LocalizedText } from "../../core/schema/contracts.js";
import { MAX_IMPORTED_OPTIONS, MAX_IMPORTED_OPTIONS_BYTES } from "../../core/schema/inline-options.js";
import type { BuilderWords } from "../logic/builder-texts.js";

/**
 * A simulated list as the Settings panel's box takes it: one option a line, `value | label` (the
 * label optional), or a JSON array of `{ value, label }`. A message when it cannot be read.
 */
export function parseSimulatedOptions(text: string, words: BuilderWords): Array<{ value: string; label: LocalizedText }> | string {
  const trimmed = text.trim();
  // The same caps as an options file: the list is stored, re-serialised on
  // every sync and loaded as options by the canvas.
  const tooLarge = words.text("settings.sources.tooLarge", { max: MAX_IMPORTED_OPTIONS });
  if (trimmed.length > MAX_IMPORTED_OPTIONS_BYTES) {
    return tooLarge;
  }
  if (trimmed.startsWith("[")) {
    try {
      const list = JSON.parse(trimmed) as unknown;
      if (!Array.isArray(list)) {
        return words.text("settings.sources.json.notList");
      }
      if (list.length > MAX_IMPORTED_OPTIONS) {
        return tooLarge;
      }
      const items: Array<{ value: string; label: LocalizedText }> = [];
      for (const entry of list) {
        if (typeof entry === "string") {
          items.push({ value: entry, label: entry });
        } else if (entry && typeof entry === "object" && "value" in entry) {
          const value = String((entry as { value: unknown }).value);
          const label = (entry as { label?: unknown }).label;
          // A label is plain text or LocalizedText ({ default, locales, key }), as a source's items carry.
          const localized =
            label && typeof label === "object" && typeof (label as { default?: unknown }).default === "string" ? (label as LocalizedText) : undefined;
          items.push({ value, label: typeof label === "string" ? label : localized ?? value });
        } else {
          return words.text("settings.sources.json.needsValue");
        }
      }
      return items;
    } catch {
      return words.text("settings.sources.json.unreadable");
    }
  }
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length > MAX_IMPORTED_OPTIONS) {
    return tooLarge;
  }
  return lines.map((line) => {
    const bar = line.indexOf("|");
    const value = (bar < 0 ? line : line.slice(0, bar)).trim();
    const label = bar < 0 ? value : line.slice(bar + 1).trim() || value;
    return { value, label };
  });
}
