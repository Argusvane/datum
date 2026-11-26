import { compareVersions, normalizeVersion } from "./versioning.js";

/**
 * Normalized version range. A deliberate subset of npm semver:
 * exact, `^`, `~`, comparators (`>= > <= <`), `x` wildcards, and `*`.
 */
export interface VersionRange {
  exact?: string;
  min?: string;
  minExclusive?: boolean;
  max?: string;
  maxInclusive?: boolean;
}

function padVersion(version: string): string {
  const parts = normalizeVersion(version);
  while (parts.length < 3) {
    parts.push(0);
  }
  return parts.slice(0, 3).join(".");
}

function nextMajor(version: string): string {
  const [major = 0] = normalizeVersion(version);
  return `${major + 1}.0.0`;
}

function nextMinor(version: string): string {
  const [major = 0, minor = 0] = normalizeVersion(version);
  return `${major}.${minor + 1}.0`;
}

function nextPatch(version: string): string {
  const [major = 0, minor = 0, patch = 0] = normalizeVersion(version);
  return `${major}.${minor}.${patch + 1}`;
}

function caretUpperBound(version: string): string {
  const [major = 0, minor = 0] = normalizeVersion(version);
  if (major > 0) {
    return nextMajor(version);
  }
  if (minor > 0) {
    return nextMinor(version);
  }
  return nextPatch(version);
}

export function parseVersionRange(spec: string): VersionRange {
  const trimmed = spec.trim();
  if (trimmed === "" || trimmed === "*" || trimmed === "x") {
    return {};
  }

  if (trimmed.startsWith("^")) {
    const base = padVersion(trimmed.slice(1));
    return { min: base, max: caretUpperBound(base), maxInclusive: false };
  }

  if (trimmed.startsWith("~")) {
    const raw = trimmed.slice(1);
    const base = padVersion(raw);
    const segments = raw.split(".").length;
    // ~1.2.3 and ~1.2 -> < next minor;  ~1 -> < next major
    const max = segments >= 2 ? nextMinor(base) : nextMajor(base);
    return { min: base, max, maxInclusive: false };
  }

  if (trimmed.startsWith(">=")) {
    return { min: padVersion(trimmed.slice(2)) };
  }
  if (trimmed.startsWith(">")) {
    return { min: padVersion(trimmed.slice(1)), minExclusive: true };
  }
  if (trimmed.startsWith("<=")) {
    return { max: padVersion(trimmed.slice(2)), maxInclusive: true };
  }
  if (trimmed.startsWith("<")) {
    return { max: padVersion(trimmed.slice(1)), maxInclusive: false };
  }

  // Wildcards: 1.x / 1.2.x / 1.* / 1.2.*
  const wildcardMatch = trimmed.match(/^(\d+)(?:\.(\d+))?\.(?:x|\*)$/i);
  if (wildcardMatch) {
    const major = Number(wildcardMatch[1]);
    const minor = wildcardMatch[2] === undefined ? undefined : Number(wildcardMatch[2]);
    if (minor === undefined) {
      return { min: `${major}.0.0`, max: `${major + 1}.0.0`, maxInclusive: false };
    }
    return { min: `${major}.${minor}.0`, max: `${major}.${minor + 1}.0`, maxInclusive: false };
  }

  return { exact: padVersion(trimmed) };
}

export function satisfies(version: string, spec: string | VersionRange): boolean {
  const range = typeof spec === "string" ? parseVersionRange(spec) : spec;
  const target = padVersion(version);

  if (range.exact !== undefined) {
    return compareVersions(target, range.exact) === 0;
  }
  if (range.min !== undefined) {
    const cmp = compareVersions(target, range.min);
    if (range.minExclusive ? cmp <= 0 : cmp < 0) {
      return false;
    }
  }
  if (range.max !== undefined) {
    const cmp = compareVersions(target, range.max);
    if (range.maxInclusive ? cmp > 0 : cmp >= 0) {
      return false;
    }
  }
  return true;
}

/** Highest version from `versions` that satisfies `spec`, or undefined. */
export function maxSatisfying(versions: string[], spec: string | VersionRange): string | undefined {
  return [...versions]
    .filter((version) => satisfies(version, spec))
    .sort((a, b) => compareVersions(a, b))
    .pop();
}
