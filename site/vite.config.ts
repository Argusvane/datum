import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { pageShellPlugin } from "./page-shell";
import { shareCards } from "./share-cards";

const root = fileURLToPath(new URL(".", import.meta.url));

// SITE_BASE is the path the site is served from: "/" for a custom domain or user pages
// (the default), "/<repo>/" for project pages at https://<owner>.github.io/<repo>/.
// The Pages workflow passes "/" unless a SITE_BASE repository variable is set. See README.md.
// In development the docs site (docs/, VitePress) runs as its own server on DOCS_DEV_PORT, and the
// marketing dev server forwards /docs there, websocket included (VitePress's reload channel is at
// its base, /docs/), so the Docs link works on http://localhost:5173 as it does on the built site.
// `npm run dev` starts both (scripts/dev.mjs). The proxy is dev-only: the build writes dist/docs.
const docsDevPort = Number(process.env.DOCS_DEV_PORT ?? 5174);

export default defineConfig({
  base: process.env.SITE_BASE ?? "/",
  server: {
    proxy: {
      "/docs": { target: `http://localhost:${docsDevPort}`, ws: true }
    }
  },
  // Link previews: Open Graph and Twitter tags from each page's title and description, with
  // absolute image and page addresses when SITE_URL says where the site is served. See README.md.
  plugins: [pageShellPlugin(), shareCards()],
  build: {
    rollupOptions: {
      input: {
        home: root + "index.html",
        // Served by Pages for any address that is no page; not in the sitemap.
        "not-found": root + "404.html",
        features: root + "features.html",
        partners: root + "partners.html",
        bindings: root + "bindings.html",
        "binding-datum": root + "binding-datum.html",
        "binding-gcds": root + "binding-gcds.html",
        "binding-govuk": root + "binding-govuk.html",
        "binding-uswds": root + "binding-uswds.html",
        "binding-bootstrap": root + "binding-bootstrap.html",
        "binding-nova-scotia": root + "binding-nova-scotia.html",
        "binding-alberta": root + "binding-alberta.html",
        "binding-quebec": root + "binding-quebec.html",
        "binding-ontario": root + "binding-ontario.html",
        "binding-fluent": root + "binding-fluent.html"
      }
    }
  }
});
