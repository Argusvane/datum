import { afterEach, describe, expect, it } from "vitest";

import { DATUM_ICON_NAMES, isDatumIconName } from "../form-engine/render/icons/icon-names.js";
import {
  BUILTIN_ICONS,
  DEFAULT_ICON_SET_SLOT,
  DEFAULT_ICON_SIZE,
  ICON_FALLBACK_CLASS,
  defaultIconSet,
  markupIconSet,
  renderIcon,
  setDefaultIconSet,
  svgIconSet,
  type IconSet
} from "../form-engine/render/icons/icon-set.js";

afterEach(() => {
  setDefaultIconSet(undefined);
});

describe("icon sets", () => {
  it("names every glyph the chrome draws, and knows a name from a stranger", () => {
    expect(DATUM_ICON_NAMES.length).toBeGreaterThan(50);
    expect(new Set(DATUM_ICON_NAMES).size).toBe(DATUM_ICON_NAMES.length);
    expect(isDatumIconName("undo")).toBe(true);
    expect(isDatumIconName("field-date")).toBe(true);
    expect(isDatumIconName("fa-undo")).toBe(false);
    expect(isDatumIconName(42)).toBe(false);
  });

  it("draws every name from the built-in set, as a decorative stroke svg on currentColor", () => {
    for (const name of DATUM_ICON_NAMES) {
      const html = BUILTIN_ICONS.icon(name, { size: 16 });
      expect(html, name).toBeDefined();
      expect(html, name).toContain('<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"');
      expect(html, name).toContain('stroke="currentColor"');
      expect(html, name).toMatch(/<(path|circle|rect)/);
    }
    // Each chrome control has a drawing of its own; the palette kinds share one per kind.
    expect(BUILTIN_ICONS.icon("undo", { size: 16 })).not.toBe(BUILTIN_ICONS.icon("redo", { size: 16 }));
    expect(BUILTIN_ICONS.icon("field-text", { size: 16 })).toBe(BUILTIN_ICONS.icon("field-date", { size: 16 }));
    expect(BUILTIN_ICONS.icon("field-text", { size: 16 })).not.toBe(BUILTIN_ICONS.icon("container-grid", { size: 16 }));
  });

  it("names the bar's file actions as chrome, each with a drawing of its own", () => {
    const fileActions = ["new-form", "open-form", "download-form"] as const;
    const drawings = new Set<string | undefined>();
    for (const name of fileActions) {
      expect(isDatumIconName(name), name).toBe(true);
      drawings.add(BUILTIN_ICONS.icon(name, { size: 16 }));
    }
    expect(drawings.size).toBe(fileActions.length);
    // Chrome, not palette: none of them falls back on a palette kind's shared drawing.
    for (const kind of ["field-text", "action-button", "container-grid", "content-heading", "component"] as const) {
      expect(drawings.has(BUILTIN_ICONS.icon(kind, { size: 16 })), kind).toBe(false);
    }
    // They sit with the builder shell's chrome names, ahead of the form host's action row.
    expect(DATUM_ICON_NAMES.indexOf("download-form")).toBeLessThan(DATUM_ICON_NAMES.indexOf("validate"));
  });

  it("wraps svg glyph data with the size and class asked for, escaping the class", () => {
    const set = svgIconSet("acme", {
      undo: { viewBox: "0 0 10 10", body: '<path d="M1 1h8"/>' },
      redo: { viewBox: "0 0 10 10", body: '<path d="M9 9H1"/>', attrs: 'fill="none"' }
    });
    expect(set.id).toBe("acme");
    expect(set.icon("undo", { size: 20, className: 'a"b' })).toBe(
      '<svg class="a&quot;b" viewBox="0 0 10 10" width="20" height="20" aria-hidden="true" focusable="false"><path d="M1 1h8"/></svg>'
    );
    // A glyph's own attrs win over the set's; the set's apply where the glyph names none.
    const styled = svgIconSet("styled", {
      undo: { viewBox: "0 0 10 10", body: "" },
      redo: { viewBox: "0 0 10 10", body: "", attrs: 'stroke="red"' }
    }, { attrs: 'stroke="blue"' });
    expect(styled.icon("undo", { size: 8 })).toContain(' stroke="blue">');
    expect(styled.icon("redo", { size: 8 })).toContain(' stroke="red">');
    expect(styled.icon("redo", { size: 8 })).not.toContain("blue");
    // Names the set does not draw are not its to answer.
    expect(set.icon("print", { size: 16 })).toBeUndefined();
    expect(set.css).toBeUndefined();
  });

  it("passes markup renderers through, with the set's css alongside", () => {
    const set = markupIconSet(
      "sprite",
      { print: ({ size }) => `<svg width="${size}"><use href="#print"/></svg>` },
      ".ic { fill: currentColor; }"
    );
    expect(set.icon("print", { size: 12 })).toBe('<svg width="12"><use href="#print"/></svg>');
    expect(set.icon("undo", { size: 12 })).toBeUndefined();
    expect(set.css).toBe(".ic { fill: currentColor; }");
  });

  it("renders from the given set, falling back per name to the engine's drawing, marked as such", () => {
    const partial = svgIconSet("partial", { undo: { viewBox: "0 0 1 1", body: "<!--own-->" } });
    expect(renderIcon(partial, "undo", { className: "x" })).toContain("<!--own-->");
    expect(renderIcon(partial, "undo", { className: "x" })).not.toContain(ICON_FALLBACK_CLASS);

    const fallback = renderIcon(partial, "redo", { className: "x", size: 9 });
    expect(fallback).toContain(`class="x ${ICON_FALLBACK_CLASS}"`);
    expect(fallback).toContain('width="9"');
    expect(fallback).toContain('stroke="currentColor"');
    // Without a class of its own the marker stands alone; the default size is the chrome's.
    const bare = renderIcon(partial, "redo");
    expect(bare).toContain(`class="${ICON_FALLBACK_CLASS}"`);
    expect(bare).toContain(`width="${DEFAULT_ICON_SIZE}"`);
  });

  it("draws with the registered default when no set is given, and with the built-ins, marked, when none is registered", () => {
    expect(defaultIconSet()).toBe(BUILTIN_ICONS);
    // The engine's own drawing is marked whether it stands in for a set or is all there is.
    expect(renderIcon(undefined, "validate")).toBe(
      BUILTIN_ICONS.icon("validate", { size: DEFAULT_ICON_SIZE, className: ICON_FALLBACK_CLASS })
    );

    const registered: IconSet = svgIconSet("host", { validate: { viewBox: "0 0 1 1", body: "<!--host-->" } });
    setDefaultIconSet(registered);
    expect(defaultIconSet()).toBe(registered);
    expect(renderIcon(undefined, "validate")).toContain("<!--host-->");
    expect(renderIcon(undefined, "validate")).not.toContain(ICON_FALLBACK_CLASS);
    // A set given outright still wins over the default; the built-in one given outright is still marked.
    expect(renderIcon(BUILTIN_ICONS, "validate")).not.toContain("<!--host-->");
    expect(renderIcon(BUILTIN_ICONS, "validate")).toContain(ICON_FALLBACK_CLASS);

    setDefaultIconSet(undefined);
    expect(defaultIconSet()).toBe(BUILTIN_ICONS);
  });

  it("keeps the registered default on the page, not in the module, so another copy of the engine sees it", () => {
    // The icons bundle (datum-icons-fontawesome.js) registers through its own copy of this
    // module; the builder bundle reads through another. The slot is the one thing they share.
    const slot = globalThis as unknown as Record<symbol, unknown>;
    const registered: IconSet = svgIconSet("shared", {});
    setDefaultIconSet(registered);
    expect(DEFAULT_ICON_SET_SLOT).toBe(Symbol.for("datum.icons.default"));
    expect(slot[DEFAULT_ICON_SET_SLOT]).toBe(registered);

    const other: IconSet = svgIconSet("other-bundle", {});
    slot[DEFAULT_ICON_SET_SLOT] = other;
    expect(defaultIconSet()).toBe(other);
    expect(renderIcon(undefined, "validate")).toContain(ICON_FALLBACK_CLASS);

    setDefaultIconSet(undefined);
    expect(slot[DEFAULT_ICON_SET_SLOT]).toBeUndefined();
    expect(defaultIconSet()).toBe(BUILTIN_ICONS);
  });
});
