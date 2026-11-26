import { describe, expect, it } from "vitest";

import { DATUM_DARK_TOKENS, DATUM_TOKENS } from "../form-engine/render/live/datum/default-tokens.js";
import { formTokenFallback } from "../form-engine/render/live/datum/tokens.js";

/*
 * WCAG contrast over the Datum look's tokens (the light set and the dark set over it): every
 * text-on-fill and boundary-on-fill pair the Datum stylesheet draws from tokens, resolved as the
 * browser would on the form root (the set's value, its `var()` chain, then the manifest's
 * fallback), against the 2.2 AA floors: 4.5:1 for text (1.4.3), 3:1 for a boundary (1.4.11).
 * What it cannot see is a host's own css restating a colour over a part.
 */

interface Pair {
  id: string;
  foreground: string;
  background: string;
  floor: number;
}

const TEXT = 4.5;
const BOUNDARY = 3;
const text = (id: string, foreground: string, background: string): Pair => ({ id, foreground, background, floor: TEXT });
const boundary = (id: string, foreground: string, background: string): Pair => ({ id, foreground, background, floor: BOUNDARY });

const PAIRS: readonly Pair[] = [
  text("text-on-surface", "color-text", "color-surface"),
  text("text-on-frame", "color-text", "color-frame-surface"),
  text("text-on-panel", "color-text", "color-panel"),
  text("text-on-panel-header", "color-text", "color-panel-header"),
  text("text-on-input", "color-text", "color-input-bg"),
  text("text-on-light", "color-text", "color-light"),
  text("muted-on-surface", "color-muted", "color-surface"),
  text("muted-on-panel", "color-muted", "color-panel"),
  text("muted-on-light", "color-muted", "color-light"),
  text("muted-on-disabled", "color-muted", "color-disabled-bg"),
  text("accent-on-surface", "color-accent", "color-surface"),
  text("accent-on-panel", "color-accent", "color-panel"),
  text("error-on-surface", "color-error", "color-surface"),
  text("error-on-panel", "color-error", "color-panel"),
  text("error-on-error-bg", "color-error", "color-error-bg"),
  text("text-on-warning-bg", "color-text", "color-warning-bg"),
  text("on-accent-on-accent", "color-on-accent", "color-accent"),
  text("on-accent-on-secondary", "color-on-secondary", "color-secondary-bg"),
  text("on-accent-on-success", "color-on-accent", "color-success"),
  text("on-accent-on-danger", "color-on-accent", "color-danger"),
  text("on-accent-on-info", "color-on-accent", "color-info"),
  text("dark-on-warning", "color-on-warning", "color-warning"),
  text("on-dark-on-dark", "color-on-dark", "color-dark"),
  boundary("input-border-on-input", "color-input-border", "color-input-bg"),
  boundary("input-border-on-surface", "color-input-border", "color-surface"),
  boundary("focus-ring-on-surface", "focus-ring-color", "color-surface"),
  boundary("accent-on-surface-boundary", "color-accent", "color-surface"),
  boundary("error-line-on-input", "color-error", "color-input-bg")
];

/** The token as the browser would read it: the set's value, else the manifest's fallback, a var() chain followed. */
function literal(tokens: Readonly<Record<string, string>>, name: string, seen = new Set<string>()): string | undefined {
  if (seen.has(name)) {
    return undefined;
  }
  seen.add(name);
  const raw = tokens[name] ?? formTokenFallback(name);
  return raw === undefined ? undefined : follow(tokens, raw.trim(), seen);
}

function follow(tokens: Readonly<Record<string, string>>, value: string, seen: Set<string>): string | undefined {
  const match = /^var\(\s*--([a-z0-9-]+)\s*(?:,([\s\S]*))?\)$/i.exec(value);
  if (!match) {
    return value;
  }
  const name = match[1] as string;
  if (name in tokens) {
    const resolved = literal(tokens, name, new Set(seen));
    if (resolved !== undefined) {
      return resolved;
    }
  }
  const fallback = match[2]?.trim();
  return fallback ? follow(tokens, fallback, seen) : undefined;
}

function channels(value: string): [number, number, number, number] | undefined {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(value.trim());
  if (value.trim() === "transparent") {
    return [0, 0, 0, 0];
  }
  if (!hex) {
    return undefined;
  }
  const digits = hex[1] as string;
  const full = digits.length <= 4 ? digits.split("").map((d) => d + d).join("") : digits;
  if (full.length !== 6 && full.length !== 8) {
    return undefined;
  }
  const part = (index: number): number => parseInt(full.slice(index * 2, index * 2 + 2), 16);
  return [part(0), part(1), part(2), full.length === 8 ? part(3) / 255 : 1];
}

/** A token as opaque channels: a translucent or transparent colour sits on `ground` (the page, white). */
function colour(tokens: Readonly<Record<string, string>>, name: string, ground: [number, number, number]): [number, number, number] | undefined {
  const parsed = channels(literal(tokens, name) ?? "");
  if (!parsed) {
    return undefined;
  }
  const [r, g, b, a] = parsed;
  return [Math.round(r * a + ground[0] * (1 - a)), Math.round(g * a + ground[1] * (1 - a)), Math.round(b * a + ground[2] * (1 - a))];
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function ratio(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The pairs that cannot be measured or fall short of their floor, by id. */
function findings(tokens: Readonly<Record<string, string>>): string[] {
  const page: [number, number, number] = [255, 255, 255];
  const surface = colour(tokens, "color-surface", page) ?? page;
  return PAIRS.flatMap((pair) => {
    const background = pair.background === "color-surface" ? surface : colour(tokens, pair.background, surface);
    const foreground = background ? colour(tokens, pair.foreground, background) : undefined;
    if (!background || !foreground) {
      return [`${pair.id}: unresolved`];
    }
    return ratio(foreground, background) >= pair.floor ? [] : [pair.id];
  });
}

describe("the Datum look's token contrast", () => {
  it("clears every pair the stylesheet draws, in the light set", () => {
    expect(findings({ ...DATUM_TOKENS })).toEqual([]);
  });

  it("clears every pair in the dark set but the affix's muted ink on the light well, which the dark css repairs", () => {
    const dark = { ...DATUM_TOKENS, ...DATUM_DARK_TOKENS };
    expect(findings(dark)).toEqual(["muted-on-light"]);
    const light = colour(dark, "color-light", [255, 255, 255]) as [number, number, number];
    const ink = colour(dark, "color-text", light) as [number, number, number];
    expect(ratio(ink, light)).toBeGreaterThanOrEqual(TEXT);
  });
});
