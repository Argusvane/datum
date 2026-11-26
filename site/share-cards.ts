import { basename } from "node:path";
import type { HtmlTagDescriptor, Plugin } from "vite";
import site from "./site.json";

/**
 * Link previews and the canonical address for every page: Open Graph and Twitter tags made from
 * the page's own `<title>` and meta description, so a link pasted into an email, a chat or a post
 * shows the words the page shows, and a `rel="canonical"` link naming the page's own address.
 * The card image and the addresses must be absolute, so they are added only when the build
 * knows the site's full address: `SITE_URL` (base path included) when set, else the site's
 * origin in site.json under `SITE_BASE`. `shareCardTags` itself given no address returns the words alone.
 */

/** The site's full address for a build: `SITE_URL` as given, else the origin in site.json under `SITE_BASE` ("/" by default). */
export function resolveSiteUrl(env: Record<string, string | undefined> = process.env): string {
  const given = env.SITE_URL?.trim();
  if (given) return given;
  return new URL(env.SITE_BASE?.trim() || "/", site.origin).toString();
}

/** The card each page shows, under `public/`; a page not listed shows the site's own. */
export const SHARE_CARDS: Record<string, { image: string; alt: string }> = {
  "partners.html": { image: "og/partners.png", alt: "Datum partners: run it, embed it, deliver it." }
};

export const DEFAULT_SHARE_CARD = { image: "og/datum.png", alt: "Datum: sovereign forms. Your forms, your data, your environment." };

/** The cards' size, as `scripts/render-share-cards.mjs` draws them. */
export const SHARE_CARD_SIZE = { width: 1200, height: 630 };

function textOf(pattern: RegExp, html: string): string | undefined {
  const value = pattern.exec(html)?.[1]?.replace(/\s+/g, " ").trim();
  return value ? value : undefined;
}

/** The tags for one page: `page` is its file name (`index.html`), `siteUrl` the site's full address or `undefined`. */
export function shareCardTags(html: string, page: string, siteUrl: string | undefined): HtmlTagDescriptor[] {
  // A page standing for "no such address" has no address of its own to preview or index.
  if (page === "404.html") return [];
  const title = textOf(/<title>([^<]*)<\/title>/, html);
  const description = textOf(/<meta\s+name="description"\s+content="([^"]*)"/, html);
  const meta = (key: "property" | "name", name: string, content: string): HtmlTagDescriptor => ({
    tag: "meta",
    attrs: { [key]: name, content },
    injectTo: "head"
  });
  const tags: HtmlTagDescriptor[] = [meta("property", "og:type", "website"), meta("property", "og:site_name", "Datum")];
  if (title) {
    tags.push(meta("property", "og:title", title));
  }
  if (description) {
    tags.push(meta("property", "og:description", description));
  }
  const base = siteUrl?.trim().replace(/\/+$/, "");
  if (!base) {
    tags.push(meta("name", "twitter:card", "summary"));
    return tags;
  }
  const card = SHARE_CARDS[page] ?? DEFAULT_SHARE_CARD;
  const address = `${base}/${page === "index.html" ? "" : page}`;
  tags.push(
    { tag: "link", attrs: { rel: "canonical", href: address }, injectTo: "head" },
    meta("property", "og:url", address),
    meta("property", "og:image", `${base}/${card.image}`),
    meta("property", "og:image:width", String(SHARE_CARD_SIZE.width)),
    meta("property", "og:image:height", String(SHARE_CARD_SIZE.height)),
    meta("property", "og:image:alt", card.alt),
    meta("name", "twitter:card", "summary_large_image")
  );
  return tags;
}

/** The Vite plugin: every page's tags, from the build's site address (`resolveSiteUrl`) unless given. */
export function shareCards(siteUrl: string | undefined = resolveSiteUrl()): Plugin {
  return {
    name: "datum-share-cards",
    transformIndexHtml(html, context) {
      return shareCardTags(html, basename(context.filename), siteUrl);
    }
  };
}
