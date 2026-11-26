import { describe, expect, it } from "vitest";
import { faFileArrowDown, faFileCirclePlus, faFolderOpen, faRotateLeft } from "@fortawesome/free-solid-svg-icons";
import { BUILTIN_ICONS, DATUM_ICON_NAMES, ICON_FALLBACK_CLASS, renderIcon } from "@argusvane/datum-engine";

import { FONT_AWESOME_GLYPHS, FONT_AWESOME_ICONS, FONT_AWESOME_ICONS_ID, fontAwesomeGlyph } from "../src/index.js";

describe("Font Awesome icon set", () => {
  it("is named, and draws every name in the engine's vocabulary itself", () => {
    expect(FONT_AWESOME_ICONS.id).toBe(FONT_AWESOME_ICONS_ID);
    expect(FONT_AWESOME_ICONS.css).toBeUndefined();
    for (const name of DATUM_ICON_NAMES) {
      expect(FONT_AWESOME_GLYPHS[name], name).toBeDefined();
      const html = renderIcon(FONT_AWESOME_ICONS, name, { size: 16, className: "x" });
      expect(html, name).toContain('<svg class="x" viewBox="0 0 ');
      expect(html, name).toContain('<path fill="currentColor" d="');
      expect(html, name).not.toContain(ICON_FALLBACK_CLASS);
      expect(html, name).not.toBe(renderIcon(BUILTIN_ICONS, name, { size: 16, className: "x" }));
    }
  });

  it("draws the bar's file actions with the file and folder glyphs", () => {
    expect(FONT_AWESOME_GLYPHS["new-form"]).toBe(faFileCirclePlus);
    expect(FONT_AWESOME_GLYPHS["open-form"]).toBe(faFolderOpen);
    expect(FONT_AWESOME_GLYPHS["download-form"]).toBe(faFileArrowDown);
  });

  it("adapts a definition to the engine's glyph shape: its own viewBox, its paths on currentColor", () => {
    const [width, height, , , path] = faRotateLeft.icon;
    const glyph = fontAwesomeGlyph(faRotateLeft);
    expect(glyph.viewBox).toBe(`0 0 ${width} ${height}`);
    expect(glyph.body).toBe(`<path fill="currentColor" d="${path}"/>`);
    expect(glyph.attrs).toBeUndefined();
    // A multi-path (duotone-style) definition keeps every path.
    const twoPaths = { ...faRotateLeft, icon: [10, 10, [], "", ["M0 0", "M1 1"]] } as typeof faRotateLeft;
    expect(fontAwesomeGlyph(twoPaths).body).toBe('<path fill="currentColor" d="M0 0"/><path fill="currentColor" d="M1 1"/>');
  });

  it("draws at the size and with the class asked for, decoratively", () => {
    const html = FONT_AWESOME_ICONS.icon("undo", { size: 12, className: "palette-icon" });
    expect(html).toContain('class="palette-icon"');
    expect(html).toContain('width="12" height="12" aria-hidden="true" focusable="false"');
  });
});
