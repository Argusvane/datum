// Writes the two files a crawler looks for, from what the build produced: sitemap.xml, one
// address per marketing page and per docs page, and robots.txt, which allows everything and
// names the sitemap. Run last in `npm run build`, after the marketing site and the docs site are
// both in dist/, because the docs pages are only known once they are built.
//
// The addresses are absolute, from the site's full address: SITE_URL as given, else the origin in
// site.json under SITE_BASE. The same rule is share-cards.ts's `resolveSiteUrl`, which gives each
// page its canonical link, so the sitemap and the pages agree; test/crawl-files.test.ts holds the
// two together.
//
//   node scripts/write-crawl-files.mjs [outDir]      outDir defaults to dist
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The site's full address, without a trailing slash. */
export function siteUrlFrom(env = process.env) {
  const given = env.SITE_URL?.trim();
  const url = given ? given : new URL(env.SITE_BASE?.trim() || "/", JSON.parse(readFileSync(join(root, "site.json"), "utf8")).origin).toString();
  return url.replace(/\/+$/, "");
}

/** Every .html file under a folder, as paths relative to it, in a stable order. */
function htmlFiles(folder, base = folder) {
  const found = [];
  for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...htmlFiles(path, base));
    else if (entry.name.endsWith(".html")) found.push(relative(base, path).split(sep).join("/"));
  }
  return found;
}

/** The addresses of the built site: marketing pages by file name, docs pages as clean URLs under docs/. */
export function pageAddresses(outDir, siteUrl) {
  const addresses = [];
  for (const file of readdirSync(outDir).filter((name) => name.endsWith(".html") && name !== "404.html").sort()) {
    addresses.push(`${siteUrl}/${file === "index.html" ? "" : file}`);
  }
  let docs = [];
  try {
    docs = htmlFiles(join(outDir, "docs")).filter((file) => file !== "404.html");
  } catch {
    // A build without the docs site has no docs pages to list.
  }
  for (const file of docs) {
    const clean = file === "index.html" ? "" : file.replace(/(^|\/)index\.html$/, "$1").replace(/\.html$/, "");
    addresses.push(`${siteUrl}/docs/${clean}`);
  }
  return addresses;
}

const escapeXml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function sitemapXml(addresses) {
  const entries = addresses.map((address) => `  <url><loc>${escapeXml(address)}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

export function robotsTxt(siteUrl) {
  return `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}/sitemap.xml\n`;
}

export function writeCrawlFiles(outDir, siteUrl = siteUrlFrom()) {
  const addresses = pageAddresses(outDir, siteUrl);
  writeFileSync(join(outDir, "sitemap.xml"), sitemapXml(addresses));
  writeFileSync(join(outDir, "robots.txt"), robotsTxt(siteUrl));
  return addresses;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outDir = resolve(root, process.argv[2] ?? "dist");
  const addresses = writeCrawlFiles(outDir);
  console.log(`sitemap.xml: ${addresses.length} pages; robots.txt written to ${outDir}`);
}
