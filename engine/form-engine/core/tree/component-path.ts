import type { ComponentPath, PathSegment } from "../schema/types.js";

const SEGMENT_REGEX = /^([a-zA-Z0-9_-]+)(?:\[(\d+)\])?$/;

/**
 * The first segment alone may start with `@`: the answers of the fields a
 * presentation owns live under `@<presentation id>.<field id>`, a prefix no form component's
 * id or data key can spell, so such a key never collides with a form value. Anywhere else
 * `@` stays outside the grammar.
 */
const FIRST_SEGMENT_REGEX = /^(@?[a-zA-Z0-9_-]+)(?:\[(\d+)\])?$/;

export function createComponentPath(segments: PathSegment[]): ComponentPath {
  return { segments: [...segments] };
}

export function parseComponentPath(path: string): ComponentPath {
  if (!path.trim()) {
    return { segments: [] };
  }

  // The parser intentionally supports only dot notation plus numeric indexes.
  // Restricting syntax keeps path identity stable across environments.
  const parts = path.split(".");
  const segments = parts.map<PathSegment>((part, position) => {
    const match = (position === 0 ? FIRST_SEGMENT_REGEX : SEGMENT_REGEX).exec(part);
    if (!match) {
      throw new Error(`Invalid path segment: ${part}`);
    }

    const key = match[1];
    if (key === undefined) {
      throw new Error(`Invalid path segment: ${part}`);
    }

    const indexRaw = match[2];
    const segment: PathSegment = { key };
    if (indexRaw !== undefined) {
      segment.index = Number(indexRaw);
    }
    return segment;
  });

  return { segments };
}

export function stringifyComponentPath(path: ComponentPath): string {
  return path.segments
    .map((segment) =>
      segment.index === undefined ? segment.key : `${segment.key}[${segment.index}]`
    )
    .join(".");
}

export function appendSegment(path: ComponentPath, segment: PathSegment): ComponentPath {
  return { segments: [...path.segments, segment] };
}

export function equalsPath(a: ComponentPath, b: ComponentPath): boolean {
  if (a.segments.length !== b.segments.length) {
    return false;
  }

  for (let i = 0; i < a.segments.length; i += 1) {
    const as = a.segments[i];
    const bs = b.segments[i];
    if (!as || !bs || as.key !== bs.key || as.index !== bs.index) {
      return false;
    }
  }

  return true;
}
