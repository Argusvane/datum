// Which CI areas a push or pull request touches (the `changes` job of .github/workflows/ci.yml).
//
// The heavy jobs run only when a file that can affect them changed. This script lists the changed
// files with plain git, matches them against the path lists below, and writes one boolean per area
// to $GITHUB_OUTPUT. The table of areas and the jobs each one gates is documented in ci.yml, beside
// the job that runs this file; keep the two in step.
//
// Everything is true (nothing is skipped) when:
//   - the event is neither a push nor a pull request (a manual run from the Actions tab);
//   - the push has no usable "before" commit (a new branch has the all-zero sha, a force push can
//     leave a commit the clone no longer has);
//   - the git diff fails for any other reason.
// A wrong "true" costs minutes; a wrong "false" hides a failure, so every doubt resolves to true.
//
// Environment: EVENT_NAME, BEFORE_SHA (push), BASE_SHA (pull request), HEAD_SHA, GITHUB_OUTPUT.
// For tests: CHANGED_FILES_FILE names a file with one changed path per line, used instead of git,
// and EVENT_NAME then picks the event as above (default push).

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// A path ending in "/" is a directory prefix; any other entry is one file, matched exactly.
const SELF = [".github/workflows/ci.yml", ".github/scripts/changed-areas.mjs"];

// The packages every consumer of the QuickJS host or the PDF kernel builds from (file: links).
const ENGINE = ["engine/"];
const QUICKJS = ["packages/quickjs-wasm-host/", ...ENGINE];
const PDF_KERNEL = ["packages/pdf-kernel/", ...QUICKJS];
const SUBMISSIONS = ["packages/submissions/", ...PDF_KERNEL];
// The web components' own file: closure that the bundles are built from: the engine, the QuickJS
// host and the PDF kernel. (The conformance suite is a devDependency used only by the binding kit,
// so the jobs that run the kit add it themselves.)
const WEB_COMPONENTS = ["packages/datum/", "scripts/with-lock.mjs", ...PDF_KERNEL];
const HOST_SHARED = ["integrations/shared/", "package.json", "package-lock.json", "scripts/"];
// What the npm release reads and checks: the pack and smoke scripts, the forwarding command packages that every
// published command is installed beside, the notices library and licence texts the prepack and the bundle licence step
// import (scripts/npm/prepack.mjs, bundle-licence.mjs), and the release workflow.
const NPM_RELEASE = ["scripts/npm/", "packages/cli-forwarders/", "packages/datum/scripts/notices-lib.mjs", "packages/datum/notices/texts/", ".github/workflows/release-npm.yml"];
const WEB_COMPONENT_ACTIONS = [".github/actions/build-datum/", ".github/actions/install-datum/"];

export const AREAS = {
  // The FastAPI job: the uv workspace (its .python-version and uv.lock live inside it), the shared host tree, the
  // bundles and the conformance-suite commands its build runs.
  fastapi: [...SELF, "integrations/fastapi/", ...HOST_SHARED, ...WEB_COMPONENTS, ...SUBMISSIONS, "packages/conformance-suite/", ...WEB_COMPONENT_ACTIONS],
  // Every `binding <id>` row and the Firefox and WebKit rows: the bindings, the kit in
  // packages/datum, the engine and the conformance suite's binding-check.
  bindings: [...SELF, "bindings/", "packages/datum/", "scripts/with-lock.mjs", "packages/conformance-suite/", ...ENGINE],
  // feature-coverage installs the engine and nothing else.
  featureCoverage: [...SELF, ...ENGINE],
  // datum-visual-browser and datum-a11y-browser: the built renderer, its
  // dependencies and the generated accessibility report under docs/generated.
  datumBrowser: [...SELF, ...WEB_COMPONENTS, "docs/generated/", ...WEB_COMPONENT_ACTIONS],
  // The Node-matrix package jobs, each its own package and its file: closure.
  quickjsWasmHost: [...SELF, ...QUICKJS],
  pdfKernel: [...SELF, ...PDF_KERNEL],
  submissions: [...SELF, ...SUBMISSIONS],
  // The suite's tests read the shared endpoint catalogue and fixtures, the JVM host-test-kit
  // sources, the generated agent-tools reference and the writer of the program banner the banner test reads.
  conformanceSuite: [...SELF, "packages/conformance-suite/", ...NPM_RELEASE, ...SUBMISSIONS, "integrations/shared/", "integrations/jvm/libs/", "integrations/jvm/tck/", "docs/reference/agent-tools.md", "packages/datum/scripts/write-sandbox-program.ts"],
  formTest: [...SELF, "packages/form-test/", ...NPM_RELEASE, ...QUICKJS],
  // The host build scripts' own tests and the offline scripts' (node:test, Node built-ins only). The offline
  // libraries read the site's asset spec and the binding-check routing.
  hostScripts: [...SELF, "integrations/fastapi/", "integrations/jvm/", ...HOST_SHARED, "site/scripts/", "packages/conformance-suite/binding-check/"],
  // The offline job: the binding packs and the browser bundles drawn with nothing else in reach
  // (scripts/offline). It builds the bundles, the plugins and every reference binding.
  offline: [...SELF, "scripts/offline/", "site/scripts/", "bindings/", "plugins/", "integrations/shared/assets-lib.mjs", "packages/conformance-suite/", ...WEB_COMPONENTS, ...WEB_COMPONENT_ACTIONS, ".github/actions/build-plugin-packages/"],
  // The PIV agent (4 Python versions) is a standalone tool with its own pyproject.
  pivAgent: [...SELF, "tools/piv-agent/"],
  // The single jobs below ran on every push until 2026-11; each list is drawn wide on purpose.
  // engine: its own tree, the generated references under docs it checks (the feature matrix, the
  // agent-tools reference), and the plugins and packages its scripts and tests reach into.
  engine: [...SELF, ...ENGINE, "docs/", "plugins/", "packages/"],
  // datum: the package and its file: closure, the bindings its kit reads, and the generated
  // attribute reference under docs/reference that attributes:check compares.
  // The third-party notices (the root file, both hosts' notices.json, the BOM and runtime pins they list, the
  // Font Awesome plugin's lock) and the npm release scripts and workflow are checked or packed from this job's build.
  datum: [
    ...SELF,
    ...WEB_COMPONENTS,
    "bindings/",
    "docs/reference/",
    "THIRD_PARTY_NOTICES.md",
    "integrations/jvm/scripts/notices.json",
    "integrations/fastapi/scripts/notices.json",
    "integrations/jvm/datum-bom/pom.xml",
    "integrations/fastapi/packages/argusvane-datum-qjs-wasm/src/datum_qjs_wasm/runtime.json",
    "plugins/icons-fontawesome/package-lock.json",
    "scripts/npm/",
    ".github/workflows/release-npm.yml"
  ],
  // site: the marketing site and its docs, the bundles, plugin bundles and reference bindings its
  // live demos load, and the root scripts and composite actions that build them.
  site: [...SELF, "site/", "docs/", "README.md", ...WEB_COMPONENTS, "plugins/", "bindings/", "scripts/", "packages/conformance-suite/", ...WEB_COMPONENT_ACTIONS, ".github/actions/build-plugin-packages/"],
  // conformance-suite-artifacts: the suite's command over the built sandbox program.
  conformanceSuiteArtifacts: [...SELF, "packages/conformance-suite/", ...WEB_COMPONENTS, ...WEB_COMPONENT_ACTIONS],
  // packages and plugin <package>: the plugin packages over the installed web components.
  plugins: [...SELF, "plugins/", ...WEB_COMPONENTS, ".github/actions/install-datum/", ".github/actions/install-package/"],
};

export const outputName = (area) => area.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

export const matches = (file, list) => list.some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry));

/** The areas a changed-file list touches, or every area when `files` is null (a doubt). */
export const compute = (files) => Object.fromEntries(Object.entries(AREAS).map(([area, list]) => [area, files === null ? true : files.some((f) => matches(f, list))]));

const ZERO = /^0+$/;

const changedFiles = (env) => {
  if (env.CHANGED_FILES_FILE) return readFileSync(env.CHANGED_FILES_FILE, "utf8").split("\n").filter(Boolean);
  const event = env.EVENT_NAME ?? "push";
  const from = event === "pull_request" ? env.BASE_SHA : event === "push" ? env.BEFORE_SHA : undefined;
  if (event !== "push" && event !== "pull_request") return null;
  if (!from || ZERO.test(from) || !env.HEAD_SHA) return null;
  try {
    const out = execFileSync("git", ["diff", "--name-only", from, env.HEAD_SHA], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return out.split("\n").filter(Boolean);
  } catch {
    return null;
  }
};

const main = (env) => {
  const event = env.EVENT_NAME ?? "push";
  // A manual run is never filtered, even when a file list is supplied.
  const files = event === "push" || event === "pull_request" ? changedFiles(env) : null;
  const result = compute(files);
  console.log(files === null ? "No usable file list (manual run, new branch, force push or a failed diff): every area runs." : `${files.length} changed file(s).`);
  for (const [area, on] of Object.entries(result)) console.log(`${on ? "run " : "skip"}  ${outputName(area)}`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, Object.entries(result).map(([area, on]) => `${outputName(area)}=${on}\n`).join(""));
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.env);
