import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { DEFAULT_SHARE_CARD, SHARE_CARDS, SHARE_CARD_SIZE, resolveSiteUrl, shareCardTags, siteRecord } from "../share-cards";

const page = `<!doctype html><html><head>
  <title>Datum: partners</title>
  <meta
    name="description"
    content="Three ways to use Datum:
      run it, embed it, deliver it."
  />
</head><body></body></html>`;

const contentOf = (tags: ReturnType<typeof shareCardTags>, key: string): string | undefined =>
  tags.find((tag) => tag.attrs?.property === key || tag.attrs?.name === key)?.attrs?.content as string | undefined;

describe("link previews", () => {
  it("names Argusvane as the home page's publisher, and only there", () => {
    const record = (tags: ReturnType<typeof shareCardTags>) => tags.find((tag) => tag.tag === "script" && tag.attrs?.type === "application/ld+json");
    const home = record(shareCardTags(page, "index.html", "https://datum.example"));
    expect(JSON.parse(String(home?.children))).toEqual({
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "Datum",
      url: "https://datum.example/",
      publisher: { "@type": "Organization", name: "Argusvane", url: "https://argusvane.com" }
    });
    expect(record(shareCardTags(page, "partners.html", "https://datum.example"))).toBeUndefined();
    expect(JSON.parse(siteRecord(undefined))).not.toHaveProperty("url");
  });

  it("takes the words from the page's own title and description", () => {
    const tags = shareCardTags(page, "partners.html", undefined);
    expect(contentOf(tags, "og:title")).toBe("Datum: partners");
    expect(contentOf(tags, "og:description")).toBe("Three ways to use Datum: run it, embed it, deliver it.");
    expect(contentOf(tags, "og:site_name")).toBe("Datum by Argusvane");
    expect(contentOf(tags, "author")).toBe("Argusvane");
    expect(tags.every((tag) => tag.injectTo === "head")).toBe(true);
  });

  it("leaves out the image and the address when the build does not know where the site is served", () => {
    const tags = shareCardTags(page, "partners.html", undefined);
    expect(contentOf(tags, "og:image")).toBeUndefined();
    expect(contentOf(tags, "og:url")).toBeUndefined();
    expect(contentOf(tags, "twitter:card")).toBe("summary");
  });

  it("names each page's own address as its canonical link, and has none without an address", () => {
    const canonical = (tags: ReturnType<typeof shareCardTags>): string | undefined => tags.find((tag) => tag.tag === "link" && tag.attrs?.rel === "canonical")?.attrs?.href as string | undefined;
    expect(canonical(shareCardTags(page, "partners.html", "https://datum.argusvane.com"))).toBe("https://datum.argusvane.com/partners.html");
    expect(canonical(shareCardTags(page, "index.html", "https://datum.argusvane.com/"))).toBe("https://datum.argusvane.com/");
    expect(canonical(shareCardTags(page, "index.html", undefined))).toBeUndefined();
  });

  it("serves from datum.argusvane.com at the root unless the build says otherwise", () => {
    expect(resolveSiteUrl({})).toBe("https://datum.argusvane.com/");
    expect(resolveSiteUrl({ SITE_URL: "", SITE_BASE: "" })).toBe("https://datum.argusvane.com/");
    expect(resolveSiteUrl({ SITE_BASE: "/preview/" })).toBe("https://datum.argusvane.com/preview/");
    expect(resolveSiteUrl({ SITE_URL: "https://example.org/datum" })).toBe("https://example.org/datum");
  });

  it("gives absolute addresses under the site's, the page's own card or the site's", () => {
    const partners = shareCardTags(page, "partners.html", "https://example.org/datum/");
    expect(contentOf(partners, "og:url")).toBe("https://example.org/datum/partners.html");
    expect(contentOf(partners, "og:image")).toBe("https://example.org/datum/og/partners.png");
    expect(contentOf(partners, "og:image:width")).toBe("1200");
    expect(contentOf(partners, "twitter:card")).toBe("summary_large_image");
    const home = shareCardTags(page, "index.html", "https://example.org");
    expect(contentOf(home, "og:url")).toBe("https://example.org/");
    expect(contentOf(home, "og:image")).toBe(`https://example.org/${DEFAULT_SHARE_CARD.image}`);
    expect(contentOf(home, "og:image:alt")).toBe(DEFAULT_SHARE_CARD.alt);
  });

  it("has every card it names under public/, at the size it declares", () => {
    for (const card of [DEFAULT_SHARE_CARD, ...Object.values(SHARE_CARDS)]) {
      const file = new URL(`../public/${card.image}`, import.meta.url);
      expect(existsSync(file), card.image).toBe(true);
      // A PNG's IHDR holds the width and height, big-endian, at bytes 16 and 20.
      const bytes = readFileSync(file);
      expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], card.image).toEqual([SHARE_CARD_SIZE.width, SHARE_CARD_SIZE.height]);
    }
  });
});
