/**
 * Tabs: a `[data-tabs]` list of `[role=tab]` buttons, each naming its panel by `aria-controls`.
 * The markup carries the initial state (`aria-selected`, `tabindex`, `hidden` on the panels);
 * this wires clicks and the arrow keys. Takes a root so a section built after the page loaded
 * (the live demo's renderer) can wire its own.
 */
export function wireTabs(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-tabs]").forEach((list) => {
    const tabs = [...list.querySelectorAll<HTMLButtonElement>("[role=tab]")];
    const panelOf = (tab: HTMLButtonElement) => document.getElementById(tab.getAttribute("aria-controls") ?? "");
    const select = (tab: HTMLButtonElement, focus: boolean) => {
      tabs.forEach((other) => {
        const on = other === tab;
        other.setAttribute("aria-selected", on ? "true" : "false");
        other.tabIndex = on ? 0 : -1;
        const panel = panelOf(other);
        if (panel) panel.hidden = !on;
      });
      if (focus) tab.focus();
    };
    tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => select(tab, false));
      tab.addEventListener("keydown", (event) => {
        const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (step === 0) return;
        event.preventDefault();
        select(tabs[(index + step + tabs.length) % tabs.length], true);
      });
    });
  });
}
