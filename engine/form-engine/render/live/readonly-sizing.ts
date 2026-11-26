/**
 * A read-only textarea shows its whole answer, written once for every binding.
 *
 * A field showing an answer should not hide the end of it behind a scrollbar: a read-only
 * `<textarea>` in a field's wrapper is grown to its content height after every draw, and again
 * when its width changes (how tall the content is depends on how wide the box is, and the width
 * is not final when a draw lands: a hidden tab, a column still resolving, a font loading). An
 * editable one is left to its own `rows`, so a box that grew while typed in does not move the
 * page under the caret; one this module sized that turns editable is given its height back.
 *
 * A {@link LiveFeature} the host lists in `features`.
 */
import type { DrawnField, LiveFeature } from "./mount.js";

/** Marks a textarea this module has sized, so only its height is ever taken back. */
const SIZED_ATTRIBUTE = "data-readonly-sized";

function sizeToContent(textarea: HTMLTextAreaElement): void {
  // scrollHeight only reports the content while the box is not already sized past it.
  textarea.style.height = "auto";
  const { scrollHeight } = textarea;
  // Zero: no layout yet (a hidden tab, a detached subtree). A later measurement sizes it.
  if (scrollHeight === 0) {
    textarea.style.removeProperty("height");
    return;
  }
  // scrollHeight covers content and padding; the height set is a border-box one.
  const borders = textarea.offsetHeight - textarea.clientHeight;
  textarea.style.height = `${scrollHeight + Math.max(0, borders)}px`;
  textarea.setAttribute(SIZED_ATTRIBUTE, "");
}

function release(textarea: HTMLTextAreaElement): void {
  if (textarea.hasAttribute(SIZED_ATTRIBUTE)) {
    textarea.removeAttribute(SIZED_ATTRIBUTE);
    textarea.style.removeProperty("height");
  }
}

export function createReadonlySizingFeature(): LiveFeature {
  return {
    id: "readonly-sizing",
    afterDraw(_report, live) {
      for (const field of live.fields()) {
        const textarea = live.wrapperOf(field.key)?.querySelector("textarea");
        if (textarea) {
          if (field.state.readOnly && !field.state.disabled) {
            sizeToContent(textarea);
          } else {
            release(textarea);
          }
        }
      }
    },
    connectField(wrapper, field: DrawnField, live) {
      const textarea = wrapper.querySelector("textarea");
      if (!textarea || typeof ResizeObserver !== "function") {
        return undefined;
      }
      let width = textarea.clientWidth;
      const observer = new ResizeObserver(() => {
        const next = textarea.clientWidth;
        // Ignore the height-only change a measurement provokes.
        if (next !== width) {
          width = next;
          const current = live.field(field.key)?.state;
          if (current?.readOnly && !current.disabled) {
            sizeToContent(textarea);
          }
        }
      });
      observer.observe(textarea);
      return () => observer.disconnect();
    }
  };
}
