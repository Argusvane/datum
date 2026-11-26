import type { Json } from "../observation.js";
import type { Fixture, Gen } from "../vectors/schema.js";
import { baseRoot } from "./base-form.js";

/** Replaces every `{ "$gen": ... }` in a JSON tree with what it describes. */
export function resolveGenerators(value: Json | Gen): Json {
  if (Array.isArray(value)) {
    return value.map((item) => resolveGenerators(item as Json));
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record["$gen"] === "string") {
      return runGenerator(value as Gen);
    }
    // Own keys only, copied one by one: a `__proto__` key stays an own property.
    const out: Record<string, Json> = {};
    for (const key of Object.keys(record)) {
      Object.defineProperty(out, key, { value: resolveGenerators(record[key] as Json), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return value;
}

function runGenerator(gen: Gen): Json {
  switch (gen.$gen) {
    case "unknownKeys": {
      const out: Record<string, Json> = {};
      for (let at = 0; at < gen.n; at += 1) {
        out[`${gen.prefix ?? "k"}${at}`] = at;
      }
      return out;
    }
    case "rows": {
      const row = resolveGenerators(gen.row);
      // A primitive row needs no copy (a million-entry list stays cheap).
      return Array.from({ length: gen.n }, () => (row !== null && typeof row === "object" ? structuredClone(row) : row));
    }
    case "text":
      return (gen.char ?? "x").repeat(gen.length);
    case "repeat": {
      const copies: string[] = [];
      for (let at = 0; at < gen.n; at += 1) {
        copies.push(gen.text.split("$n").join(String(at)));
      }
      return (gen.head ?? "") + copies.join("");
    }
    case "merge": {
      const out: Record<string, Json> = {};
      for (const part of gen.of) {
        const resolved = resolveGenerators(part as Json);
        if (resolved !== null && typeof resolved === "object" && !Array.isArray(resolved)) {
          for (const key of Object.keys(resolved)) {
            Object.defineProperty(out, key, { value: (resolved as Record<string, Json>)[key], enumerable: true, writable: true, configurable: true });
          }
        }
      }
      return out;
    }
  }
}

/** The form root a fixture describes. */
export function buildRoot(fixture: Pick<Fixture, "definition" | "patch">): Record<string, unknown> {
  if (fixture.definition === "base") {
    return baseRoot();
  }
  if (fixture.definition === "base+patch") {
    if (fixture.patch === undefined) {
      throw new Error('fixture.definition "base+patch" needs a patch');
    }
    return fixture.patch(baseRoot());
  }
  return fixture.definition(baseRoot());
}
