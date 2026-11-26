/**
 * The site's light and dark theme: `data-theme="dark"` on the document element, or no attribute
 * for light (the default). The header's toggle chooses it, and nothing else does: the live demo's
 * builder follows it (render-demo.ts) and never sets it. The choice is kept for the next page
 * under `datum-theme`; each page's inline head script reads it before first paint.
 */
export type SiteTheme = "dark" | "light";

const THEME_KEY = "datum-theme";

/** The theme the page shows now. */
export function siteTheme(): SiteTheme {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

/** The theme chosen on an earlier page view, when one was. */
export function storedSiteTheme(): SiteTheme | null {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

/** Shows a theme: the document's attribute and the toggle buttons' state. Stores nothing. */
export function applySiteTheme(theme: SiteTheme): void {
  // Light is the default: the attribute is only ever "dark" or absent.
  if (theme === "dark") document.documentElement.setAttribute("data-theme", "dark");
  else document.documentElement.removeAttribute("data-theme");
  document.querySelectorAll<HTMLButtonElement>("[data-theme-toggle]").forEach((button) => {
    button.setAttribute("aria-label", theme === "dark" ? "Switch to the light theme" : "Switch to the dark theme");
    button.dataset.theme = theme;
  });
}

/** A person's choice: shown, and kept for the next page. */
export function chooseSiteTheme(theme: SiteTheme): void {
  applySiteTheme(theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage may be unavailable (private window, blocked site data); the choice lasts the page view.
  }
}
