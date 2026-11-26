/**
 * One Tab stop per toolbar (the ARIA toolbar pattern), the one implementation every builder bar
 * uses: the canvas bar, the selection bar, the journey map's bars and Print's toolbar.
 *
 * - Left and Right move between the tools, in the direction the bar reads (right to left
 *   included), wrapping at the ends; Home and End go to the first and the last.
 * - A tool that is hidden (by an attribute or by CSS: a folded card, a container query) or
 *   disabled is skipped. `aria-disabled` tools stay reachable, as the pattern asks.
 * - The Tab stop stays on the tool last focused while it still shows; otherwise it goes to the
 *   first tool that does. It is put right again whenever tools are added, removed, hidden,
 *   shown, enabled or disabled, and, for a bar whose tools a container query folds
 *   (`watchSize`), when its size changes.
 *
 * Only `tabindex` is written. Keys typed into a text box inside a bar are left to the box.
 */

const ROVE_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);

/** Whether a tool can take the Tab stop now: in the page, shown and enabled. */
function usable(tool: HTMLElement): boolean {
  if ((tool as HTMLButtonElement).disabled || tool.closest("[hidden]")) {
    return false;
  }
  // checkVisibility sees display: none on any ancestor; a DOM without it reads the tool's own style.
  return typeof tool.checkVisibility === "function" ? tool.checkVisibility() : getComputedStyle(tool).display !== "none";
}

/**
 * Makes `bar` one Tab stop over the elements `selector` finds in it (buttons by default). Returns
 * `sync`, which puts the Tab stop right at once (the bar also does so itself, a task later, after
 * any change to its tools).
 */
export function rovingToolbar(bar: HTMLElement, selector = "button", watchSize = false): () => void {
  let last: HTMLElement | undefined;
  const tools = (): HTMLElement[] => [...bar.querySelectorAll<HTMLElement>(selector)];
  let waiting: ResizeObserver | undefined;
  const sync = (): void => {
    const all = tools();
    const shown = all.filter(usable);
    // Nothing shows: the bar is put right once it is laid out (it gets a size).
    if (shown.length === 0 && all.length > 0 && !waiting && !watchSize && typeof ResizeObserver === "function") {
      waiting = new ResizeObserver(() => {
        if (tools().some(usable)) {
          waiting?.disconnect();
          waiting = undefined;
          sync();
        }
      });
      waiting.observe(bar);
    }
    // A bar with nothing showing (not laid out yet, or hidden with its surface) keeps the stop it had, or
    // its first tool: it is never left with none, since nothing tells it when it shows again.
    const stop = (last && shown.includes(last) ? last : shown[0]) ?? all.find((tool) => tool.tabIndex === 0 && tool.hasAttribute("tabindex")) ?? all[0];
    for (const tool of all) {
      const index = tool === stop ? "0" : "-1";
      if (tool.getAttribute("tabindex") !== index) {
        tool.setAttribute("tabindex", index);
      }
    }
  };
  bar.addEventListener("focusin", (event) => {
    const tool = (event.target as HTMLElement).closest?.<HTMLElement>(selector);
    if (tool && bar.contains(tool) && tool !== last) {
      last = tool;
      sync();
    }
  });
  bar.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement;
    if (!ROVE_KEYS.has(event.key) || event.altKey || event.ctrlKey || event.metaKey || target.matches("input, textarea, select, [contenteditable]")) {
      return;
    }
    const shown = tools().filter(usable);
    const at = shown.indexOf(target.closest<HTMLElement>(selector) as HTMLElement);
    if (at < 0) {
      return;
    }
    const forward = (event.key === "ArrowRight") !== (getComputedStyle(bar).direction === "rtl");
    const next = event.key === "Home" ? 0 : event.key === "End" ? shown.length - 1 : (at + (forward ? 1 : -1) + shown.length) % shown.length;
    event.preventDefault();
    last = shown[next];
    sync();
    last?.focus();
  });
  if (typeof MutationObserver === "function") {
    // Only a real change: a paint that writes an attribute its tool already has moves nothing.
    new MutationObserver((records) => {
      if (records.some((record) => record.type === "childList" || record.oldValue !== (record.target as Element).getAttribute(record.attributeName!))) {
        sync();
      }
    }).observe(bar, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ["hidden", "disabled"] });
  }
  if (watchSize && typeof ResizeObserver === "function") {
    new ResizeObserver(sync).observe(bar);
  }
  sync();
  return sync;
}
