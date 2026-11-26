import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error a plain module that the build runs as a script
import { pageAddresses, robotsTxt, siteUrlFrom, sitemapXml, writeCrawlFiles } from "../scripts/write-crawl-files.mjs";
import { resolveSiteUrl } from "../share-cards";

// sitemap.xml and robots.txt come from what the build produced. The address rule is share-cards.ts's
// (each page's canonical link), kept in step here.

const made: string[] = [];
function built(): string {
  const dir = mkdtempSync(join(tmpdir(), "datum-crawl-"));
  made.push(dir);
  mkdirSync(join(dir, "docs"));
  for (const file of ["index.html", "features.html", "404.html", "docs/index.html", "docs/introduction.html", "docs/404.html"]) writeFileSync(join(dir, file), "<!doctype html>");
  return dir;
}

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe("crawl files", () => {
  it("lists the marketing pages by file and the docs pages as clean URLs, never a 404", () => {
    const addresses = pageAddresses(built(), "https://datum.argusvane.com");
    expect(addresses).toEqual(["https://datum.argusvane.com/features.html", "https://datum.argusvane.com/", "https://datum.argusvane.com/docs/", "https://datum.argusvane.com/docs/introduction"]);
  });

  it("writes a sitemap and a robots.txt that names it", () => {
    const dir = built();
    writeCrawlFiles(dir, "https://datum.argusvane.com");
    expect(readFileSync(join(dir, "robots.txt"), "utf8")).toBe(robotsTxt("https://datum.argusvane.com"));
    expect(robotsTxt("https://datum.argusvane.com")).toContain("Sitemap: https://datum.argusvane.com/sitemap.xml");
    const sitemap = readFileSync(join(dir, "sitemap.xml"), "utf8");
    expect(sitemap).toBe(sitemapXml(pageAddresses(dir, "https://datum.argusvane.com")));
    expect(sitemap).toContain("<loc>https://datum.argusvane.com/docs/introduction</loc>");
  });

  it("takes the site's address the way the pages' canonical links do", () => {
    for (const env of [{}, { SITE_BASE: "/preview/" }, { SITE_URL: "https://example.org/datum/" }, { SITE_URL: " ", SITE_BASE: "/" }]) {
      expect(siteUrlFrom(env), JSON.stringify(env)).toBe(resolveSiteUrl(env).replace(/\/+$/, ""));
    }
  });
});
