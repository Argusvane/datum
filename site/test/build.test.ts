import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evidenceTopics, partners } from "../src/pillars";

// The one thing that silently breaks a static site is the base path: Vite rewrites asset
// URLs for `base` but not `<a href>`, so page links must stay relative. This builds once
// under a project-pages base and inspects the output.
const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = "dist-test";
const bindingPages = ["bindings.html", "binding-datum.html", ...["gcds", "govuk", "uswds", "bootstrap", "nova-scotia", "alberta", "quebec", "ontario", "fluent"].map((id) => `binding-${id}.html`)];
const pages = ["index.html", "features.html", "partners.html", ...bindingPages];

// The live demo's bundles are copied in by scripts/copy-demo-assets.mjs, which
// needs packages/datum and plugins/* built. A site-only checkout runs without them; CI never does.
const demoPresent = existsSync(new URL("../public/demo/datum-builder.js", import.meta.url));
const demoCases = demoPresent || process.env.CI ? it : it.skip;

describe("site build", () => {
  beforeAll(() => {
    const env = { ...process.env, SITE_BASE: "/datum/", SITE_URL: "https://example.org/datum" };
    execFileSync(process.execPath, ["node_modules/vite/bin/vite.js", "build", "--outDir", outDir], { cwd: root, env, stdio: "pipe" });
    // The docs site (docs/, VitePress) builds into the same output under docs/, as `npm run build` does.
    execFileSync(process.execPath, ["node_modules/vitepress/bin/vitepress.js", "build", "docs", "--outDir", `${outDir}/docs`], { cwd: root, env, stdio: "pipe" });
    // The last build step lists both sites' pages in sitemap.xml and writes robots.txt.
    execFileSync(process.execPath, ["scripts/write-crawl-files.mjs", outDir], { cwd: root, env, stdio: "pipe" });
  });

  afterAll(() => {
    rmSync(new URL(`../${outDir}`, import.meta.url), { recursive: true, force: true });
  });

  it("emits both pages, the favicon and the Jekyll opt-out", () => {
    for (const file of [...pages, "favicon.svg", ".nojekyll"]) {
      expect(existsSync(new URL(`../${outDir}/${file}`, import.meta.url)), file).toBe(true);
    }
  });

  it("rewrites assets for SITE_BASE and keeps page links relative", () => {
    for (const file of pages) {
      const html = readFileSync(new URL(`../${outDir}/${file}`, import.meta.url), "utf8");
      expect(html, file).toMatch(/src="\/datum\/assets\//);
      expect(html, file).toMatch(/href="\/datum\/assets\//);
      expect(html, file).not.toMatch(/http:\/\/localhost/);
      expect(html, file).not.toMatch(/href="\/(index|features|developers|partners)\.html/);
      expect(html, file).not.toMatch(/href="\/"/);
      // The site names the sandbox, never the engine, and cites no decision records.
      expect(html, file).not.toMatch(/QuickJS/);
      expect(html, file).not.toMatch(/ADR \d{4}/);
    }
  });

  it("links every page to the docs site, relative, and never to the old FAQ", () => {
    for (const file of pages) {
      const html = readFileSync(new URL(`../${outDir}/${file}`, import.meta.url), "utf8");
      expect(html, file).toMatch(/<a href="\.\/docs\/">Docs<\/a>/);
      expect(html, file).not.toMatch(/faq\.html/);
    }
  });

  // The docs site is served at <base>docs/: its assets carry that base, its pages are clean URLs,
  // its "Site" link climbs back to the marketing site, and it keeps the site's content rules.
  it("builds the docs site under the same base path", () => {
    const docsPages = ["index.html", "introduction.html", "getting-started.html", "form-element.html", "timestamps.html", "bindings.html", "look.html", "components.html", "signing.html", "spring-boot.html", "builder-element.html", "404.html"];
    for (const file of docsPages) {
      expect(existsSync(new URL(`../${outDir}/docs/${file}`, import.meta.url)), `docs/${file}`).toBe(true);
    }
    for (const file of docsPages.filter((name) => name !== "404.html")) {
      const html = readFileSync(new URL(`../${outDir}/docs/${file}`, import.meta.url), "utf8");
      expect(html, file).toMatch(/src="\/datum\/docs\/assets\//);
      expect(html, file).toMatch(/href="\/datum\/favicon\.svg/);
      expect(html, file).toMatch(/<a [^>]*href="\.\.\/" target="_self"[^>]*>/);
      expect(html, file).not.toMatch(/href="\/datum\/docs\/[\w-]+\.html"/);
      expect(html, file).not.toMatch(/http:\/\/localhost/);
      expect(html, file).not.toMatch(/QuickJS/);
      expect(html, file).not.toMatch(/ADR \d{4}/);
    }
  });

  // A mistyped address anywhere on the site gets this page from Pages, so it sits at the artifact root,
  // links from the base path rather than relative to the address, and stays out of the sitemap.
  it("writes a root 404 page that links home and to the docs from the base path", () => {
    const html = readFileSync(new URL(`../${outDir}/404.html`, import.meta.url), "utf8");
    expect(html).toContain("<title>Datum: page not found</title>");
    expect(html).toContain('<meta name="robots" content="noindex" />');
    expect(html).toContain('href="/datum/"');
    expect(html).toContain('href="/datum/docs/"');
    expect(html).not.toMatch(/href="\.\//);
    expect(html).not.toMatch(/canonical|og:/);
    expect(readFileSync(new URL(`../${outDir}/sitemap.xml`, import.meta.url), "utf8")).not.toContain("404");
  });

  it("gives every marketing page a skip link to its main, and the docs theme its own", () => {
    for (const file of [...pages, "404.html"]) {
      const html = readFileSync(new URL(`../${outDir}/${file}`, import.meta.url), "utf8");
      expect(html, file).toMatch(/<body>\s*<a class="skip-link" href="#main">Skip to content<\/a>/);
      expect(html, file).toMatch(/<main id="main" tabindex="-1">/);
    }
    const docs = readFileSync(new URL(`../${outDir}/docs/introduction.html`, import.meta.url), "utf8");
    expect(docs).toMatch(/class="VPSkipLink visually-hidden"[^>]*>Skip to content/);
  });

  it("gives the docs pages link-preview tags with absolute addresses, and the 404 none", () => {
    const docs = readFileSync(new URL(`../${outDir}/docs/introduction.html`, import.meta.url), "utf8");
    expect(docs).toContain('<meta property="og:title" content="Introduction | Datum docs">');
    expect(docs).toContain('<meta property="og:url" content="https://example.org/datum/docs/introduction">');
    expect(docs).toContain('<meta property="og:image" content="https://example.org/datum/og/datum.png">');
    expect(docs).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(docs).toMatch(/<meta property="og:description" content="[^"]+">/);
    expect(readFileSync(new URL(`../${outDir}/docs/404.html`, import.meta.url), "utf8")).not.toContain("og:title");
  });

  // The binding pages are shells their script fills; the sentence about the design systems' owners is in
  // the HTML a reader without JavaScript (or a crawler that runs none) gets.
  it("carries the non-affiliation line in every binding page's static HTML", () => {
    for (const file of bindingPages) {
      const html = readFileSync(new URL(`../${outDir}/${file}`, import.meta.url), "utf8");
      expect(html, file).toMatch(/<noscript><p class="binding-demo__fallback container">[^<]*Datum is not affiliated with or endorsed by the owner of any design system named here\.<\/p><\/noscript>/);
    }
  });

  // Every docs page keeps the rule in its prose. A code block is exempt: a server's endpoint file
  // downloads the engine by name and cannot work without saying it.
  it("names the engine nowhere in the docs' prose, and publishes the files the examples load", () => {
    const docsDir = new URL(`../${outDir}/docs/`, import.meta.url);
    const built = readdirSync(docsDir).filter((name) => name.endsWith(".html"));
    expect(built.length).toBeGreaterThan(40);
    for (const file of built) {
      const prose = readFileSync(new URL(file, docsDir), "utf8").replace(/<pre[\s\S]*?<\/pre>/g, "");
      expect(prose, file).not.toMatch(/QuickJS/i);
      expect(prose, file).not.toMatch(/ADR \d{4}/);
    }
    // The files the examples load are published beside the pages.
    expect(existsSync(new URL("forms/customer-intake.json", docsDir))).toBe(true);
  });

  it("keeps the live example pages under one nav entry, and the reference in the docs", () => {
    for (const file of pages) {
      const html = readFileSync(new URL(`../${outDir}/${file}`, import.meta.url), "utf8");
      // The one Examples entry stands for every sub-page (main.ts marks it current on each).
      expect(html, file).toMatch(/href="\.\/bindings\.html" data-pages="bindings\.html binding-\*">Examples</);
      expect(html, file).not.toMatch(/developers\.html/);
    }
    for (const file of bindingPages) {
      const html = readFileSync(new URL(`../${outDir}/${file}`, import.meta.url), "utf8");
      expect(html, file).toMatch(/<nav class="subnav" aria-label="Example pages">/);
      expect(html, file).toMatch(/href="\.\/docs\/examples">Live examples</);
      expect(html, file).not.toMatch(/>Integrate</);
      expect(html, file).toMatch(/href="\.\/bindings\.html" data-pages="binding-\*">Bindings</);
      expect(html, file).not.toMatch(/>Themes</);
    }
    expect(existsSync(new URL(`../${outDir}/developers.html`, import.meta.url))).toBe(false);
    // The live examples are native docs pages; the module that once embedded them is gone.
    expect(existsSync(new URL(`../${outDir}/integrate.html`, import.meta.url))).toBe(false);
    expect(existsSync(new URL(`../${outDir}/demo/integrate`, import.meta.url))).toBe(false);
    expect(existsSync(new URL(`../${outDir}/docs/examples.html`, import.meta.url))).toBe(true);
    const assistants = readFileSync(new URL("../docs/assistants.md", import.meta.url), "utf8");
    for (const word of ["agent-access", "agent-off", "tools=(self)", "origin trial"]) expect(assistants, word).toContain(word);
  });

  it("sends the hero's three routes to their blocks on the partners page, in every nav", () => {
    for (const file of pages) {
      const html = readFileSync(new URL(`../${outDir}/${file}`, import.meta.url), "utf8");
      expect(html, file).toMatch(/href="\.\/partners\.html">Partners</);
    }
    const home = readFileSync(new URL(`../${outDir}/index.html`, import.meta.url), "utf8");
    const hero = home.slice(home.indexOf('<section class="hero">'), home.indexOf('id="numbers"'));
    // The rows carry the same labels as the partners page's blocks, in the same order.
    const rows = [...hero.matchAll(/href="\.\/partners\.html#(\w+)">\s*<span class="hero__route-label">([^<]+)</g)];
    expect(rows.map(([, id, label]) => [id, label])).toEqual(partners.map((route) => [route.id, route.label]));
    const page = readFileSync(new URL(`../${outDir}/partners.html`, import.meta.url), "utf8");
    expect(page).toMatch(/data-partners\b/);
    expect(page).toMatch(/data-standards\b/);
    // Each route's figures link to a topic "By the numbers" has.
    for (const route of partners) {
      expect(evidenceTopics.map((topic) => topic.id), route.id).toContain(route.evidence.topic);
    }
  });

  it("has four hero slides, what Datum is, why it matters, its ways in and out and journeys, each with its own tab", () => {
    const home = readFileSync(new URL(`../${outDir}/index.html`, import.meta.url), "utf8");
    const hero = home.slice(home.indexOf('<section class="hero">'), home.indexOf('id="numbers"'));
    const slides = [...hero.matchAll(/<div class="hero__slide" id="([\w-]+)" role="tabpanel" aria-labelledby="([\w-]+)"/g)];
    expect(slides.map(([, id]) => id)).toEqual(["hero-what", "hero-why", "hero-io", "hero-journey"]);
    for (const [, id, tab] of slides) expect(hero, id).toMatch(new RegExp(`id="${tab}"[^>]*aria-controls="${id}"`));
    // The page's only h1 is the video hero's, which comes first; the deck's slides all lead with an h2,
    // and its other slides and its tabs show once the script runs.
    expect(home.match(/<h1\b/g)).toHaveLength(1);
    expect(hero.indexOf("<h1")).toBeLessThan(hero.indexOf('id="hero-why"'));
    expect(hero.indexOf("<h1")).toBeLessThan(hero.indexOf('data-hero-variant="classic"'));
    expect(hero.match(/<h2 class="hero__title">/g)).toHaveLength(4);
    for (const id of ["hero-why", "hero-io", "hero-journey"]) expect(hero).toMatch(new RegExp(`id="${id}"[^>]*\\bhidden\\b`));
    expect(hero).toMatch(/data-hero-controls hidden/);
  });

  it("has two home heroes, the video first and the slide deck behind a switch", () => {
    const home = readFileSync(new URL(`../${outDir}/index.html`, import.meta.url), "utf8");
    const hero = home.slice(home.indexOf('<section class="hero">'), home.indexOf('id="numbers"'));
    const video = hero.indexOf('data-hero-variant="video"');
    const classic = hero.indexOf('data-hero-variant="classic"');
    expect(video).toBeGreaterThan(-1);
    expect(classic).toBeGreaterThan(video);
    // The deck is out of the way until the script, or the stored choice, brings it in.
    expect(hero).toMatch(/<div class="hero__variant" data-hero-variant="classic" hidden>/);
    expect(hero).not.toMatch(/<div class="hero__variant" data-hero-variant="video"[^>]*hidden/);
    // Each version has its own switch, reading as the other version.
    const videoPart = hero.slice(video, classic);
    const classicPart = hero.slice(classic);
    expect(videoPart).toMatch(/<button[^>]*\bdata-hero-switch\b[^>]*>Show the overview<\/button>/);
    expect(classicPart).toMatch(/<button[^>]*\bdata-hero-switch\b[^>]*>Show the video<\/button>/);
    expect(hero.match(/data-hero-switch/g)).toHaveLength(2);
    // The stored choice is applied in the head, before first paint, beside the theme.
    const head = home.slice(0, home.indexOf("</head>"));
    expect(head).toContain('localStorage.getItem("datum-hero") === "classic"');
    // The video plays by itself, silently and in place, and its files resolve under the base.
    const tag = /<video\b[^>]*>/.exec(videoPart)?.[0] ?? "";
    for (const attribute of ["muted", "playsinline", "loop", "autoplay"]) expect(tag, attribute).toMatch(new RegExp(`\\b${attribute}\\b`));
    expect(tag).toMatch(/poster="\/datum\/video\/datum-demo-poster\.jpg"/);
    const sources = [...videoPart.matchAll(/<source src="([^"]+)"/g)].map(([, src]) => src);
    expect(sources).toEqual(["/datum/video/datum-demo.webm", "/datum/video/datum-demo.mp4"]);
    for (const src of [...sources, "/datum/video/datum-demo-poster.jpg"]) {
      expect(existsSync(new URL(`../${outDir}${src.replace("/datum", "")}`, import.meta.url)), src).toBe(true);
    }
    // The second clip's files are named in the script, built from the base, and ship too.
    for (const file of ["datum-journey.webm", "datum-journey.mp4", "datum-journey-poster.jpg"]) {
      expect(existsSync(new URL(`../${outDir}/video/${file}`, import.meta.url)), file).toBe(true);
    }
    const scripts = readdirSync(new URL(`../${outDir}/assets`, import.meta.url)).filter((name) => name.endsWith(".js"));
    const code = scripts.map((name) => readFileSync(new URL(`../${outDir}/assets/${name}`, import.meta.url), "utf8")).join("\n");
    expect(code).toContain("datum-journey");
    expect(code).toContain("/datum/");
  });

  it("gives every page a link preview from its own title and description, the partners page its own card", () => {
    expect(existsSync(new URL(`../${outDir}/og/datum.png`, import.meta.url))).toBe(true);
    expect(existsSync(new URL(`../${outDir}/og/partners.png`, import.meta.url))).toBe(true);
    for (const file of pages) {
      const html = readFileSync(new URL(`../${outDir}/${file}`, import.meta.url), "utf8");
      // Vite serialises the injected tags with every attribute character escaped (an apostrophe
      // becomes &#39;), the hand-written description does not: compare the decoded text.
      const decode = (text: string | undefined): string | undefined => text?.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
      const meta = (key: string): string | undefined => decode(new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`).exec(html)?.[1]);
      const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];
      const description = decode(/<meta\s+name="description"\s+content="([^"]*)"/.exec(html)?.[1])?.replace(/\s+/g, " ").trim();
      expect(meta("og:title"), file).toBe(title);
      expect(meta("og:description"), file).toBe(description);
      expect(meta("og:url"), file).toBe(`https://example.org/datum/${file === "index.html" ? "" : file}`);
      expect(meta("og:image"), file).toBe(`https://example.org/datum/og/${file === "partners.html" ? "partners" : "datum"}.png`);
      expect(meta("twitter:card"), file).toBe("summary_large_image");
    }
  });

  it("has the demo section on the home page, and no pricing or support tier anywhere", () => {
    const home = readFileSync(new URL(`../${outDir}/index.html`, import.meta.url), "utf8");
    // Under the hero: the findings, the Overview, the demo, then the usage map.
    expect(home).toMatch(
      /<section[^>]*id="numbers"[\s\S]*<section[^>]*id="why"[\s\S]*<section[^>]*id="demo"[\s\S]*<section[^>]*id="usage"/
    );
    expect(home).not.toMatch(/id="start"/);
    expect(home).toMatch(/data-evidence\b/);
    expect(home).toMatch(/<section[^>]*id="demo"/);
    expect(home).toMatch(/data-demo\b/);
    expect(home).not.toMatch(/id="pricing"/);
    expect(home).not.toMatch(/data-tiers\b/);
    for (const file of pages) {
      const html = readFileSync(new URL(`../${outDir}/${file}`, import.meta.url), "utf8");
      expect(html, file).not.toMatch(/#pricing|>Pricing</);
      // No tier, response time, long-term support release or SBOM is promised: the one line is commercial support and services from Argusvane.
      expect(html, file).not.toMatch(/Enterprise support|long-term support|SBOM|guaranteed response/i);
      // The repository is MIT; the older wording must not come back.
      expect(html, file).not.toMatch(/Source available/);
    }
    const scripts = readdirSync(new URL(`../${outDir}/assets`, import.meta.url)).filter((name) => name.endsWith(".js"));
    const code = scripts.map((name) => readFileSync(new URL(`../${outDir}/assets/${name}`, import.meta.url), "utf8")).join("\n");
    expect(code).not.toMatch(/Enterprise support|Long-term support releases|SBOM and signed provenance|Guaranteed response/);
  });

  it("ends every page with the licence, repository, security policy and contributing links, and the support line", () => {
    for (const file of pages) {
      const html = readFileSync(new URL(`../${outDir}/${file}`, import.meta.url), "utf8");
      const footer = html.slice(html.indexOf('<footer class="footer">'), html.indexOf("</footer>"));
      for (const label of ["MIT licence", "Repository", "Security policy", "Contributing"]) expect(footer, `${file}: ${label}`).toContain(`>${label}</a>`);
      expect(footer, file).toContain("github.com/argusvane/datum/blob/main/LICENSE");
      expect(footer, file).toContain("github.com/argusvane/datum/blob/main/SECURITY.md");
      expect(footer, file).toContain("github.com/argusvane/datum/blob/main/CONTRIBUTING.md");
      expect(footer, file).toContain("Commercial support and services from Argusvane");
      expect(footer, file).toContain('href="mailto:contact@argusvane.com"');
    }
  });

  it("credits Argusvane in every page's header and footer, drawn from the one sprite on the page", () => {
    for (const file of [...pages, "404.html"]) {
      const html = readFileSync(new URL(`../${outDir}/${file}`, import.meta.url), "utf8");
      const header = html.slice(html.indexOf('<header class="nav">'), html.indexOf("</header>"));
      const footer = html.slice(html.indexOf('<footer class="footer">'), html.indexOf("</footer>"));
      for (const [part, text] of [["header", header], ["footer", footer]] as const) {
        expect(text, `${file}: ${part}`).toContain('class="by-argusvane" href="https://argusvane.com"');
        expect(text, `${file}: ${part}`).toContain('aria-label="Argusvane"');
      }
      // Each reference has its symbol on the page, once.
      for (const id of ["av-mark", "av-wordmark"]) {
        expect(html, `${file}: #${id}`).toContain(`href="#${id}"`);
        expect(html.split(`id="${id}"`).length - 1, `${file}: ${id}`).toBe(1);
      }
    }
  });

  it("serves its own fonts and asks no third party for anything", () => {
    for (const file of ["bebas-neue-latin-400", "archivo-latin-variable", "ibm-plex-mono-latin-400", "ibm-plex-mono-latin-500"]) {
      expect(existsSync(new URL(`../${outDir}/fonts/${file}.woff2`, import.meta.url)), file).toBe(true);
    }
    for (const file of ["OFL-archivo.txt", "OFL-bebasneue.txt", "OFL-ibmplexmono.txt"]) {
      expect(existsSync(new URL(`../${outDir}/fonts/${file}`, import.meta.url)), file).toBe(true);
    }
    const stylesheets = readdirSync(new URL(`../${outDir}/assets`, import.meta.url)).filter((name) => name.endsWith(".css"));
    expect(stylesheets.length).toBeGreaterThan(0);
    const sheets = stylesheets.map((name) => readFileSync(new URL(`../${outDir}/assets/${name}`, import.meta.url), "utf8"));
    // The site's own sheet carries the faces, under the base; no sheet imports or fetches from another origin.
    expect(sheets.some((css) => /url\(["']?\/datum\/fonts\/archivo-latin-variable\.woff2/.test(css))).toBe(true);
    expect(sheets.some((css) => /@import|url\(\s*["']?https?:/.test(css))).toBe(false);
    // A page's own markup loads nothing from another origin: links to other sites are anchors, never stylesheets, scripts or preconnects.
    for (const file of pages) {
      const html = readFileSync(new URL(`../${outDir}/${file}`, import.meta.url), "utf8");
      expect(html, file).not.toMatch(/<link[^>]+(?:rel="(?:stylesheet|preconnect|preload)")[^>]*href="https?:/);
      expect(html, file).not.toMatch(/<script[^>]+src="https?:/);
      expect(html, file).not.toMatch(/fonts\.googleapis|fonts\.gstatic|typekit/);
    }
  });

  // The docs pages are held to the same rule, with no exception: none of them is a binding demo.
  // The live examples build their own pages at run time, in a frame, from the bundles under
  // demo/; the docs' static markup and sheets name no other origin. The pages that may fetch from
  // a design system's own hosts are the marketing site's binding-*.html pages (and the demo files
  // under demo/bindings they load), which list those hosts in src/bindings.ts and are held to
  // them by binding-pages.test.ts.
  it("asks no third party for anything from the docs pages either, and serves them the site's fonts under the base", () => {
    const docsDir = new URL(`../${outDir}/docs/`, import.meta.url);
    const pagesBuilt = readdirSync(docsDir, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".html"));
    expect(pagesBuilt.length).toBeGreaterThan(40);
    for (const file of pagesBuilt) {
      const html = readFileSync(new URL(file, docsDir), "utf8");
      // The canonical address is the page's own; the head's rules fetch only the site's files.
      expect(html, file).not.toMatch(/<link[^>]+rel="(?:stylesheet|preconnect|preload|modulepreload|dns-prefetch)"[^>]*href="(?:https?:)?\/\//);
      expect(html, file).not.toMatch(/<link[^>]+href="(?:https?:)?\/\/[^"]*"[^>]*rel="(?:stylesheet|preconnect|preload|modulepreload|dns-prefetch)"/);
      expect(html, file).not.toMatch(/<(?:script|img|iframe|source|video|audio)\b[^>]+\bsrc="(?:https?:)?\/\//);
      // Prose and code blocks may name a host (the security-headers page lists what to allow), so only the page's own style blocks are read.
      for (const [, css] of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)) expect(css, file).not.toMatch(/@import|url\(\s*["']?(?:https?:)?\/\//);
    }
    // The faces are declared in the head under the base, and the files are where they point.
    const intro = readFileSync(new URL("introduction.html", docsDir), "utf8");
    const faces = [...intro.matchAll(/url\("\/datum\/fonts\/([\w-]+\.woff2)"\)/g)].map(([, file]) => file);
    expect(faces).toContain("archivo-latin-variable.woff2");
    expect(faces).toContain("bebas-neue-latin-400.woff2");
    expect(faces).toContain("ibm-plex-mono-latin-500.woff2");
    // The sidebar ends with "Datum by Argusvane" and the nav links to Argusvane, both drawn without fetching anything.
    expect(intro).toContain('class="argusvane-credit"');
    expect(intro).toMatch(/<a[^>]+href="https:\/\/argusvane\.com"[^>]*>[\s\S]*?Argusvane/);
    expect(intro).toContain('aria-label="Argusvane"');
    for (const file of faces) expect(existsSync(new URL(`../${outDir}/fonts/${file}`, import.meta.url)), file).toBe(true);
    const sheets = readdirSync(new URL("assets/", docsDir)).filter((name) => name.endsWith(".css"));
    expect(sheets.length).toBeGreaterThan(0);
    for (const name of sheets) {
      expect(readFileSync(new URL(`assets/${name}`, docsDir), "utf8"), name).not.toMatch(/@import|url\(\s*["']?(?:https?:)?\/\//);
    }
  });

  it("gives each docs page a canonical link to its clean address", () => {
    const docsDir = new URL(`../${outDir}/docs/`, import.meta.url);
    const link = (file: string): string | undefined => /<link rel="canonical" href="([^"]+)"/.exec(readFileSync(new URL(file, docsDir), "utf8"))?.[1];
    expect(link("index.html")).toBe("https://example.org/datum/docs/");
    expect(link("introduction.html")).toBe("https://example.org/datum/docs/introduction");
    expect(link("form-element.html")).toBe("https://example.org/datum/docs/form-element");
    expect(readFileSync(new URL("404.html", docsDir), "utf8")).not.toContain('rel="canonical"');
  });

  it("names each page's canonical address, lists every page in the sitemap and names the sitemap in robots.txt", () => {
    const address = "https://example.org/datum";
    for (const file of pages) {
      const html = readFileSync(new URL(`../${outDir}/${file}`, import.meta.url), "utf8");
      expect(html, file).toContain(`<link rel="canonical" href="${address}/${file === "index.html" ? "" : file}">`);
    }
    const sitemap = readFileSync(new URL(`../${outDir}/sitemap.xml`, import.meta.url), "utf8");
    const listed = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, loc]) => loc);
    for (const file of pages) expect(listed, file).toContain(`${address}/${file === "index.html" ? "" : file}`);
    for (const page of ["", "introduction", "getting-started", "form-element"]) expect(listed, `docs/${page}`).toContain(`${address}/docs/${page}`);
    expect(listed.every((loc) => loc.startsWith(`${address}/`))).toBe(true);
    expect(listed.some((loc) => loc.endsWith("404.html") || loc.includes(".html/"))).toBe(false);
    expect(readFileSync(new URL(`../${outDir}/robots.txt`, import.meta.url), "utf8")).toBe(`User-agent: *\nAllow: /\n\nSitemap: ${address}/sitemap.xml\n`);
  });

  demoCases("ships the demo bundles under the base and loads them through it", () => {
    for (const file of ["datum-form.js", "datum-builder.js", "datum-builder.css", "datum-pdf.js", "datum-icons-fontawesome.js", "fonts/DejaVuSans.ttf", "pdfjs/pdf.worker.min.mjs"]) {
      expect(existsSync(new URL(`../${outDir}/demo/${file}`, import.meta.url)), file).toBe(true);
    }
    // The builder's PDF side is a lazy chunk beside the module; without it the designer cannot preview.
    const demoFiles = readdirSync(new URL(`../${outDir}/demo`, import.meta.url));
    expect(demoFiles.some((name) => /^datum-builder-pdf-[\w-]+\.js$/.test(name))).toBe(true);
    // The renderer bundle's agent chunk rides along: the demo form's tools load from it.
    expect(demoFiles.some((name) => /^datum-form-agent-[\w-]+\.js$/.test(name))).toBe(true);
    expect(demoFiles.some((name) => name.endsWith(".map") || name.endsWith(".iife.js") || name.endsWith("-program.js"))).toBe(false);
    const scripts = readdirSync(new URL(`../${outDir}/assets`, import.meta.url)).filter((name) => name.endsWith(".js"));
    const code = scripts.map((name) => readFileSync(new URL(`../${outDir}/assets/${name}`, import.meta.url), "utf8")).join("\n");
    // The module URLs are built from import.meta.env.BASE_URL, so they carry the base: the
    // builder, and the icons module before it.
    expect(code).toMatch(/\/datum\/demo\/datum-builder\.js/);
    // The renderer bundle is requested before the builder's, and only behind the WebMCP feature
    // detect, so a visitor without it downloads what they download today. The URLs live in the
    // built assets, never in index.html.
    expect(code).toMatch(/\/datum\/demo\/datum-form\.js/);
    const holder = scripts.map((name) => readFileSync(new URL(`../${outDir}/assets/${name}`, import.meta.url), "utf8")).find((text) => text.includes("/datum/demo/datum-form.js") && text.includes("/datum/demo/datum-builder.js"));
    expect(holder, "one asset names both bundles").toBeDefined();
    // The load order itself is demo-view.test.ts's to check (demoBundleUrls): the minifier inlines
    // the two literals where they are used, so their order in the text says nothing.
    // Any quote: the minifier is free to write the literal with backticks.
    expect(code).toMatch(/["'`]modelContext["'`]\s*in\s*document/);
    expect(code).toMatch(/\/datum\/demo\/datum-icons-fontawesome\.js/);
    expect(code).not.toMatch(/["'`]\/demo\/datum-builder\.js/);
  });
});
