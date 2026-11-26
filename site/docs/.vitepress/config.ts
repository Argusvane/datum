import { readFileSync } from "node:fs";
import { defineConfig } from "vitepress";
import { DEFAULT_SHARE_CARD, SHARE_CARD_SIZE, resolveSiteUrl } from "../../share-cards";

// The docs site is served under the marketing site at <SITE_BASE>docs/. SITE_BASE is the path the
// marketing site is served from ("/" by default, "/<repo>/" for project pages); the Pages workflow
// sets it for both builds. The output lands in site/dist/docs, inside the one Pages artifact.
const siteBase = process.env.SITE_BASE ?? "/";
const github = "https://github.com/argusvane/datum";
// The site's own typefaces, from the same @font-face rules the marketing site's stylesheet carries,
// with their file paths put under SITE_BASE. The rules go into each page's head rather than the
// theme's stylesheet: Vite would add the docs' own base to a root-relative url() in a stylesheet,
// and the files sit at <SITE_BASE>fonts/, beside the docs folder, not inside it.
const fontFaces = (readFileSync(new URL("../../src/styles.css", import.meta.url), "utf8").match(/@font-face\s*\{[^}]*\}/g) ?? [])
  .map((rule) => rule.replace(/\s+/g, " ").replace(/url\("\/fonts\//g, `url("${siteBase}fonts/`))
  .join("\n");
if (!fontFaces.includes(`${siteBase}fonts/archivo-latin-variable.woff2`)) throw new Error("the docs found no @font-face rules in src/styles.css");
// The site's full address, for each page's canonical link: the rule the marketing pages and the sitemap use.
const siteUrl = resolveSiteUrl().replace(/\/+$/, "");
// The pages the nav's Reference entry stands for; every other page is the Guide's.
const referencePages = "form-element|builder-element|definition|exports|form-texts|codes|limits|examples";

export default defineConfig({
  title: "Datum docs",
  description: "How to put a Datum form on a page, build one, draw it in your look, validate it on your own server and get a PDF out of it.",
  lang: "en",
  base: `${siteBase}docs/`,
  outDir: "../dist/docs",
  cleanUrls: true,
  // The reference tables scripts/gen-docs-reference.mjs writes are parts of pages, not pages.
  srcExclude: ["_generated/**"],
  markdown: {
    // Inline code says where it may wrap: a long piece is marked, so the stylesheet lets it break
    // anywhere, and every piece carries break points between the words of a name (after a dot,
    // slash or underscore inside it, and before a capital), which a narrow table column breaks it at.
    config(md) {
      const render = md.renderer.rules.code_inline!;
      md.renderer.rules.code_inline = (tokens, index, options, env, self) => {
        if (tokens[index]!.content.length > 24) tokens[index]!.attrJoin("class", "long");
        return render(tokens, index, options, env, self).replace(/>([^<]*)<\/code>$/, (_, text: string) => {
          const broken = text.replace(/([a-z0-9])(?=[A-Z])/g, "$1<wbr>").replace(/(?<=[A-Za-z0-9})\]])([./_])(?=[A-Za-z0-9{])/g, "$1<wbr>");
          return `>${broken}</code>`;
        });
      };
    }
  },
  head: [
    ["link", { rel: "icon", href: `${siteBase}favicon.svg?v=4`, type: "image/svg+xml" }],
    ["style", {}, fontFaces]
  ],
  // Each page names its own address, the clean URL the sitemap lists (scripts/write-crawl-files.mjs), and
  // carries the same link-preview tags the marketing pages do (share-cards.ts): its title and description,
  // its address and the site's card. The 404 page has no address of its own and gets none.
  transformHead({ pageData, title, description }) {
    if (pageData.isNotFound) return [];
    const clean = pageData.relativePath.replace(/\.md$/, "").replace(/(^|\/)index$/, "$1");
    const address = `${siteUrl}/docs/${clean}`;
    const meta = (key: "property" | "name", name: string, content: string): ["meta", Record<string, string>] => ["meta", { [key]: name, content }];
    const frontmatter = pageData.frontmatter as { description?: string };
    return [
      ["link", { rel: "canonical", href: address }],
      meta("property", "og:type", "website"),
      meta("property", "og:site_name", "Datum"),
      meta("property", "og:title", title),
      meta("property", "og:description", frontmatter.description || pageData.description || description),
      meta("property", "og:url", address),
      meta("property", "og:image", `${siteUrl}/${DEFAULT_SHARE_CARD.image}`),
      meta("property", "og:image:width", String(SHARE_CARD_SIZE.width)),
      meta("property", "og:image:height", String(SHARE_CARD_SIZE.height)),
      meta("property", "og:image:alt", DEFAULT_SHARE_CARD.alt),
      meta("name", "twitter:card", "summary_large_image")
    ];
  },
  vue: {
    // The form and the builder are custom elements; a page may place them as-is.
    template: { compilerOptions: { isCustomElement: (tag) => tag.startsWith("datum-") } }
  },
  themeConfig: {
    siteTitle: "Datum",
    nav: [
      { text: "Guide", link: "/introduction", activeMatch: `^/(?!(${referencePages})$)` },
      { text: "Reference", link: "/form-element", activeMatch: `^/(${referencePages})$` },
      // Back to the marketing site. Relative (every page sits one level under /docs/, so keep the
      // tree flat) and with a target, so the docs router leaves it alone.
      { text: "Site", link: "../", target: "_self" }
    ],
    sidebar: [
      {
        text: "Start",
        items: [
          { text: "Introduction", link: "/introduction" },
          { text: "Concepts", link: "/concepts" },
          { text: "Getting started", link: "/getting-started" },
          { text: "Publishing a form", link: "/publishing" }
        ]
      },
      {
        text: "Author a form",
        items: [
          { text: "Building a form", link: "/building-a-form", items: [{ text: "Keyboard shortcuts", link: "/shortcuts" }] },
          { text: "Components", link: "/components" },
          { text: "Rules and formulas", link: "/formulas" },
          { text: "Data model and data sources", link: "/data" },
          { text: "Journeys", link: "/journeys" },
          { text: "Languages", link: "/languages" },
          { text: "Testing a form", link: "/testing", items: [{ text: "The test language", link: "/form-test-language" }] }
        ]
      },
      {
        text: "Put a form on a page",
        items: [
          { text: "Ways to configure", link: "/configuring" },
          { text: "The form on your page", link: "/form-on-your-page", items: [{ text: "Submissions and replies", link: "/submissions" }] },
          { text: "Drafts", link: "/drafts" },
          { text: "Leaving parts out", link: "/leaving-parts-out" },
          { text: "React, Vue and Angular", link: "/frameworks" },
          { text: "In an iframe", link: "/iframe" },
          { text: "Browser assistants", link: "/assistants" }
        ]
      },
      {
        text: "The builder in your application",
        items: [
          { text: "Embedding the builder", link: "/embedding-the-builder" },
          { text: "Saving forms", link: "/saving-forms" },
          { text: "Customising the builder", link: "/customising-the-builder" }
        ]
      },
      {
        text: "Extend",
        items: [
          { text: "Components of your own", link: "/custom-components" },
          { text: "Plugins", link: "/plugins" },
          { text: "The engine on its own", link: "/engine" }
        ]
      },
      {
        text: "Look",
        items: [
          { text: "Look and chrome", link: "/look", items: [{ text: "Tokens", link: "/tokens" }] },
          {
            text: "Design-system bindings",
            link: "/bindings",
            items: [
              { text: "Bootstrap with your own CSS", link: "/bootstrap" },
              { text: "Writing a binding", link: "/writing-a-binding" }
            ]
          },
          { text: "Accessibility", link: "/accessibility" }
        ]
      },
      {
        text: "Outputs",
        items: [
          { text: "PDFs", link: "/pdf", items: [{ text: "Layout reference", link: "/pdf-layouts" }] },
          { text: "Print", link: "/print" },
          { text: "Signing", link: "/signing", items: [{ text: "Signing with a passkey", link: "/passkey-signing" }] }
        ]
      },
      {
        text: "WebAssembly",
        items: [
          { text: "How Datum uses WebAssembly", link: "/wasm" },
          { text: "Running the sandbox", link: "/wasm-running" },
          { text: "Hardening on a server", link: "/wasm-hardening" }
        ]
      },
      {
        text: "Server",
        items: [
          { text: "Validation and the sandbox", link: "/validation" },
          { text: "Server hosts", link: "/server-hosts" },
          { text: "The wire", link: "/wire" },
          // A page with pages under it: the entry is the page's link, and its items sit indented below.
          { text: "Spring Boot", link: "/spring-boot", items: [{ text: "Properties", link: "/spring-boot-properties" }] },
          { text: "FastAPI", link: "/fastapi", items: [{ text: "Settings", link: "/fastapi-settings" }] },
          { text: "Java sandbox library", link: "/java-sandbox" },
          { text: "Python sandbox library", link: "/python-sandbox" },
          { text: "Timestamp server", link: "/timestamps" },
          { text: "Your own server", link: "/server-programs" },
          { text: "The PDF program", link: "/pdf-program" },
          {
            text: "Examples",
            items: [
              { text: "Validate", link: "/server-example-validate" },
              { text: "Render a PDF", link: "/server-example-pdf" },
              { text: "Fill a PDF", link: "/server-example-fill" },
              { text: "Sign a PDF", link: "/server-example-sign" }
            ]
          },
          { text: "Conformance suite", link: "/conformance" }
        ]
      },
      {
        text: "Deploy",
        items: [
          { text: "Files you host", link: "/files" },
          { text: "Security headers", link: "/security-headers" },
          { text: "Threat model", link: "/threat-model" },
          { text: "Air-gapped deployments", link: "/air-gapped" }
        ]
      },
      {
        text: "Reference",
        items: [
          {
            text: "Elements",
            items: [
              { text: "Form", link: "/form-element" },
              { text: "Builder", link: "/builder-element" }
            ]
          },
          { text: "The definition", link: "/definition" },
          { text: "JavaScript exports", link: "/exports" },
          { text: "The form's own words", link: "/form-texts" },
          { text: "Codes and messages", link: "/codes" },
          { text: "Limits", link: "/limits" },
          { text: "Live examples", link: "/examples" }
        ]
      }
    ],
    outline: [2, 3],
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: github }],
    editLink: { pattern: `${github}/edit/main/site/docs/:path`, text: "Edit this page" },
    footer: { message: "MIT licence. Your forms, your data, your keys." }
  }
});
