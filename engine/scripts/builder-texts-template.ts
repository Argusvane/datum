// Writes every English builder key (the core table and each area's) as one JSON template a
// translator fills in:
//
//   npm run builder-texts:template -- [locale] [outfile]
//
// The locale defaults to "xx"; without an outfile the JSON goes to stdout. Runs under vite-node,
// the repo's way to run TypeScript sources from a script.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { BUILDER_TEXTS_EN as CORE_EN } from "../form-engine/builder/logic/builder-texts.js";
import { JOURNEY_EN } from "../form-engine/builder/journey-designer/journey-texts-en.js";
import { JOURNEY_MAP_EN } from "../form-engine/builder/journey-map/journey-map-texts-en.js";
import { JOURNEY_PREVIEW_EN } from "../form-engine/builder/journey-designer/journey-preview-texts-en.js";
import { JOURNEY_AUTHORING_EN } from "../form-engine/builder/journey-designer/journey-authoring-texts-en.js";
import { DATA_EN } from "../form-engine/builder/data/data-texts-en.js";
import { LANGUAGES_EN } from "../form-engine/builder/languages/languages-texts-en.js";
import { LOGIC_EN } from "../form-engine/builder/logic/logic-texts-en.js";
import { OVERVIEW_EN } from "../form-engine/builder/overview/overview-texts-en.js";
import { PALETTE_EN } from "../form-engine/builder/palette/palette-texts-en.js";
import { FORMULA_EN } from "../form-engine/builder/formula/formula-texts-en.js";
import { TRY_EN } from "../form-engine/builder/web-component/try-texts-en.js";
import { PDF_EN } from "../form-engine/builder/pdf-designer/pdf-texts-en.js";
import { MOVE_EN } from "../form-engine/builder/drag-drop/move-texts-en.js";
import { AGENT_EN } from "../form-engine/agent/builder/agent-texts-en.js";

export const ALL_BUILDER_TABLES: readonly Record<string, string>[] = [
  CORE_EN, JOURNEY_EN, JOURNEY_MAP_EN, JOURNEY_PREVIEW_EN, JOURNEY_AUTHORING_EN, DATA_EN,
  LANGUAGES_EN, LOGIC_EN, OVERVIEW_EN, PALETTE_EN, FORMULA_EN, TRY_EN, PDF_EN, MOVE_EN, AGENT_EN
];

/** `{ [locale]: { key: English } }` over the union of all tables, keys sorted. */
export function builderTextsTemplate(locale = "xx"): Record<string, Record<string, string>> {
  const merged: Record<string, string> = Object.assign({}, ...ALL_BUILDER_TABLES);
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(merged).sort()) {
    sorted[key] = merged[key] as string;
  }
  return { [locale]: sorted };
}

if (process.argv[1] !== undefined && /vite-node$/.test(process.argv[1])) {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const json = `${JSON.stringify(builderTextsTemplate(args[0] ?? "xx"), null, 2)}\n`;
  if (args[1] !== undefined) {
    writeFileSync(resolve(args[1]), json);
  } else {
    process.stdout.write(json);
  }
}
