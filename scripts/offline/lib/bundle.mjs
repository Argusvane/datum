// What goes into an offline bundle and how each part is held to what was built: one function per section,
// each returning the files it contributes as `{ to, from }` (the path inside the bundle and the file it is
// copied from) with the facts the bundle's manifest records. A section throws an Error that says what to
// run when its input is missing or is not the build the rest of the bundle is. Nothing here reaches the
// network or uploads anything; ../bundle.mjs calls these and writes the folder and the archive.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

export const sha256Of = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const sha1Of = (file) => createHash("sha1").update(readFileSync(file)).digest("hex");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

/** Every file below a folder, '/'-separated and relative to it, sorted. */
export function filesUnder(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = join(dir, entry.name);
      return entry.isDirectory() ? filesUnder(full, base) : [relative(base, full).split(sep).join("/")];
    })
    .sort();
}

/**
 * The licence files a built packages/datum/dist holds beside the bundles it publishes: one
 * `<bundle>.LICENSE.txt` for each bundle (the third-party packages it carries and their licence texts)
 * and the licence of the DejaVu fonts and of pdf.js's data folders. A bundle without them would ship
 * third-party code with no licence text, so the browser section refuses a dist that lacks one.
 */
export const BROWSER_LICENCE_FILES = [
  ...["datum-form", "datum-builder", "datum-pdf", "datum-pdf-pages", "datum-wasm", "datum-pdf-program"].map((bundle) => `${bundle}.LICENSE.txt`),
  "fonts/LICENSE",
  "pdfjs/LICENSE"
];

/** The sections of a bundle, in the order the manifest lists them. */
export const SECTIONS = ["browser", "bindings", "runtime", "python", "maven", "tools"];

/**
 * browser/: the built bundles a page loads (packages/datum/dist) and each plugin's bundle
 * (plugins/<name>/dist) under browser/plugins/<name>/, each with its licence files. Source maps and the TypeScript declarations stay
 * out unless `sourceMaps`, which needs a dist built with DATUM_SOURCE_MAPS=1.
 */
export function browserSection({ dist, pluginsDir, sourceMaps = false }) {
  for (const file of ["datum-form.js", "datum-builder.js", "datum-wasm.js", "datum-pdf.js", "datum-sandbox-program.js", "datum-pdf-program.js"]) {
    if (!existsSync(join(dist, file))) throw new Error(`${file} is missing from packages/datum/dist: run \`npm run datum:build\``);
  }
  for (const file of BROWSER_LICENCE_FILES) {
    if (!existsSync(join(dist, file))) throw new Error(`${file} is missing from packages/datum/dist: run \`npm run datum:build\``);
  }
  const wanted = (path) => !path.startsWith("types/") && !path.endsWith(".d.ts") && (sourceMaps || !path.endsWith(".map"));
  // A default build leaves no maps in dist (packages/datum/scripts/strip-source-maps.mjs): asked
  // for maps from such a folder, the bundle would carry none and say it did.
  if (sourceMaps && !filesUnder(dist).some((path) => path.endsWith(".map"))) {
    throw new Error("--source-maps: packages/datum/dist has no source maps, since a default build removes them; run `DATUM_SOURCE_MAPS=1 npm run datum:build` first");
  }
  const files = filesUnder(dist).filter(wanted).map((path) => ({ to: `browser/${path}`, from: join(dist, path) }));
  const plugins = [];
  for (const name of existsSync(pluginsDir) ? readdirSync(pluginsDir).sort() : []) {
    const pluginDist = join(pluginsDir, name, "dist");
    if (!existsSync(join(pluginsDir, name, "package.json"))) continue;
    if (!existsSync(pluginDist)) throw new Error(`plugins/${name} is not built: run \`npm run plugins:build\``);
    // A plugin's own licence file (`<bundle>.LICENSE.txt`) and the licence texts of the packages it carries ride with its bundle.
    if (!filesUnder(pluginDist).some((path) => path.endsWith(".LICENSE.txt"))) throw new Error(`plugins/${name} has no <bundle>.LICENSE.txt in its dist: run \`npm run plugins:build\``);
    plugins.push(name);
    for (const path of filesUnder(pluginDist).filter(wanted)) files.push({ to: `browser/plugins/${name}/${path}`, from: join(pluginDist, path) });
  }
  return { files, facts: { plugins } };
}

/** bindings/: the offline packs already written to `packsDir` (lib/packs.mjs), as they are. */
export function bindingsSection({ packsDir, manifest }) {
  const files = filesUnder(packsDir).map((path) => ({ to: `bindings/${path}`, from: join(packsDir, path) }));
  const packs = Object.fromEntries(
    Object.entries(manifest).map(([id, entry]) => [id, { designSystem: entry.designSystem, release: entry.release, answeredFromThePack: entry.localized.length, takenOut: entry.dropped.length }])
  );
  return { files, facts: { packs } };
}

/**
 * runtime/: quickjs-ng's qjs-wasi.wasm, the engine both server hosts run the sandbox in, with the pin it
 * is held to. `pins` is `[{ name, version, sha256 }]`, one per host; they must agree, and the file must be
 * the one they name. A host's build takes the file from here instead of downloading it.
 */
export function runtimeSection({ wasmFile, pinFile, pins }) {
  const [first, ...rest] = pins;
  for (const pin of rest) {
    if (pin.sha256 !== first.sha256 || pin.version !== first.version) {
      throw new Error(`the hosts pin different QuickJS runtimes (${first.name}: ${first.version} ${first.sha256.slice(0, 12)}; ${pin.name}: ${pin.version} ${pin.sha256.slice(0, 12)}): run \`node integrations/shared/scripts/pin-runtime.mjs --target all v<version>\``);
    }
  }
  if (!existsSync(wasmFile)) throw new Error(`${wasmFile} does not exist: run \`npm run fastapi:assets\` (it fetches the pinned qjs-wasi.wasm), or pass --qjs-wasm-file`);
  const actual = sha256Of(wasmFile);
  if (actual !== first.sha256) throw new Error(`${wasmFile} is not the pinned qjs-wasi.wasm (sha256 ${actual}, the pin is ${first.sha256})`);
  return {
    files: [
      { to: "runtime/qjs-wasi.wasm", from: wasmFile },
      { to: "runtime/runtime.json", from: pinFile }
    ],
    facts: { qjsVersion: first.version, sha256: first.sha256 }
  };
}

const abiProblem = (what, release, abis, fix) =>
  release.sandboxAbi === abis.sandboxAbi && release.pdfAbi === abis.pdfAbi
    ? undefined
    : `${what} was built with the sandbox ABI ${release.sandboxAbi} and the PDF ABI ${release.pdfAbi}, and the browser bundles here are ${abis.sandboxAbi} and ${abis.pdfAbi}: the page and the server would run different validation and PDF programs, so they cannot ship together. ${fix}`;

/**
 * python/: the wheels and source distributions of a FastAPI release folder
 * (integrations/fastapi/dist/datum-fastapi-<version>/, written by `npm run fastapi:release`), each held to
 * the folder's own SHA256SUMS, and `requirements` (the third-party packages with their hashes, from the
 * lock) as python/requirements-third-party.txt.
 */
export function pythonSection({ releaseDir, version, abis, requirementsFile }) {
  const fix = `Run \`npm run fastapi:assets\`, then \`npm run fastapi:release -- --version ${version} --dry-run\` (or pass --build).`;
  if (!existsSync(join(releaseDir, "release.json"))) throw new Error(`${releaseDir} has no release.json. ${fix}`);
  const release = readJson(join(releaseDir, "release.json"));
  if (release.version !== version) throw new Error(`${releaseDir}/release.json is version ${release.version}, not ${version}. ${fix}`);
  const problem = abiProblem("The FastAPI release", release, abis, fix);
  if (problem) throw new Error(problem);
  const files = [];
  for (const line of readFileSync(join(releaseDir, "SHA256SUMS"), "utf8").split("\n").filter((entry) => entry.trim() !== "")) {
    const [sum, name] = line.split(/\s+/);
    const from = join(releaseDir, name);
    if (!existsSync(from)) throw new Error(`${releaseDir} lists ${name} in SHA256SUMS and does not hold it. ${fix}`);
    if (sha256Of(from) !== sum) throw new Error(`${from} is not the file its SHA256SUMS names. ${fix}`);
    files.push({ to: `python/${name}`, from });
  }
  if (requirementsFile) files.push({ to: "python/requirements-third-party.txt", from: requirementsFile });
  return { files, facts: { version: release.version, commit: release.commit, buildId: release.buildId, distributions: release.distributions.map((entry) => entry.name) } };
}

/**
 * maven/: the artifacts of a JVM release folder (integrations/jvm/dist/datum-jvm-<version>/release.json,
 * written by `npm run jvm:release`) laid out as a Maven repository, so a build names the folder as a
 * `file://` repository or copies it into a repository manager. Each file is read from where the release
 * recorded it (under integrations/jvm) and held to the recorded sha256: a jar rebuilt since is refused.
 * `checksum(file)` returns the path of a file holding the `.sha1` text Maven looks for beside an artifact.
 */
export function mavenSection({ jvmDir, releaseDir, version, abis, checksum }) {
  const fix = `Run \`npm run jvm:release -- --version ${version} --dry-run\` (or pass --build).`;
  if (!existsSync(join(releaseDir, "release.json"))) throw new Error(`${releaseDir} has no release.json. ${fix}`);
  const release = readJson(join(releaseDir, "release.json"));
  if (release.version !== version) throw new Error(`${releaseDir}/release.json is version ${release.version}, not ${version}. ${fix}`);
  const problem = abiProblem("The JVM release", release, abis, fix);
  if (problem) throw new Error(problem);
  const group = release.groupId.split(".").join("/");
  const files = [];
  for (const artifact of release.artifacts) {
    for (const file of artifact.files) {
      const from = join(jvmDir, file.file);
      if (!existsSync(from)) throw new Error(`${file.file} of the JVM release is no longer under integrations/jvm. ${fix}`);
      if (sha256Of(from) !== file.sha256) throw new Error(`integrations/jvm/${file.file} changed since the release recorded it (it was rebuilt). ${fix}`);
      const to = `maven/${group}/${artifact.artifactId}/${version}/${file.deployedAs ?? basename(file.file)}`;
      files.push({ to, from });
      if (checksum) files.push({ to: `${to}.sha1`, from: checksum(to, `${sha1Of(from)}\n`) });
    }
  }
  return { files, facts: { version: release.version, groupId: release.groupId, commit: release.source, buildId: release.assetsBuildId, artifacts: release.artifacts.map((artifact) => artifact.artifactId) } };
}

/** tools/: the npm tarballs given (`[{ file, name }]`), such as the conformance suite with its host and binding checks. */
export function toolsSection({ tarballs }) {
  return { files: tarballs.map((entry) => ({ to: `tools/${basename(entry.file)}`, from: entry.file })), facts: { packages: tarballs.map((entry) => entry.name) } };
}

/** The `files` list of a manifest: every bundle file with its size and sha256, sorted by path. */
export function describeFiles(files) {
  return [...files]
    .sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0))
    .map((file) => ({ path: file.to, bytes: statSync(file.from).size, sha256: sha256Of(file.from) }));
}

/** The text of SHA256SUMS over `described` (`shasum -a 256 -c SHA256SUMS` in the bundle's folder checks it). */
export const sumsText = (described) => described.map((file) => `${file.sha256}  ${file.path}\n`).join("");

/** The bundle's README: what each folder is and how it is used with no registry and no network. */
export function readmeText({ version, commit, dirty, abis, sections, skipped, hasGuide, checked }) {
  const has = (name) => name in sections;
  const lines = [
    `# Datum ${version}, offline bundle`,
    "",
    `Everything Datum publishes for release ${version}, as files, for a network with no way out: carry this folder (or the archive) across, verify it, and serve or install from it. Nothing here fetches anything when it is used.`,
    "",
    `Built from commit ${commit ?? "(unknown)"}${dirty ? ", with uncommitted changes in the tree" : ""}. Sandbox ABI ${abis.sandboxAbi}, PDF ABI ${abis.pdfAbi}: the browser files and the server packages here are one build and must be deployed together.`,
    "",
    "## Verify",
    "",
    "```",
    "shasum -a 256 -c SHA256SUMS",
    "```",
    "",
    "`manifest.json` lists every file with its size and digest, and what each section was built from.",
    "",
    "## What is here",
    ""
  ];
  if (has("browser")) {
    lines.push(
      "### browser/",
      "",
      "The files a page loads: `datum-form.js`, `datum-builder.js`, the PDF module (`datum-pdf.js`, its program, `fonts/`, `pdfjs/`), the validation sandbox (`datum-wasm.js`) and the plugins under `plugins/`. Serve the folder as it is, from the page's own origin, and keep the files beside each other: the loaders find their chunks, fonts and programs by relative address.",
      ""
    );
  }
  if (has("bindings")) {
    const packs = sections.bindings.packs;
    const partial = Object.entries(packs).filter(([, pack]) => pack.takenOut > 0);
    lines.push(
      "### bindings/",
      "",
      "One pack per design-system binding: the binding's bundle and the design system's own files, with every reference to another host answered from the pack or taken out. `manifest.json` gives each pack's stylesheets and scripts with their `integrity`; register a binding with those addresses.",
      "",
      "| Pack | Design system | Release | Answered from the pack | Taken out |",
      "| --- | --- | --- | --- | --- |",
      ...Object.entries(packs).map(([id, pack]) => `| \`${id}\` | ${pack.designSystem} | ${pack.release} | ${pack.answeredFromThePack} | ${pack.takenOut} |`),
      ""
    );
    if (partial.length > 0) {
      lines.push(
        `Taken out means the design system publishes the file only on its own servers (a licensed typeface, an image on the government's site), so no pack can carry it: the reference is removed and the text falls back along the stylesheet's font list. The \`dropped\` list of ${partial.map(([id]) => `\`${id}\``).join(", ")} in \`bindings/manifest.json\` names each one.`,
        ""
      );
    }
  }
  if (has("runtime")) {
    lines.push(
      "### runtime/",
      "",
      `\`qjs-wasi.wasm\`, quickjs-ng ${sections.runtime.qjsVersion}: the engine the server hosts run the validation sandbox in. Datum's Python and JVM packages already carry it. A host built from source takes it from this file instead of downloading it (\`npm run fastapi:assets -- --qjs-wasm-file runtime/qjs-wasi.wasm\`; the JVM build's \`-Dqjs.wasm.file=runtime/qjs-wasi.wasm -Ddownload.plugin.skip=true\`), and the build still holds it to the pinned digest (\`runtime.json\`).`,
      ""
    );
  }
  if (has("python")) {
    lines.push(
      "### python/",
      "",
      "Datum for FastAPI: a wheel and a source distribution of each package.",
      "",
      "```",
      `pip install --no-index --find-links python/ --find-links <your wheel mirror> "argusvane-datum-fastapi[all]==${version}"`,
      "```",
      "",
      "`requirements-third-party.txt` lists every third-party package the install needs, pinned with hashes, from the release's lock file. They are not in this bundle: bring them through your own package mirror (`pip download -r python/requirements-third-party.txt` on a connected machine, for the interpreter and platform you deploy on; `wasmtime` and a few others ship a wheel per platform).",
      ""
    );
  }
  if (has("maven")) {
    lines.push(
      "### maven/",
      "",
      `Datum for the JVM, laid out as a Maven repository (group \`${sections.maven.groupId}\`). Name the folder as a repository, or upload it to your repository manager:`,
      "",
      "```xml",
      "<repository><id>datum-offline</id><url>file:///path/to/maven</url></repository>",
      "```",
      "",
      "Import `datum-bom` and add the starters as usual. Third-party dependencies (Spring Boot and the others the poms name) are not in this bundle: they resolve through your repository manager.",
      ""
    );
  }
  if (has("tools")) {
    lines.push(
      "### tools/",
      "",
      `npm tarballs: ${sections.tools.packages.map((name) => `\`${name}\``).join(", ")}. The conformance suite carries \`datum-host-check\` (does a server host answer as Datum's own do) and \`datum-binding-check\`; install it with \`npm install tools/<file>.tgz\`.`,
      ""
    );
  }
  if (skipped.length > 0) lines.push(`Not in this bundle: ${skipped.join(", ")} (left out when it was built).`, "");
  lines.push(
    "## Check it",
    "",
    checked
      ? "The bundle was drawn in a browser that could reach nothing but the folder itself before it was written: the form, the form with its PDF module and sandbox, the builder, and the form under every pack. To repeat that against your own deployment, from a checkout of Datum:"
      : "This bundle was written without the browser check (`npm run offline:check -- --bundle <this folder>` draws it with nothing else in reach). To check your own deployment, from a checkout of Datum:",
    "",
    "```",
    "npm run offline:check -- --url https://forms.internal.example/your-page",
    "```",
    "",
    hasGuide ? "`AIR-GAPPED.md` is the deployment guide: the content security policy, the timestamp and revocation settings, and what each host needs." : "",
    "`LICENSE` and `THIRD_PARTY_NOTICES.md` cover Datum and what its bundles include; each bundle in `browser/` has a `<bundle>.LICENSE.txt` beside it naming the third-party packages it carries, and each design system's files carry a `NOTICE.txt` beside them."
  );
  return `${lines.filter((line, index, all) => !(line === "" && all[index - 1] === "")).join("\n").trimEnd()}\n`;
}
