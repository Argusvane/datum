/**
 * What the two agent element hosts share: the highlight's timing
 * and its renderer rule, the banner's and the live region's token-free base styles, and the
 * banner's button. The form's host (`agent-host.ts`, the form chunk) and the builder's
 * (`builder/agent-host.ts`, the builder chunk) each import it, and neither imports the other, so
 * each bundle's agent chunk carries its own host only. Nothing here runs at import time and
 * nothing names a theme token: each host draws its banner with its own surface's tokens (the
 * form's, or the studio's `--db-*`).
 */

/** How long a written component stays outlined. */
export const AGENT_HIGHLIGHT_MS = 1_500;

/**
 * The renderer's highlight rule , appended once to a `<datum-form>` renderer's
 * `extraStyles`: existing focus tokens only, no new theme token, motion off under
 * reduced motion. The builder's canvas draws its own from `CANVAS_CHROME_STYLES`.
 */
export const AGENT_HIGHLIGHT_RULE =
  "[data-agent-touched]{outline:var(--focus-ring-width,2px) solid var(--focus-ring-color,var(--color-accent,#2f6feb));outline-offset:var(--focus-ring-offset,2px);transition:outline-color .6s}@media(prefers-reduced-motion:reduce){[data-agent-touched]{transition:none}}";

/**
 * The banner's layout and the live region's clipping, with no token in them: the banner's line
 * takes the room its buttons leave, a hidden banner takes none, and the live region is clipped
 * the way every visually hidden status is (it is read, never seen).
 */
export const AGENT_UI_BASE_STYLES = `
[data-agent-banner][hidden]{display:none}
[data-agent-banner] p{flex:1 1 auto;margin:0}
[data-agent-banner] button{font:inherit}
[data-agent-live]{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}`;

/** A button of the banner (or the notice): `data-agent-<role>`, worded by the caller, with its click. */
export function button(role: string, label: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.setAttribute(`data-agent-${role}`, "");
  el.textContent = label;
  el.addEventListener("click", onClick);
  return el;
}
