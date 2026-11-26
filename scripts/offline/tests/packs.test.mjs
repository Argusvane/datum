import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { buildBindingPack, buildBindingPacks, integrityOf, remoteReferences } from "../lib/packs.mjs";

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const write = (file, text) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

const DS_CSS = [
  '@import url("https://fonts.example/css2?family=Lato&display=swap");',
  "@font-face{font-family:icons;src:url(https://cdn.example/@ds/fonts@1.0.0/icons/icons.woff) format(\"woff\")}",
  '@font-face{font-family:acumin;src:url("https://use.example/af/1/l") format("woff2")}',
  ".logo{background:url(https://gov.example/logo.svg)}",
  ".local{background:url(img/a.svg)}"
].join("");

/** A bindings folder with one binding, `demo`, whose design system reaches for three other hosts. */
function fixture({ check = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "datum-packs-"));
  roots.push(root);
  const dir = join(root, "bindings", "demo");
  write(
    join(dir, "package.json"),
    JSON.stringify({
      name: "@argusvane/datum-binding-demo",
      datumBinding: { id: "demo", designSystem: "Demo Design System", release: "1.0.0", bundle: "dist/demo.js", global: "DatumBindingDemo" },
      devDependencies: { "ds-1.0.0": "npm:@ds/components@1.0.0", "ds-fonts-1.0.0": "npm:@ds/fonts@1.0.0" }
    })
  );
  write(join(dir, "dist", "demo.js"), "export const createBinding = () => ({ id: 'demo' });\n");
  write(join(dir, "dist", "demo.iife.js"), "var DatumBindingDemo = {};\n");
  write(
    join(dir, "binding-check.json"),
    JSON.stringify({
      designSystem: "Demo Design System",
      stylesheets: ["/node_modules/ds-1.0.0/dist/ds.css"],
      scripts: [{ url: "/node_modules/ds-1.0.0/dist/ds.js", classic: true, attributes: { "data-css": "/node_modules/ds-1.0.0/dist/ds.css", mode: "plain" } }],
      bodyClass: "ds-supported",
      routes: [
        { match: "https://fonts.example/css2", stylesheets: [{ path: "/node_modules/ds-fonts-1.0.0/fonts/lato/lato.css", rebase: { "path/to/file/": "/node_modules/ds-fonts-1.0.0/fonts/lato/" } }] },
        { match: "https://cdn.example/@ds/fonts@1.0.0/", files: "/node_modules/ds-fonts-1.0.0/fonts/" }
      ],
      network: [{ host: "use.example", reason: "serves the acumin faces only from there" }],
      ...check
    })
  );
  write(join(dir, "node_modules", "ds-1.0.0", "dist", "ds.css"), DS_CSS);
  write(join(dir, "node_modules", "ds-1.0.0", "dist", "ds.js"), "/* ds */\n");
  write(join(dir, "node_modules", "ds-1.0.0", "dist", "ds.js.map"), "{}");
  write(join(dir, "node_modules", "ds-fonts-1.0.0", "package.json"), JSON.stringify({ name: "@ds/fonts", version: "1.0.0", license: "MIT", repository: { url: "git+https://github.com/ds/fonts.git" } }));
  write(join(dir, "node_modules", "ds-fonts-1.0.0", "fonts", "lato", "lato.css"), '@font-face{font-family:"Lato";src:url("path/to/file/lato.woff2") format("woff2")}');
  write(join(dir, "node_modules", "ds-fonts-1.0.0", "fonts", "lato", "lato.woff2"), "LATO");
  write(join(dir, "node_modules", "ds-fonts-1.0.0", "fonts", "lato", "LICENSE.txt"), "OFL");
  write(join(dir, "node_modules", "ds-fonts-1.0.0", "fonts", "icons", "icons.woff"), "ICONS");
  const spec = {
    vendor: [{ from: "node_modules/ds-1.0.0/dist", only: (name) => !name.endsWith(".map") }],
    notices: { "ds-1.0.0": "Demo Design System 1.0.0. Licence: MIT." }
  };
  return { root, dir, bindingsDir: join(root, "bindings"), out: join(root, "out"), spec };
}

test("a pack answers the routed references from its own files and takes the others out", () => {
  const { bindingsDir, out, spec } = fixture();
  const manifest = buildBindingPacks({ out, ids: ["demo"], bindingsDir, specs: { demo: spec } });
  const entry = manifest.demo;
  const files = join(out, "demo", "files");

  assert.equal(entry.designSystem, "Demo Design System");
  assert.equal(entry.release, "1.0.0");
  assert.equal(entry.global, "DatumBindingDemo");
  assert.equal(entry.module, "./demo/demo.js");
  assert.equal(entry.script, "./demo/demo.iife.js");
  assert.equal(entry.bodyClass, "ds-supported");
  assert.ok(existsSync(join(out, "demo", "demo.js")) && existsSync(join(out, "demo", "demo.iife.js")));
  assert.ok(!existsSync(join(files, "ds-1.0.0", "dist", "ds.js.map")), "the spec's filter holds");

  const css = readFileSync(join(files, "ds-1.0.0", "dist", "ds.css"), "utf8");
  assert.equal(
    css,
    [
      '@import url("./ds.offline-1.css");',
      '@font-face{font-family:icons;src:url("../../ds-fonts-1.0.0/fonts/icons/icons.woff") format("woff")}',
      ".logo{background:none}",
      ".local{background:url(img/a.svg)}"
    ].join("")
  );
  assert.equal(readFileSync(join(files, "ds-1.0.0", "dist", "ds.offline-1.css"), "utf8"), '@font-face{font-family:"Lato";src:url("../../ds-fonts-1.0.0/fonts/lato/lato.woff2") format("woff2")}');
  assert.equal(readFileSync(join(files, "ds-fonts-1.0.0", "fonts", "lato", "lato.woff2"), "utf8"), "LATO");
  assert.equal(readFileSync(join(files, "ds-fonts-1.0.0", "fonts", "icons", "icons.woff"), "utf8"), "ICONS");
  assert.deepEqual(remoteReferences(out, ["demo"]), []);

  assert.deepEqual(
    entry.localized.map((item) => item.by),
    ["./ds.offline-1.css", "../../ds-fonts-1.0.0/fonts/icons/icons.woff"]
  );
  assert.deepEqual(
    entry.dropped.map((item) => [item.url, item.reason]),
    [
      ["https://use.example/af/1/l", "only on use.example: serves the acumin faces only from there"],
      ["https://gov.example/logo.svg", "nothing in bindings/demo/binding-check.json answers gov.example"]
    ]
  );
});

test("the manifest places the check file's stylesheets and scripts in the pack, with their integrity", () => {
  const { bindingsDir, out, spec } = fixture();
  const entry = buildBindingPack({ id: "demo", out, bindingsDir, spec });
  assert.deepEqual(entry.stylesheets, [{ url: "./demo/files/ds-1.0.0/dist/ds.css", integrity: integrityOf(join(out, "demo", "files", "ds-1.0.0", "dist", "ds.css")) }]);
  assert.match(entry.stylesheets[0].integrity, /^sha384-[A-Za-z0-9+/]{64}$/);
  assert.equal(entry.scripts[0].url, "./demo/files/ds-1.0.0/dist/ds.js");
  assert.equal(entry.scripts[0].classic, true);
  assert.deepEqual(entry.scripts[0].attributes, { "data-css": "./demo/files/ds-1.0.0/dist/ds.css", mode: "plain" });
  assert.equal(entry.scripts[0].integrity, integrityOf(join(out, "demo", "files", "ds-1.0.0", "dist", "ds.js")));
});

test("a package the pack brings in gets a notice and its licence files", () => {
  const { bindingsDir, out, spec } = fixture();
  buildBindingPack({ id: "demo", out, bindingsDir, spec });
  const files = join(out, "demo", "files");
  assert.equal(readFileSync(join(files, "ds-1.0.0", "NOTICE.txt"), "utf8"), "Demo Design System 1.0.0. Licence: MIT.\n");
  const notice = readFileSync(join(files, "ds-fonts-1.0.0", "NOTICE.txt"), "utf8");
  assert.match(notice, /^@ds\/fonts 1\.0\.0: https:\/\/github\.com\/ds\/fonts\n/);
  assert.match(notice, /Licence: MIT, as the package's package\.json declares/);
  assert.match(notice, /fonts\/icons\/icons\.woff, fonts\/lato\/lato\.woff2/);
  assert.equal(readFileSync(join(files, "ds-fonts-1.0.0", "fonts", "lato", "LICENSE.txt"), "utf8"), "OFL");
});

test("a binding that is not built, or a route whose package lacks the file, stops the pack with what to do", () => {
  const unbuilt = fixture();
  rmSync(join(unbuilt.dir, "dist"), { recursive: true });
  assert.throws(() => buildBindingPack({ id: "demo", out: unbuilt.out, bindingsDir: unbuilt.bindingsDir, spec: unbuilt.spec }), /bindings\/demo has no dist\/demo\.js; run `npm install` and `npm run build` in bindings\/demo/);

  const lacking = fixture();
  rmSync(join(lacking.dir, "node_modules", "ds-fonts-1.0.0", "fonts", "icons"), { recursive: true });
  assert.throws(() => buildBindingPack({ id: "demo", out: lacking.out, bindingsDir: lacking.bindingsDir, spec: lacking.spec }), /the route https:\/\/cdn\.example\/@ds\/fonts@1\.0\.0\/ needs \/node_modules\/ds-fonts-1\.0\.0\/fonts\/icons\/icons\.woff/);

  const noSpec = fixture();
  assert.throws(() => buildBindingPack({ id: "demo", out: noSpec.out, bindingsDir: noSpec.bindingsDir, spec: undefined }), /binding-assets-spec\.mjs has no entry/);
});

test("a check file that names a file the spec does not copy stops the pack", () => {
  const { bindingsDir, out, spec } = fixture({ check: { stylesheets: ["/node_modules/ds-1.0.0/other.css"] } });
  assert.throws(() => buildBindingPack({ id: "demo", out, bindingsDir, spec }), /binding-check\.json names \/node_modules\/ds-1\.0\.0\/other\.css, which the spec does not copy/);
});

test("building packs replaces only the packs' own folders", () => {
  const { bindingsDir, out, spec } = fixture();
  write(join(out, "keep.txt"), "not a pack");
  write(join(out, "demo", "stale.txt"), "from an earlier run");
  buildBindingPacks({ out, ids: ["demo"], bindingsDir, specs: { demo: spec } });
  assert.equal(readFileSync(join(out, "keep.txt"), "utf8"), "not a pack");
  assert.ok(!existsSync(join(out, "demo", "stale.txt")));
});

test("the packs never hold what is never published", () => {
  const { dir, bindingsDir, out, spec } = fixture();
  write(join(dir, "node_modules", "ds-1.0.0", "dist", "govuk-crest.svg"), "<svg/>");
  assert.throws(() => buildBindingPacks({ out, ids: ["demo"], bindingsDir, specs: { demo: spec } }), /never published/);
});
