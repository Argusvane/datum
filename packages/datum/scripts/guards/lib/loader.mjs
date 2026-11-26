// The plug-in loader behind check-bundles.mjs. A feature adds its bundle guards and budgets
// as scripts/guards/<name>.mjs instead of editing the one big script.
// Kept in lib/ so the *.mjs glob over scripts/guards/ never mistakes it for a guard.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The shared-module chunk of an entry's own load set (Vite 8 / Rolldown):
 * `datum-form-core-<hash>.js` and `datum-builder-core-<hash>.js`, which the entry imports
 * statically on load (vite.config.ts, scripts/build-bundles.mjs). It is part of the entry's
 * initial payload, never a lazy chunk, so `chunksOf` leaves it out and the entry checks read it
 * with the entry.
 */
export const CORE_CHUNK = /^datum-(form|builder)-core-[A-Za-z0-9_-]{8}\.js$/;

/** The two entries whose initial payload is the entry file plus its core chunk. */
const PAIRED_ENTRIES = { "datum-form.js": "datum-form", "datum-builder.js": "datum-builder" };

/**
 * The readers the checks share for the entry-plus-core pair. `entryText(name)` is the text of the
 * entry and its core chunk for datum-form.js and datum-builder.js (any other name: that file's
 * text); `entryKb(name)` the size of the pair in KB, the number comparable with every historic
 * measurement (Rollup kept the shared modules in the entry itself); `sourcesOf(name)` the module
 * paths a file's source map lists (for an entry, the pair's), without the leading `../`;
 * `coreOf(bundle)` the core chunk files of a bundle.
 */
export function bundleReaders({ dist, files, read, expect }) {
  const coreOf = (bundle) => files.filter((name) => CORE_CHUNK.test(name) && name.startsWith(`${bundle}-`));
  const parts = (name) => (name in PAIRED_ENTRIES ? [name, ...coreOf(PAIRED_ENTRIES[name])] : [name]);
  const entryText = (name) => parts(name).map((part) => read(part)).join("\n");
  const entryKb = (name) => parts(name).reduce((total, part) => total + statSync(join(dist, part)).size / 1024, 0);
  const sourcesOf = (name) =>
    parts(name).flatMap((part) => {
      const present = existsSync(join(dist, `${part}.map`));
      // A default build removes the maps once the checks have run (scripts/strip-source-maps.mjs),
      // so check-bundles on a finished dist needs a build that kept them.
      expect(present, `${part}.map is missing; the bundle checks read the source maps, which only a build with DATUM_SOURCE_MAPS=1 leaves in dist (a default build removes them after the checks)`);
      return present ? JSON.parse(readFileSync(join(dist, `${part}.map`), "utf8")).sources.map((source) => source.replace(/^(\.\.\/)+/, "")) : [];
    });
  return { coreOf, entryText, entryKb, sourcesOf };
}

/** Every `<dir>/*.mjs`, sorted by name, imported; a missing or empty dir is fine. */
export async function loadGuards(dir) {
  if (!existsSync(dir)) {
    return [];
  }
  const names = readdirSync(dir).filter((name) => name.endsWith(".mjs")).sort();
  const guards = [];
  for (const name of names) {
    const module = await import(/* @vite-ignore */ pathToFileURL(join(dir, name)).href);
    guards.push({ name, run: typeof module.default === "function" ? module.default : undefined, budgets: module.budgets ?? {} });
  }
  return guards;
}

/**
 * The budgets in force: for each name the minimum of the base number and every guard's
 * override. A guard that raises a budget above the base is a reported problem (the base
 * number stays); a guard may add a budget for a name the base lacks.
 */
export function effectiveBudgets(base, guards, problems) {
  const result = { ...base };
  for (const guard of guards) {
    for (const [name, budget] of Object.entries(guard.budgets)) {
      if (name in base && budget > base[name]) {
        problems.push(`guards/${guard.name} raises the ${name} budget to ${budget} KB above its base ${base[name]} KB; a guard may only lower a budget`);
        continue;
      }
      result[name] = Math.min(result[name] ?? budget, budget);
    }
  }
  return result;
}

/** Runs each guard with the context; one that throws or lacks a default function is a problem, not a crash. */
export async function runGuards(guards, ctx, problems) {
  for (const guard of guards) {
    if (!guard.run) {
      problems.push(`guards/${guard.name} has no default-exported function`);
      continue;
    }
    try {
      await guard.run(ctx);
    } catch (error) {
      problems.push(`guards/${guard.name} threw: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
