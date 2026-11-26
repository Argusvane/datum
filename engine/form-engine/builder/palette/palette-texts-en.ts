/**
 * The command palette's English (a lazy chunk), kept out of the eager table in `logic/builder-texts.ts` so the builder entry
 * carries none of it. Every key here is read only by code
 * in that chunk, through this module's `builderText` and its kin (or `areaWords`, the builder words reading this table): the lookup is the builder's
 * one (`builderText`), this table only supplies the English. `engine/tests/builder-texts.test.ts`
 * holds each key to exactly one table and each table to its own readers.
 */
import { areaText } from "../logic/builder-texts.js";

export const PALETTE_EN = {
  // The workspace surfaces
  "palette.label": "Commands",
  "palette.search.label": "Search commands",
  "palette.search.placeholder": "Search commands…",
  "palette.commands.one": "{count} command",
  "palette.commands.other": "{count} commands",
  "palette.none": "No commands match",
  "palette.none.line": "No commands match.",
  "palette.recent": "Recent",
  "palette.group.workspaces": "Workspace",
  "palette.group.add": "Add",
  "palette.group.goTo": "Go to",
  "palette.group.edit": "Edit",
  "palette.group.documents": "Documents",
  "palette.group.view": "View",
  "palette.group.host": "Page"
} as const;

export const { builderText, builderPlural, builderTemplateParts, formatListText, areaWords } = /* @__PURE__ */ areaText(PALETTE_EN);
