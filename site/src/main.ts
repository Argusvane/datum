import { ARGUSVANE_URL } from "./argusvane";
import { wireHero } from "./hero";
import { wireHeroVideo } from "./hero-video";
import { highlightCode } from "./highlight";
import { CONTACT_EMAIL, GITHUB_URL } from "./pillars";
import { renderBindings } from "./render-bindings";
import { renderContent } from "./render-content";
import { renderDemo } from "./render-demo";
import { renderPillars } from "./render-pillars";
import { applySiteTheme, chooseSiteTheme, siteTheme, storedSiteTheme } from "./site-theme";
import { wireTabs } from "./tabs";

function wireThemeToggle(): void {
  applySiteTheme(storedSiteTheme() ?? "light");
  document.querySelectorAll<HTMLButtonElement>("[data-theme-toggle]").forEach((button) => {
    button.addEventListener("click", () => chooseSiteTheme(siteTheme() === "dark" ? "light" : "dark"));
  });
}

function markCurrentPage(): void {
  const here = location.pathname.split("/").pop() || "index.html";
  document.querySelectorAll<HTMLAnchorElement>("nav a[href]").forEach((link) => {
    const href = link.getAttribute("href") ?? "";
    if (href.includes("#") || href.includes(":") || href.endsWith("/")) return; // anchors, external links and the docs site (a folder) are never "the page"
    const target = href.split("/").pop() || "index.html";
    if (target === here) link.setAttribute("aria-current", "page");
    // A link that stands for several pages (Examples, over its sub-pages) is current on each of them; a name ending in * stands for every page that starts with it.
    else if ((link.dataset.pages ?? "").split(/\s+/).some((page) => (page.endsWith("*") ? here.startsWith(page.slice(0, -1)) : page === here))) link.setAttribute("aria-current", "true");
  });
}

function fillRepositoryLinks(): void {
  document.querySelectorAll<HTMLAnchorElement>("a[data-github]").forEach((link) => {
    link.href = GITHUB_URL;
  });
  // A file in the repository (the licence, the policies): the repository's address, then the file.
  document.querySelectorAll<HTMLAnchorElement>("a[data-github-file]").forEach((link) => {
    link.href = `${GITHUB_URL}/blob/main/${link.dataset.githubFile}`;
  });
  document.querySelectorAll<HTMLAnchorElement>("a[data-contact]").forEach((link) => {
    link.href = `mailto:${CONTACT_EMAIL}`;
  });
  document.querySelectorAll<HTMLAnchorElement>("a[data-argusvane]").forEach((link) => {
    link.href = ARGUSVANE_URL;
  });
}

wireThemeToggle();
markCurrentPage();
wireHero();
wireHeroVideo();
wireTabs();
renderPillars();
renderContent();
renderDemo();
renderBindings();
highlightCode();
// Last: the partners page renders its own GitHub and contact links, which take the addresses here.
fillRepositoryLinks();
