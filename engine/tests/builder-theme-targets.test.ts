import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every host that prints the studio token defaults on itself needs the builder theme set on it
 * too: an inherited --db-* cannot beat a value declared on the host's own
 * :host, so a surface left out of themeTargets() in default-builder-element.ts keeps the light
 * look while the rest of the builder is dark (five surfaces did, before this test). The test
 * reads source text: a module that calls builderTokens() or studioTokenDeclarations() must be in
 * the table below, and the field the table names for it must be in themeTargets().
 */

const BUILDER_DIR = fileURLToPath(new URL("../form-engine/builder/", import.meta.url));
const SHELL = "web-component/default-builder-element.ts";

/** Each module that prints the tokens, and the shell fields whose elements it draws (themeTargets() reads them). */
const MODULE_FIELDS: Record<string, string[]> = {
  [SHELL]: ["this"],
  "web-component/builder-panels.ts": ["toolbarEl", "canvasEl", "propertiesEl", "formSettingsEl"],
  "web-component/builder-outline.ts": ["outlineEl"],
  "web-component/builder-form-fields-panel.ts": ["fieldsEl"],
  "web-component/builder-chrome-panel.ts": ["chromePanelHost"],
  "web-component/builder-variables-panel.ts": ["variablesPanelHost"],
  "web-component/builder-tests-panel.ts": ["testsPanelHost"],
  "logic/logic-surface.ts": ["logicEl"],
  "data/data-surface.ts": ["dataEl"],
  "languages/languages-surface.ts": ["languagesEl"],
  "print/print-surface.ts": ["printEl"],
  "overview/overview-surface.ts": ["overviewEl"],
  "palette/command-palette.ts": ["paletteEl"]
};

/**
 * Modules that mention the functions without being a themed host: the two that define them.
 */
const NOT_HOSTS = ["web-component/builder-shared.ts", "web-component/studio-tokens.ts"];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return sources(path);
    }
    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("the hosts that print the builder's token defaults", () => {
  const printing = sources(BUILDER_DIR)
    .filter((path) => /\b(builderTokens|studioTokenDeclarations)\(\)/.test(readFileSync(path, "utf8")))
    .map((path) => relative(BUILDER_DIR, path))
    .filter((path) => !NOT_HOSTS.includes(path))
    .sort();

  it("are exactly the modules the table names, so a new themed host cannot be forgotten", () => {
    expect(printing).toEqual(Object.keys(MODULE_FIELDS).sort());
  });

  it("are each reached by themeTargets() in the shell", () => {
    const shell = readFileSync(join(BUILDER_DIR, SHELL), "utf8");
    const start = shell.indexOf("private themeTargets()");
    expect(start).toBeGreaterThan(-1);
    const body = shell.slice(start, shell.indexOf("\n  }\n", start));
    for (const [module, fields] of Object.entries(MODULE_FIELDS)) {
      for (const field of fields) {
        expect(body, `${module} -> ${field}`).toMatch(field === "this" ? /\bthis,/ : new RegExp(`this\\.${field}\\b`));
      }
    }
  });

  it("have every lazy host painted where it is created, not only on the next theme change", () => {
    const shell = readFileSync(join(BUILDER_DIR, SHELL), "utf8");
    // A surface or the palette made after the theme was applied has no vars until paintThemeVars runs.
    for (const field of ["paletteEl"]) {
      expect(shell, field).toMatch(new RegExp(`paintThemeVars\\(this\\.${field}\\)`));
    }
    expect(shell.match(/this\.paintThemeVars\(element\)/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });
});
