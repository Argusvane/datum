/**
 * The phone tier's menu drawer: what it lists, drawn from a model
 * the shell fills in. Pure, so the rows can be read and tested apart from the shell. The host's
 * own bar controls are not here: the shell moves their slots into the drawer's last section.
 */
import { escapeHtml } from "../../render/core/escape-html.js";
import { BuilderWords } from "../logic/builder-texts.js";

/** One row: a button that runs `go` (see the shell's onMenuGo), or a switch. */
export interface PhoneMenuRow {
  /** What the shell runs: "workspace:logic", "document:<id>", "try", "search", ... */
  go: string;
  label: string;
  /** An SVG path (24px box, stroked) for the row's glyph. */
  icon?: string | undefined;
  /** Marks the row the one in use (the current workspace, the open document). */
  current?: boolean | undefined;
  /** A danger count after the label, its number also in the row's name. */
  count?: number | undefined;
  /** A keyboard shortcut, shown at the row's end. */
  shortcut?: string | undefined;
  /** A word at the row's end ("EN · FR", "Default"). */
  chip?: string | undefined;
  /** A switch: the row is role="switch" with this state. */
  checked?: boolean | undefined;
  disabled?: boolean | undefined;
  danger?: boolean | undefined;
  /** Extra attributes for rows that reuse the shell's own handlers (data-document-action). */
  attributes?: Readonly<Record<string, string>> | undefined;
}

export interface PhoneMenuSection {
  id: string;
  heading: string;
  rows: PhoneMenuRow[];
}

/** Glyphs for the menu's rows: 24px stroked paths, drawn in the row's ink. */
export const PHONE_MENU_ICONS = {
  form: "M4 5h16v5H4zM4 14h7v5H4zM15 14h5v5h-5z",
  logic: "M6 3v6a3 3 0 003 3h6a3 3 0 013 3v6M6 21v-2M18 3v2",
  data: "M4 6h16v12H4zM4 11h16M9 6v12",
  languages: "M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18",
  journeys: "M4 6h5v5H4zM15 13h5v5h-5zM9 8.5h6M12 11v4.5M12 15.5h3",
  pdf: "M6 2h8l5 5v15H6zM14 2v5h5",
  print: "M7 8V3h10v5M7 17H4v-7h16v7h-3M7 14h10v7H7z",
  document: "M6 2h8l5 5v15H6zM14 2v5h5M9 13h6M9 17h6",
  overview: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  try: "M3 12s3.5-7 9-7 9 7 9 7-3.5 7-9 7-9-7-9-7zM12 12m-3 0a3 3 0 106 0 3 3 0 10-6 0",
  hidden: "M3 3l18 18M10.6 10.6a2 2 0 102.8 2.8M9.9 5.1A9.8 9.8 0 0112 5c5.5 0 9 7 9 7a16 16 0 01-3.2 4.1M6.6 6.6C4.3 8.4 3 12 3 12s3.5 7 9 7c1.2 0 2.3-.3 3.3-.7",
  zoomIn: "M11 11m-7 0a7 7 0 1014 0 7 7 0 10-14 0M20 20l-4-4M11 8v6M8 11h6",
  zoomOut: "M11 11m-7 0a7 7 0 1014 0 7 7 0 10-14 0M20 20l-4-4M8 11h6",
  fit: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  settings: "M4 6h16M4 12h16M4 18h16M9 4v4M15 10v4M10 16v4",
  save: "M12 3v12M7 10l5 5 5-5M4 17v3h16v-3",
  new: "M6 2h8l5 5v15H6zM12 10v8M8 14h8",
  open: "M3 7h6l2 2h10v11H3z",
  download: "M12 4v12M7 11l5 5 5-5M4 20h16",
  search: "M11 11m-6.5 0a6.5 6.5 0 1013 0 6.5 6.5 0 10-13 0M20 20l-4.2-4.2",
  // A moon: the shell's Dark mode switch.
  darkMode: "M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z",
  // A sun: the same row while dark is on, naming Light mode.
  lightMode: "M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6L4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 16.5a4.5 4.5 0 100-9 4.5 4.5 0 000 9z",
  fullWindow: "M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7",
  leaveFullWindow: "M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7",
  rename: "M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z",
  duplicate: "M9 9h11v11H9zM5 15H4V4h11v1",
  up: "M12 19V5M6 11l6-6 6 6",
  down: "M12 5v14M6 13l6 6 6-6",
  star: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z",
  delete: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"
} as const;

function iconHtml(path: string | undefined): string {
  return path
    ? `<span class="menu-row-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="${path}"></path></svg></span>`
    : "";
}

function problemsText(count: number, words: BuilderWords): string {
  return words.plural("problems.count", count);
}

/** One row of the drawer. */
export function phoneMenuRowHtml(row: PhoneMenuRow, words: BuilderWords = new BuilderWords()): string {
  const attributes = Object.entries(row.attributes ?? {})
    .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
    .join("");
  const count = row.count !== undefined && row.count > 0 ? row.count : 0;
  const name = count > 0 ? words.text("phoneMenu.row", { label: row.label, problems: problemsText(count, words) }) : undefined;
  const isSwitch = row.checked !== undefined;
  const trail = [
    count > 0 ? `<span class="menu-count" aria-hidden="true">${count}</span>` : "",
    row.chip ? `<span class="menu-row-chip">${escapeHtml(row.chip)}</span>` : "",
    row.shortcut ? `<kbd class="menu-row-key">${escapeHtml(row.shortcut)}</kbd>` : "",
    isSwitch ? `<span class="menu-switch" aria-hidden="true"></span>` : ""
  ].join("");
  return `<button type="button" class="menu-row${row.danger ? " menu-row--danger" : ""}" data-menu-go="${escapeHtml(row.go)}"${
    isSwitch ? ` role="switch" aria-checked="${row.checked ? "true" : "false"}"` : ""
  }${row.current ? ' aria-current="true"' : ""}${name ? ` aria-label="${escapeHtml(name)}"` : ""}${row.disabled ? " disabled" : ""}${attributes}>${iconHtml(row.icon)}<span class="menu-row-label">${escapeHtml(
    row.label
  )}</span>${trail}</button>`;
}

/** The drawer's sections, each a heading and its rows; a section with no rows is left out. */
export function phoneMenuSectionsHtml(sections: readonly PhoneMenuSection[], words: BuilderWords = new BuilderWords()): string {
  return sections
    .filter((section) => section.rows.length > 0)
    .map(
      (section) =>
        `<section class="menu-section" aria-labelledby="menu-heading-${escapeHtml(section.id)}" data-menu-section="${escapeHtml(section.id)}">
          <h2 class="menu-heading" id="menu-heading-${escapeHtml(section.id)}">${escapeHtml(section.heading)}</h2>
          ${section.rows.map((row) => phoneMenuRowHtml(row, words)).join("")}
        </section>`
    )
    .join("");
}

/** The Menu button's accessible name: what it opens, the workspace on the page and its problems. */
export function phoneMenuButtonName(workspaceLabel: string, count: number, words: BuilderWords = new BuilderWords()): string {
  return count > 0
    ? words.text("phoneMenu.button", { workspace: workspaceLabel, problems: problemsText(count, words) })
    : words.text("phoneMenu.button.plain", { workspace: workspaceLabel });
}
