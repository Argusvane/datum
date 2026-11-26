/**
 * The character-count announcer, written once for every binding.
 *
 * The visible count changes with every keystroke, so it is not read out as it changes. Once typing
 * pauses, the same words go into one polite live region for the whole form, so a burst of typing
 * is followed by one announcement. Only the field being typed in is announced: its value changed
 * in this draw and focus is inside its wrapper. A first draw, a field appearing, a locale switch
 * or a value set by a rule announce nothing, and each keystroke restarts the wait.
 *
 * It speaks only for a field whose adapter draws the count (`characterCount: "drawn"`) and leaves
 * the announcing to the renderer (`behaviour.countsCharacters: "renderer"`, the default). A
 * component that counts and announces by itself says `"component"` and this stays silent: two
 * announcers would read every count twice. The words are the field's `characterCount.status`, as
 * they stand when the pause ends, never those of the keystroke that started the wait.
 */
import { html } from "./lit.js";
import { behaviourOf, capabilityOf, type TextFieldState } from "./contract.js";
import type { LiveContext, LiveFeature } from "./mount.js";

/** How long typing pauses before a count is read out. */
export const COUNT_ANNOUNCE_DELAY_MS = 1000;

/** The live region the announcer writes into. */
export const COUNT_ANNOUNCER_ATTRIBUTE = "data-count-announcer";

export interface AnnouncerOptions {
  /** The pause after the last keystroke, in ms. */
  delayMs?: number;
}

export function createAnnouncerFeature(options: AnnouncerOptions = {}): LiveFeature {
  const delay = options.delayMs ?? COUNT_ANNOUNCE_DELAY_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waiting: string | undefined;
  /** The field whose words the region holds: another field reaching the same words is a new announcement. */
  let spoken: string | undefined;
  const lastValues = new Map<string, string>();

  const cancel = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = undefined;
    waiting = undefined;
  };

  return {
    id: "announcer",

    start() {
      return () => {
        cancel();
        lastValues.clear();
        spoken = undefined;
      };
    },

    region(region) {
      return region === "live" ? html`<div class="datum-live-sr-only" role="status" aria-live="polite" aria-atomic="true" data-count-announcer></div>` : undefined;
    },

    afterDraw(_report, live: LiveContext) {
      const seen = new Set<string>();
      for (const field of live.fields()) {
        const key = field.key;
        seen.add(key);
        const value = field.state.value;
        const previous = lastValues.get(key);
        lastValues.set(key, value);
        const count = (field.state as TextFieldState).characterCount;
        const adapter = field.adapter;
        if (
          count === undefined ||
          previous === undefined ||
          previous === value ||
          capabilityOf(adapter, "characterCount") !== "drawn" ||
          behaviourOf(adapter).countsCharacters !== "renderer"
        ) {
          continue;
        }
        const wrapper = live.wrapperOf(key);
        const active = live.root.activeElement;
        if (!wrapper || !active || !wrapper.contains(active)) {
          continue;
        }
        cancel();
        waiting = key;
        // Another field than the one the region last spoke for: emptied when typing starts, so the
        // words written at the pause are a change even when they equal the ones already there (a
        // second field reaching "7 left"). The same field ending on the words it said is not repeated.
        if (spoken !== key) {
          const region = live.root.querySelector<HTMLElement>(`[${COUNT_ANNOUNCER_ATTRIBUTE}]`);
          if (region) {
            region.textContent = "";
          }
        }
        timer = setTimeout(() => {
          timer = undefined;
          const words = (live.field(key)?.state as TextFieldState | undefined)?.characterCount?.status;
          const target = live.root.querySelector<HTMLElement>(`[${COUNT_ANNOUNCER_ATTRIBUTE}]`);
          waiting = undefined;
          // The region was emptied when typing began: a live region announces what is written into it.
          if (live.mounted() && target && words !== undefined && target.textContent !== words) {
            target.textContent = words;
            spoken = key;
          }
        }, delay);
      }
      for (const key of [...lastValues.keys()]) {
        if (!seen.has(key)) {
          lastValues.delete(key);
        }
      }
      if (waiting !== undefined && !seen.has(waiting)) {
        cancel();
      }
    }
  };
}
