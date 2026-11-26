import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { BROWSER_LICENCE_FILES, browserSection, describeFiles, mavenSection, pythonSection, readmeText, runtimeSection, sumsText } from "../lib/bundle.mjs";
import { splitPath, writeTarGz } from "../lib/tar.mjs";
import { leaves } from "../lib/watch.mjs";

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), "datum-bundle-"));
  roots.push(root);
  return root;
};
const write = (file, text) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
};
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const ABIS = { sandboxAbi: "4.0.0", pdfAbi: "4.0.0" };

test("leaves: only http(s) and ws(s) requests to a host that is not local", () => {
  const local = ["127.0.0.1:4173", "api.internal"];
  assert.equal(leaves("http://127.0.0.1:4173/browser/datum-form.js", local), false);
  assert.equal(leaves("https://api.internal/submissions", local), false);
  assert.equal(leaves("http://127.0.0.1:9999/other-port", local), true);
  assert.equal(leaves("https://fonts.googleapis.com/css2?family=Lato", local), true);
  assert.equal(leaves("wss://telemetry.example/socket", local), true);
  for (const url of ["data:text/css,a{}", "blob:http://127.0.0.1:4173/1", "about:blank", "not a url"]) assert.equal(leaves(url, local), false, url);
});

test("browserSection: the bundles and the plugins, without source maps or declarations", () => {
  const root = temp();
  const dist = join(root, "dist");
  for (const name of ["datum-form.js", "datum-builder.js", "datum-wasm.js", "datum-pdf.js", "datum-sandbox-program.js", "datum-pdf-program.js", "datum-form.js.map", "fonts/DejaVuSans.ttf", "types/index.d.ts", ...BROWSER_LICENCE_FILES]) write(join(dist, name), name);
  write(join(root, "plugins", "icons", "package.json"), "{}");
  write(join(root, "plugins", "icons", "dist", "icons.js"), "icons");
  write(join(root, "plugins", "icons", "dist", "icons.LICENSE.txt"), "icons licences");
  write(join(root, "plugins", "icons", "dist", "icons.js.map"), "{}");
  const section = browserSection({ dist, pluginsDir: join(root, "plugins") });
  assert.deepEqual(
    section.files.map((file) => file.to),
    [
      "browser/datum-builder.LICENSE.txt",
      "browser/datum-builder.js",
      "browser/datum-form.LICENSE.txt",
      "browser/datum-form.js",
      "browser/datum-pdf-pages.LICENSE.txt",
      "browser/datum-pdf-program.LICENSE.txt",
      "browser/datum-pdf-program.js",
      "browser/datum-pdf.LICENSE.txt",
      "browser/datum-pdf.js",
      "browser/datum-sandbox-program.js",
      "browser/datum-wasm.LICENSE.txt",
      "browser/datum-wasm.js",
      "browser/fonts/DejaVuSans.ttf",
      "browser/fonts/LICENSE",
      "browser/pdfjs/LICENSE",
      "browser/plugins/icons/icons.LICENSE.txt",
      "browser/plugins/icons/icons.js"
    ]
  );
  assert.deepEqual(section.facts.plugins, ["icons"]);
  assert.ok(browserSection({ dist, pluginsDir: join(root, "plugins"), sourceMaps: true }).files.some((file) => file.to === "browser/datum-form.js.map"));

  // A dist from a default build has no maps: asking for them says how to get them.
  rmSync(join(dist, "datum-form.js.map"));
  assert.throws(() => browserSection({ dist, pluginsDir: join(root, "plugins"), sourceMaps: true }), /no source maps.*DATUM_SOURCE_MAPS=1 npm run datum:build/);
  assert.ok(browserSection({ dist, pluginsDir: join(root, "plugins") }).files.length > 0);

  rmSync(join(dist, "datum-wasm.js"));
  assert.throws(() => browserSection({ dist, pluginsDir: join(root, "plugins") }), /datum-wasm\.js is missing .*npm run datum:build/);
  write(join(dist, "datum-wasm.js"), "datum-wasm.js");

  // A bundle's licence file, the fonts' and pdf.js's, and a plugin's are each required.
  for (const gone of ["datum-form.LICENSE.txt", "fonts/LICENSE", "pdfjs/LICENSE"]) {
    rmSync(join(dist, gone));
    assert.throws(() => browserSection({ dist, pluginsDir: join(root, "plugins") }), new RegExp(`${gone.replace(".", "\\.")} is missing .*npm run datum:build`));
    write(join(dist, gone), gone);
  }
  rmSync(join(root, "plugins", "icons", "dist", "icons.LICENSE.txt"));
  assert.throws(() => browserSection({ dist, pluginsDir: join(root, "plugins") }), /plugins\/icons has no <bundle>\.LICENSE\.txt.*npm run plugins:build/);
});

test("runtimeSection: the file must be the one both hosts pin", () => {
  const root = temp();
  const wasmFile = write(join(root, "qjs-wasi.wasm"), "WASM");
  const pinFile = write(join(root, "runtime.json"), "{}");
  const pin = { name: "fastapi", version: "0.16.2", sha256: sha256("WASM") };
  const section = runtimeSection({ wasmFile, pinFile, pins: [pin, { ...pin, name: "jvm" }] });
  assert.deepEqual(section.files.map((file) => file.to), ["runtime/qjs-wasi.wasm", "runtime/runtime.json"]);
  assert.deepEqual(section.facts, { qjsVersion: "0.16.2", sha256: sha256("WASM") });

  assert.throws(() => runtimeSection({ wasmFile, pinFile, pins: [pin, { name: "jvm", version: "0.17.0", sha256: sha256("OTHER") }] }), /the hosts pin different QuickJS runtimes/);
  assert.throws(() => runtimeSection({ wasmFile, pinFile, pins: [{ ...pin, sha256: sha256("OTHER") }] }), /is not the pinned qjs-wasi\.wasm/);
  assert.throws(() => runtimeSection({ wasmFile: join(root, "absent.wasm"), pinFile, pins: [pin] }), /does not exist: run `npm run fastapi:assets`/);
});

function pythonRelease(root, { abis = ABIS, version = "1.2.3" } = {}) {
  const dir = join(root, `datum-fastapi-${version}`);
  write(join(dir, "datum_core-1.2.3-py3-none-any.whl"), "WHEEL");
  write(join(dir, "datum_core-1.2.3.tar.gz"), "SDIST");
  write(join(dir, "SHA256SUMS"), `${sha256("WHEEL")}  datum_core-1.2.3-py3-none-any.whl\n${sha256("SDIST")}  datum_core-1.2.3.tar.gz\n`);
  write(join(dir, "release.json"), JSON.stringify({ version, commit: "abc", buildId: "b1", ...abis, distributions: [{ name: "argusvane-datum-core" }] }));
  return dir;
}

test("pythonSection: the release's files, each held to its SHA256SUMS, and the requirements", () => {
  const root = temp();
  const releaseDir = pythonRelease(root);
  const requirementsFile = write(join(root, "requirements.txt"), "fastapi==1.0.0\n");
  const section = pythonSection({ releaseDir, version: "1.2.3", abis: ABIS, requirementsFile });
  assert.deepEqual(section.files.map((file) => file.to), ["python/datum_core-1.2.3-py3-none-any.whl", "python/datum_core-1.2.3.tar.gz", "python/requirements-third-party.txt"]);
  assert.deepEqual(section.facts, { version: "1.2.3", commit: "abc", buildId: "b1", distributions: ["argusvane-datum-core"] });

  writeFileSync(join(releaseDir, "datum_core-1.2.3.tar.gz"), "TAMPERED");
  assert.throws(() => pythonSection({ releaseDir, version: "1.2.3", abis: ABIS }), /is not the file its SHA256SUMS names/);
});

test("pythonSection: a release of another version or another ABI is refused", () => {
  const root = temp();
  assert.throws(() => pythonSection({ releaseDir: join(root, "none"), version: "1.2.3", abis: ABIS }), /has no release\.json\. Run `npm run fastapi:assets`, then `npm run fastapi:release -- --version 1\.2\.3 --dry-run`/);
  assert.throws(() => pythonSection({ releaseDir: pythonRelease(root), version: "1.2.4", abis: ABIS }), /is version 1\.2\.3, not 1\.2\.4/);
  const stale = pythonRelease(temp(), { abis: { sandboxAbi: "3.0.0", pdfAbi: "4.0.0" } });
  assert.throws(() => pythonSection({ releaseDir: stale, version: "1.2.3", abis: ABIS }), /built with the sandbox ABI 3\.0\.0 and the PDF ABI 4\.0\.0, and the browser bundles here are 4\.0\.0 and 4\.0\.0/);
});

test("mavenSection: a Maven repository layout, each file held to the digest the release recorded", () => {
  const root = temp();
  const jvmDir = join(root, "jvm");
  write(join(jvmDir, "libs", "datum-core", ".flattened-pom.xml"), "POM");
  write(join(jvmDir, "libs", "datum-core", "target", "datum-core-1.2.3.jar"), "JAR");
  const releaseDir = join(jvmDir, "dist", "datum-jvm-1.2.3");
  write(
    join(releaseDir, "release.json"),
    JSON.stringify({
      version: "1.2.3",
      groupId: "io.github.example",
      source: "abc",
      assetsBuildId: "b1",
      ...ABIS,
      artifacts: [
        {
          artifactId: "datum-core",
          files: [
            { file: "libs/datum-core/.flattened-pom.xml", kind: "pom", deployedAs: "datum-core-1.2.3.pom", sha256: sha256("POM") },
            { file: "libs/datum-core/target/datum-core-1.2.3.jar", kind: "main", sha256: sha256("JAR") }
          ]
        }
      ]
    })
  );
  const sums = [];
  const checksum = (to, text) => {
    sums.push([to, text]);
    return write(join(root, "sha1", `${sums.length}`), text);
  };
  const section = mavenSection({ jvmDir, releaseDir, version: "1.2.3", abis: ABIS, checksum });
  const base = "maven/io/github/example/datum-core/1.2.3";
  assert.deepEqual(section.files.map((file) => file.to), [`${base}/datum-core-1.2.3.pom`, `${base}/datum-core-1.2.3.pom.sha1`, `${base}/datum-core-1.2.3.jar`, `${base}/datum-core-1.2.3.jar.sha1`]);
  assert.equal(sums[1][1], `${createHash("sha1").update("JAR").digest("hex")}\n`);
  assert.deepEqual(section.facts, { version: "1.2.3", groupId: "io.github.example", commit: "abc", buildId: "b1", artifacts: ["datum-core"] });

  writeFileSync(join(jvmDir, "libs", "datum-core", "target", "datum-core-1.2.3.jar"), "REBUILT");
  assert.throws(() => mavenSection({ jvmDir, releaseDir, version: "1.2.3", abis: ABIS }), /datum-core-1\.2\.3\.jar changed since the release recorded it/);
  assert.throws(() => mavenSection({ jvmDir, releaseDir, version: "1.2.3", abis: { sandboxAbi: "5.0.0", pdfAbi: "4.0.0" } }), /The JVM release was built with the sandbox ABI 4\.0\.0/);
});

test("describeFiles and sumsText: every file with its size and digest, sorted by path", () => {
  const root = temp();
  const described = describeFiles([
    { to: "b/two.txt", from: write(join(root, "2"), "two") },
    { to: "a/one.txt", from: write(join(root, "1"), "one!") }
  ]);
  assert.deepEqual(described, [
    { path: "a/one.txt", bytes: 4, sha256: sha256("one!") },
    { path: "b/two.txt", bytes: 3, sha256: sha256("two") }
  ]);
  assert.equal(sumsText(described), `${sha256("one!")}  a/one.txt\n${sha256("two")}  b/two.txt\n`);
});

test("readmeText: says what is there, what was left out, and whether the bundle was drawn", () => {
  const sections = {
    browser: { files: 1, plugins: [] },
    bindings: { files: 2, packs: { gcds: { designSystem: "GC Design System", release: "1.7.0", answeredFromThePack: 3, takenOut: 0 }, alberta: { designSystem: "Alberta Design System", release: "3.2.0", answeredFromThePack: 0, takenOut: 20 } } },
    runtime: { files: 2, qjsVersion: "0.16.2", sha256: "x" }
  };
  const text = readmeText({ version: "1.2.3", commit: "abc", dirty: true, abis: ABIS, sections, skipped: ["python", "maven", "tools"], hasGuide: true, checked: true });
  assert.match(text, /^# Datum 1\.2\.3, offline bundle\n/);
  assert.match(text, /Built from commit abc, with uncommitted changes in the tree\. Sandbox ABI 4\.0\.0, PDF ABI 4\.0\.0/);
  assert.match(text, /\| `alberta` \| Alberta Design System \| 3\.2\.0 \| 0 \| 20 \|/);
  assert.match(text, /The `dropped` list of `alberta` in `bindings\/manifest\.json`/);
  assert.match(text, /Not in this bundle: python, maven, tools/);
  assert.match(text, /The bundle was drawn in a browser that could reach nothing but the folder itself/);
  assert.doesNotMatch(text, /### python\//);
  assert.doesNotMatch(text, /\n\n\n/);
  const unchecked = readmeText({ version: "1.2.3", commit: "abc", dirty: false, abis: ABIS, sections, skipped: [], hasGuide: false, checked: false });
  assert.match(unchecked, /written without the browser check/);
  assert.doesNotMatch(unchecked, /AIR-GAPPED\.md/);
});

test("splitPath: a long path goes into name and prefix at a slash, or does not fit", () => {
  assert.deepEqual(splitPath("a/b.txt"), { name: "a/b.txt", prefix: "" });
  const long = `${"d".repeat(80)}/${"e".repeat(60)}/file.txt`;
  assert.deepEqual(splitPath(long), { name: `${"e".repeat(60)}/file.txt`, prefix: "d".repeat(80) });
  assert.equal(splitPath(`${"x".repeat(160)}/${"y".repeat(120)}.txt`), undefined);
});

test("writeTarGz: the system's tar reads it back, long paths included, and the same input gives the same bytes", async () => {
  const root = temp();
  const paths = ["bundle/README.md", `bundle/${"deep/".repeat(30)}file.woff2`, `bundle/${"n".repeat(140)}/${"m".repeat(130)}.css`, "bundle/empty.txt"];
  const entries = paths.map((path, index) => ({ path, from: write(join(root, "in", `${index}`), index === 3 ? "" : `content ${index}\n`.repeat(index * 300 + 1)) }));
  const first = join(root, "a.tar.gz");
  const second = join(root, "b.tar.gz");
  await writeTarGz(first, entries, { mtime: 1794426259 });
  await writeTarGz(second, entries, { mtime: 1794426259 });
  assert.ok(readFileSync(first).equals(readFileSync(second)));

  const out = join(root, "out");
  mkdirSync(out);
  const extracted = spawnSync("tar", ["-xzf", first, "-C", out], { encoding: "utf8" });
  assert.equal(extracted.status, 0, extracted.stderr);
  for (const [index, path] of paths.entries()) assert.equal(readFileSync(join(out, path), "utf8"), readFileSync(entries[index].from, "utf8"), path);
});
