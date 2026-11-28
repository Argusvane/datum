#!/usr/bin/env node
// Lives in integrations/shared because it writes more than one host's pin: quickjs-ng's qjs-wasi.wasm,
// pinned by the sha256 digest GitHub publishes for the release asset. Only the official repository is
// read (quickjs-ng/quickjs). Review the diff before committing.
//
// Both server hosts run the same module, so both pins are written by default: --target all. --target jvm or
// --target fastapi writes one, for a host built on its own; the hosts' script tests fail while the two disagree
// (readPins and pinDifferences below are what they compare).
//
//   npm run jvm:pin-runtime -- v0.16.2             (the one positional tag is quickjs-ng's; writes both pins)
//   node integrations/shared/scripts/pin-runtime.mjs --target jvm v0.16.2
//
// The JVM hosts (integrations/jvm) take the qjs.* properties between the `datum:qjs begin` and `datum:qjs end`
// comments of integrations/jvm/libs/datum-sandbox-endive/pom.xml. The Python host takes
// integrations/fastapi/packages/argusvane-datum-qjs-wasm/src/datum_qjs_wasm/runtime.json (url, sha256, size), which
// integrations/fastapi/scripts/fetch-runtime.mjs verifies the downloaded qjs-wasi.wasm against.
//
// --dry-run reads the release and prints what would be written, writing nothing (the check mode the
// closing proof uses; it still needs the network).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const FASTAPI_PIN = join(here, "..", "..", "fastapi", "packages", "argusvane-datum-qjs-wasm", "src", "datum_qjs_wasm", "runtime.json");
export const JVM_POM = join(here, "..", "..", "jvm", "libs", "datum-sandbox-endive", "pom.xml");

const BEGIN = "<!-- datum:qjs begin";
const END = "<!-- datum:qjs end -->";

/** The command line: `{ target, tag, dryRun }`; the target is `all` unless one is named. Throws on a target that is not one. */
export function parseArgs(args) {
  let target = "all";
  const positional = [];
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--target") {
      target = args[(index += 1)] ?? "";
    } else if (arg.startsWith("--target=")) {
      target = arg.slice("--target=".length);
    } else {
      positional.push(arg);
    }
  }
  if (!["jvm", "fastapi", "all"].includes(target)) {
    throw new Error(`pin-runtime: --target must be jvm, fastapi or all (got "${target}")`);
  }
  // Every target takes the quickjs tag alone.
  return { target, tag: positional[0] ?? "v0.16.2", dryRun };
}

/** The Python host's pin, `{ version, sha256, size }`, from runtime.json. */
export function readFastapiPin(path = FASTAPI_PIN) {
  const pin = JSON.parse(readFileSync(path, "utf8"));
  return { version: pin.qjsVersion, sha256: pin.sha256, size: pin.size };
}

/** The JVM host's pin, `{ version, sha256, size }`, from the qjs.* properties between the pom's datum:qjs markers. */
export function readJvmPin(path = JVM_POM) {
  const pom = readFileSync(path, "utf8");
  const from = pom.indexOf(BEGIN);
  const to = pom.indexOf(END);
  if (from < 0 || to < from) {
    throw new Error(`${path}: the datum:qjs begin/end marker comments are missing`);
  }
  const block = pom.slice(from, to);
  const property = (name) => new RegExp(`<qjs\\.${name}>([^<]*)</qjs\\.${name}>`).exec(block)?.[1]?.trim();
  const size = property("size");
  return { version: property("version"), sha256: property("sha256"), size: size === undefined ? undefined : Number(size) };
}

/** Both pins, by host. */
export function readPins({ fastapi = FASTAPI_PIN, jvm = JVM_POM } = {}) {
  return { fastapi: readFastapiPin(fastapi), jvm: readJvmPin(jvm) };
}

/** One line per field the two pins hold differently (version, sha256, size); empty when they name the same module. */
export function pinDifferences(pins) {
  const problems = [];
  for (const field of ["version", "sha256", "size"]) {
    const fastapi = pins.fastapi[field];
    const jvm = pins.jvm[field];
    const missing = (value) => value === undefined || value === null || value === "" || Number.isNaN(value);
    if (missing(fastapi) || missing(jvm)) {
      problems.push(`${field}: runtime.json has ${JSON.stringify(fastapi ?? null)}, the datum-sandbox-endive pom has ${JSON.stringify(jvm ?? null)}; both must name it`);
    } else if (fastapi !== jvm) {
      problems.push(`${field}: runtime.json has ${fastapi}, the datum-sandbox-endive pom has ${jvm}`);
    }
  }
  return problems;
}

async function release(repo, tag) {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "datum-pin-runtime" }
  });
  if (!response.ok) {
    throw new Error(`${repo} ${tag}: HTTP ${response.status}`);
  }
  return response.json();
}

function sha256Of(asset) {
  const digest = asset.digest ?? "";
  if (!digest.startsWith("sha256:")) {
    throw new Error(`${asset.name}: the release publishes no sha256 digest`);
  }
  return digest.slice("sha256:".length);
}

async function main(args) {
  const { target, tag: qjsTag, dryRun } = parseArgs(args);
  const qjs = await release("quickjs-ng/quickjs", qjsTag);
  const qjsAsset = qjs.assets.find((candidate) => candidate.name === "qjs-wasi.wasm");
  if (!qjsAsset) {
    throw new Error(`${qjsTag}: no qjs-wasi.wasm asset`);
  }

  if (target === "jvm" || target === "all") {
    const pom = readFileSync(JVM_POM, "utf8");
    const from = pom.indexOf(BEGIN);
    const to = pom.indexOf(END);
    if (from < 0 || to < from) {
      throw new Error(`${JVM_POM}: the datum:qjs begin/end marker comments are missing`);
    }
    const beginLineEnd = pom.indexOf("\n", from);
    const block = [
      `    <qjs.version>${qjsTag.replace(/^v/, "")}</qjs.version>`,
      `    <qjs.sha256>${sha256Of(qjsAsset)}</qjs.sha256>`,
      `    <qjs.size>${qjsAsset.size}</qjs.size>`
    ].join("\n");
    if (!dryRun) {
      writeFileSync(JVM_POM, `${pom.slice(0, beginLineEnd + 1)}${block}\n    ${pom.slice(to)}`);
    }
    console.log(`pin-runtime: qjs ${qjsTag} → ${JVM_POM}${dryRun ? " (dry run, nothing written)" : ""}`);
  }

  if (target === "fastapi" || target === "all") {
    const pin = {
      "//": "Generated by integrations/shared/scripts/pin-runtime.mjs from the quickjs-ng release; do not edit by hand.",
      qjsVersion: qjsTag.replace(/^v/, ""),
      asset: qjsAsset.name,
      url: qjsAsset.browser_download_url,
      sha256: sha256Of(qjsAsset),
      size: qjsAsset.size
    };
    if (!dryRun) {
      mkdirSync(dirname(FASTAPI_PIN), { recursive: true });
      writeFileSync(FASTAPI_PIN, `${JSON.stringify(pin, null, 2)}\n`);
    }
    console.log(`pin-runtime: qjs ${qjsTag} → ${FASTAPI_PIN}${dryRun ? " (dry run, nothing written)" : ""}`);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
