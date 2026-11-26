/**
 * What the builder shell remembers about its panels between sessions: the strip's
 * open panel, the two column widths and whether the inspector is folded. Kept under
 * `localStorage` when the page allows it, in memory otherwise, one record per `persist-panels`
 * key so two builders on one origin can remember different layouts.
 */

/** The side column's width, clamped to what still reads as a panel. */
export const SIDE_MIN = 160;
/*
 * Wide enough for the widest panel the column holds — the tables of the Data and Logic
 * panels, which run to some 800px once a few columns are shown. A panel
 * an author cannot open far enough to read is a panel they will go back to a dialog for.
 */
export const SIDE_MAX = 900;
/*
 * A panel that opens the drawer wider than the shell's 240px default, by id: the Tests panel's
 * rows are sentences ("Previous file number is shown when Have you received this grant before?
 * is Yes") that fold five deep in the default column and read in two or three at this width.
 * A width the author dragged (`sideWidth`, an inline style on the wrap) still wins over it.
 */
/*
 * The Form fields panel (a journey's Step view) lists labels with a step's name beside each, so it
 * opens a little wider than the default.
 */
export const PANEL_DRAWER_WIDTHS: Readonly<Record<string, number>> = { tests: 360, fields: 300 };

export const PROPS_MIN = 200;
export const PROPS_MAX = 560;

export const PANEL_MEMORY_VERSION = 1;
export const PANEL_MEMORY_PREFIX = "datum-builder:panels:";

/**
 * The shell's panels a record can name, in the strip's order. The one list: the type and the
 * check on what is read both come from it, so a panel added here is remembered and read back.
 */
export const REMEMBERED_PANEL_IDS = ["form", "chrome", "components", "fields", "outline", "variables", "tests", "view", "settings"] as const;

export type RememberedPanel = (typeof REMEMBERED_PANEL_IDS)[number];

function isRememberedPanel(value: unknown): value is RememberedPanel {
  return (REMEMBERED_PANEL_IDS as readonly unknown[]).includes(value);
}

export interface PanelMemory {
  /** The strip's open panel; `null` while the side column is put away. */
  panel: RememberedPanel | null;
  /** The side column's width in px, once the author has dragged its resizer. */
  sideWidth?: number;
  /** The inspector's width in px, once the author has dragged its resizer. */
  propsWidth?: number;
  /** Whether the inspector is folded to its stub. */
  propsCollapsed: boolean;
  /**
   * The workspace the author was in. Optional, so a record without one reads as the
   * Form workspace; Journeys and PDF are never put back (their modes may not be
   * registered yet), and a record naming Build reads as Form.
   */
  workspace?: RememberedWorkspace;
}

/** The workspaces `persist-panels` puts back. */
export type RememberedWorkspace = "form" | "logic" | "data" | "languages" | "print";

export interface PanelMemoryStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

let cachedStore: PanelMemoryStore | undefined;

/**
 * The store the shell remembers into: the page's `localStorage` when a probe write succeeds
 * (a private window, a blocked origin or Node's stand-in under vitest all fail it), else a
 * store for this page load alone — the shell then still keeps a layout across re-connects.
 */
export function panelMemoryStore(): PanelMemoryStore {
  if (cachedStore) {
    return cachedStore;
  }
  try {
    const probe = `${PANEL_MEMORY_PREFIX}__probe__`;
    const storage = (globalThis as { localStorage?: PanelMemoryStore }).localStorage;
    if (!storage) {
      throw new Error("no localStorage");
    }
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    cachedStore = storage;
  } catch {
    const memory = new Map<string, string>();
    cachedStore = {
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => {
        memory.set(key, value);
      },
      removeItem: (key) => {
        memory.delete(key);
      }
    };
  }
  return cachedStore;
}

export function panelMemoryKey(key: string): string {
  return `${PANEL_MEMORY_PREFIX}${key}`;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));

function widthOf(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(clamp(value, min, max)) : undefined;
}

/**
 * The record under `key`, or nothing when there is none, it was written by another version,
 * or it does not parse as a record — a stale or hand-edited entry is treated as absent, never
 * as a layout.
 */
export function readPanelMemory(key: string, store: PanelMemoryStore = panelMemoryStore()): PanelMemory | undefined {
  let raw: string | null;
  try {
    raw = store.getItem(panelMemoryKey(key));
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
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (record.v !== PANEL_MEMORY_VERSION) {
    return undefined;
  }
  const panel = record.panel;
  if (panel !== null && !isRememberedPanel(panel)) {
    return undefined;
  }
  const memory: PanelMemory = {
    panel,
    propsCollapsed: record.propsCollapsed === true
  };
  const sideWidth = widthOf(record.sideWidth, SIDE_MIN, SIDE_MAX);
  if (sideWidth !== undefined) {
    memory.sideWidth = sideWidth;
  }
  const propsWidth = widthOf(record.propsWidth, PROPS_MIN, PROPS_MAX);
  if (propsWidth !== undefined) {
    memory.propsWidth = propsWidth;
  }
  const workspace = record.workspace;
  if (workspace === "form" || workspace === "logic" || workspace === "data" || workspace === "languages" || workspace === "print") {
    memory.workspace = workspace;
  }
  return memory;
}

/** Writes the record under `key`; a store that refuses (quota, a read-only origin) is not an error the shell surfaces. */
export function writePanelMemory(key: string, memory: PanelMemory, store: PanelMemoryStore = panelMemoryStore()): void {
  const record: Record<string, unknown> = {
    v: PANEL_MEMORY_VERSION,
    panel: memory.panel,
    propsCollapsed: memory.propsCollapsed
  };
  const sideWidth = widthOf(memory.sideWidth, SIDE_MIN, SIDE_MAX);
  if (sideWidth !== undefined) {
    record.sideWidth = sideWidth;
  }
  const propsWidth = widthOf(memory.propsWidth, PROPS_MIN, PROPS_MAX);
  if (propsWidth !== undefined) {
    record.propsWidth = propsWidth;
  }
  if (memory.workspace !== undefined) {
    record.workspace = memory.workspace;
  }
  try {
    store.setItem(panelMemoryKey(key), JSON.stringify(record));
  } catch {
    // Nothing to do: the layout is simply not remembered this time.
  }
}

export function clearPanelMemory(key: string, store: PanelMemoryStore = panelMemoryStore()): void {
  try {
    store.removeItem(panelMemoryKey(key));
  } catch {
    // As above.
  }
}

/**
 * The builder's colour scheme as the author last chose it from the ⋮ menu: one record
 * per origin, since a person's preference for a dark builder is theirs rather than a page's.
 * A `scheme` attribute on the element still wins over it (a host that decides for the page).
 */
export const SCHEME_MEMORY_KEY = "datum-builder:scheme";

export type BuilderScheme = "light" | "dark";

export function readSchemeMemory(store: PanelMemoryStore = panelMemoryStore()): BuilderScheme | undefined {
  try {
    const raw = store.getItem(SCHEME_MEMORY_KEY);
    return raw === "dark" || raw === "light" ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function writeSchemeMemory(scheme: BuilderScheme | undefined, store: PanelMemoryStore = panelMemoryStore()): void {
  try {
    if (scheme === undefined) {
      store.removeItem(SCHEME_MEMORY_KEY);
    } else {
      store.setItem(SCHEME_MEMORY_KEY, scheme);
    }
  } catch {
    // A store that refuses the write keeps the choice for this page load only.
  }
}
