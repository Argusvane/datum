import { isSafeUrl } from "./static-html.js";

/** Component type of a picture shown from a URL. */
export const IMAGE_COMPONENT_TYPE = "image";

export interface ImageConfiguration {
  /** The picture's URL — `undefined` when none is authored, or the authored one is unsafe. */
  src: string | undefined;
  /** Rendered size in CSS pixels, when the author fixed one. */
  width: number | undefined;
  height: number | undefined;
}

function readDimension(configuration: Record<string, unknown>, key: "width" | "height"): number | undefined {
  const raw = configuration[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return undefined;
  }
  const size = Math.floor(raw);
  return size >= 1 ? size : undefined;
}

/**
 * An image's own configuration.
 *
 * The URL is held to the rule the `html` component's `<img src>` already is ({@link isSafeUrl}):
 * `http(s)`, relative and `data:image/*` pass; anything that would run rather than fetch does
 * not, and reads as no URL at all — so a definition that arrives from anywhere is covered
 * rather than trusted, on both surfaces. `alt` is a string, worded per locale by the render
 * model at `components › <id> › alt` with every other text.
 */
export function readImageConfiguration(configuration: unknown): ImageConfiguration {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    return { src: undefined, width: undefined, height: undefined };
  }
  const record = configuration as Record<string, unknown>;
  const raw = typeof record.src === "string" ? record.src.trim() : "";
  const src = raw.length > 0 && isSafeUrl(raw, "image") ? raw : undefined;
  return { src, width: readDimension(record, "width"), height: readDimension(record, "height") };
}
