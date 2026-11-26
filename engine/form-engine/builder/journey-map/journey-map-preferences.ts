/**
 * How a viewer likes the journey flow map drawn: down or right. It is a viewer's
 * preference, never the definition's: kept only where the host remembers the builder's panels
 * (`persist-panels`), under a key of its own beside theirs,
 * `datum-builder:journey-map:<key>`, in the same store (`panelMemoryStore`: the page's
 * `localStorage`, else a store for this page load). The zoom and the view on the canvas are not
 * remembered.
 *
 * Static and small: the Journeys mode, in the builder's bundle, reads and writes it before the
 * map's chunk has loaded; the map's model re-exports what it shares from here. Nothing runs at
 * import.
 */
import { panelMemoryStore, type PanelMemoryStore } from "../web-component/panel-memory.js";
import type { FlowDirection } from "./journey-map-layout.js";

/** How the map is drawn: down or right. Remembered per viewer. */
export interface JourneyMapLayout {
  direction: FlowDirection;
}

export const JOURNEY_MAP_PREFERENCES_PREFIX = "datum-builder:journey-map:";
export const JOURNEY_MAP_PREFERENCES_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The layout a stored or given value asks for, anything unknown read as the default (down). */
export function normalizeJourneyMapLayout(value: unknown): JourneyMapLayout {
  const record = isRecord(value) ? value : {};
  return { direction: record.direction === "right" ? "right" : "down" };
}

/**
 * The layout remembered under `key`, or nothing: no record, another version, or a record whose
 * direction is not one the map draws counts as none — a stale or hand-edited entry is never
 * read as one. A record written while the map had an arrangement too keeps its direction.
 */
export function readJourneyMapLayout(key: string, store: PanelMemoryStore = panelMemoryStore()): JourneyMapLayout | undefined {
  let raw: string | null;
  try {
    raw = store.getItem(`${JOURNEY_MAP_PREFERENCES_PREFIX}${key}`);
  } catch {
    return undefined;
  }
  if (!raw) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.version !== JOURNEY_MAP_PREFERENCES_VERSION) {
    return undefined;
  }
  const { direction } = parsed;
  if (direction !== "down" && direction !== "right") {
    return undefined;
  }
  return { direction };
}

/** Remembers `layout` under `key`; a store that refuses (full, blocked) keeps nothing, silently. */
export function writeJourneyMapLayout(key: string, layout: JourneyMapLayout, store: PanelMemoryStore = panelMemoryStore()): void {
  const { direction } = normalizeJourneyMapLayout(layout);
  try {
    store.setItem(`${JOURNEY_MAP_PREFERENCES_PREFIX}${key}`, JSON.stringify({ version: JOURNEY_MAP_PREFERENCES_VERSION, direction }));
  } catch {
    // Nothing to remember into: the layout lives on the mode for this page load.
  }
}
