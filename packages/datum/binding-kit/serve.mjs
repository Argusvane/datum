#!/usr/bin/env node
// A viewer for a binding's reference cases: the reference in the document, the reference in a
// shadow root, and the binding, side by side, drawn by the same code the equality check uses.
//
//   node binding-kit/serve.mjs --binding govuk [--port 5200]      then open the address it prints
//
// Ports 5200-5219. The server builds the binding from source at start; restart it after an edit.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildRun, loadEsbuild, RUN_PREFIX, startServer } from "@argusvane/datum-conformance-suite/binding-check";
import { assetsOf } from "./lib/session.mjs";
import { pickPort } from "./lib/ports.mjs";
import { definitionOf, loadReferences, loadTier2 } from "./lib/reference.mjs";
import { resolveBinding } from "./lib/binding-package.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const json = (value) => ({ contents: Buffer.from(JSON.stringify(value)), type: "application/json; charset=utf-8" });
const html = (text) => ({ contents: Buffer.from(text), type: "text/html; charset=utf-8" });

const VIEW = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>view</title>
<style>body{margin:0;padding:16px;background:#fff;font-family:system-ui,sans-serif}</style>
<script type="module" src="/binding-check/page.js"></script>
<script type="module" src="${RUN_PREFIX}kit/kit-page.js"></script>
<script type="module" src="${RUN_PREFIX}kit/view.js"></script></head><body><div id="stage"></div></body></html>`;

const compare = (id) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${id}</title>
<style>body{margin:0;font:14px system-ui,sans-serif}header{padding:8px 16px;background:#f3f3f3}
main{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:8px}section h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#555;margin:0 0 4px}
iframe{width:100%;height:80vh;border:1px solid #ccc;background:#fff}</style></head><body>
<header><a href="/">all cases</a> / <b>${id}</b></header><main>
<section><h2>reference, in the document</h2><iframe src="${RUN_PREFIX}kit/view.html?case=${id}&pane=plain"></iframe></section>
<section><h2>reference, in a shadow root</h2><iframe src="${RUN_PREFIX}kit/view.html?case=${id}&pane=shadow"></iframe></section>
<section><h2>the binding</h2><iframe src="${RUN_PREFIX}kit/view.html?case=${id}&pane=binding"></iframe></section></main></body></html>`;

export async function serve(binding, { port } = {}) {
  const pkg = typeof binding === "string" ? resolveBinding(binding) : binding;
  if (!pkg.entry) throw new Error(`bindings/${pkg.id} has no binding module yet`);
  const built = await buildRun({ binding: pkg.entry, name: pkg.id, extraEntries: { kit: join(here, "host", "entry.ts") }, esbuild: loadEsbuild(), shared: true });
  const files = built.files;
  files.set("kit/kit-page.js", { contents: readFileSync(join(here, "page", "kit-page.js")), type: "text/javascript; charset=utf-8" });
  files.set("kit/view.js", { contents: readFileSync(join(here, "page", "view.js")), type: "text/javascript; charset=utf-8" });
  files.set("kit/view.html", html(VIEW));
  files.set("kit/config.json", json({ id: pkg.id, assets: assetsOf(pkg), bodyClass: pkg.assets.bodyClass, lang: pkg.assets.lang, urls: { kitUrl: built.urlOf("kit"), hostUrl: built.hostUrl, bindingUrl: built.bindingUrl } }));
  const cases = [...loadReferences(pkg).map((c) => ({ ...c, tier: 1 })), ...loadTier2(pkg).map((c) => ({ ...c, tier: 2, html: "" }))];
  for (const entry of cases) {
    files.set(`kit/cases/${entry.id}.json`, json({ meta: entry.meta, html: entry.html, definition: entry.meta.components || entry.meta.definition ? definitionOf(entry.meta, entry.id) : undefined }));
    files.set(`kit/${entry.id}.html`, html(compare(entry.id)));
  }
  const index = `<!doctype html><meta charset="utf-8"><title>${pkg.id} reference cases</title><body style="font:14px system-ui;padding:16px"><h1>${pkg.id}: ${cases.length} case(s)</h1><ul>${cases.map((c) => `<li><a href="${RUN_PREFIX}kit/${c.id}.html">${c.tier === 2 ? "tier 2: " : ""}${c.id}</a> <small>${c.meta.note ?? c.meta.source ?? ""}</small></li>`).join("")}</ul></body>`;
  files.set("kit/index.html", html(index));
  const server = await startServer({ port: port ?? (await pickPort()), roots: pkg.isDatum ? [] : [pkg.dir], files });
  return { port: server.port, url: `http://127.0.0.1:${server.port}${RUN_PREFIX}kit/index.html`, close: async () => { await server.close(); built.dispose(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const at = (name) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);
  if (!at("--binding")) {
    console.error("usage: node binding-kit/serve.mjs --binding <id | package path> [--port 5200]");
    process.exitCode = 2;
  } else {
    serve(at("--binding"), { port: at("--port") ? Number(at("--port")) : undefined }).then(
      (server) => { console.log(`serving ${at("--binding")} at ${server.url}\n(Ctrl-C stops it)`); process.once("SIGINT", () => server.close().finally(() => process.exit(0))); },
      (error) => { console.error(`serve: ${error?.stack ?? error}`); process.exitCode = 4; }
    );
  }
}
