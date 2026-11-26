/**
 * The fonts a document draws with: the host's resources embedded (subset, deterministically
 * named), the default pack's sans-serif face for a named family no resource covers, and the
 * standard 14 only when the host supplied no default pack. A `FontSet` is
 * built once per document and answers "the font for this family, weight and style".
 *
 * Standard fonts encode WinAnsi only. Text they cannot encode is replaced with `?` and
 * reported once per document (`font.unencodable`), so a missing font degrades the page rather
 * than failing the document — and so the host learns it must supply one.
 *
 * Under PDF/A the set is `strict`: every font must be embedded, so a family with
 * no resource fails the document (`font`) instead of falling back, and a character an
 * embedded font lacks is replaced with `?` rather than drawn as `.notdef` — a glyph with no
 * Unicode mapping, which the "u" levels forbid.
 */
import { PDFDocument, PDFFont, StandardFonts } from "@cantoo/pdf-lib";
import * as fontkit from "fontkit";
import type { PdfFontResource, PdfWarning } from "@argusvane/datum-engine/render";
import { PdfKernelError, base64ToBytes } from "@argusvane/datum-engine/render";

export interface LoadedFont {
  font: PDFFont;
  family: string;
  /** The CSS weight asked for (the nearest face the resources offer was taken). */
  weight: number;
  italic: boolean;
  /** A standard-14 font: WinAnsi only. */
  standard: boolean;
}

const GENERIC_FAMILIES: Record<string, "sans" | "serif" | "mono"> = {
  "sans-serif": "sans",
  sans: "sans",
  serif: "serif",
  monospace: "mono",
  mono: "mono"
};

function standardFor(kind: "sans" | "serif" | "mono", bold: boolean, italic: boolean): StandardFonts {
  if (kind === "serif") {
    return bold && italic ? StandardFonts.TimesRomanBoldItalic : bold ? StandardFonts.TimesRomanBold : italic ? StandardFonts.TimesRomanItalic : StandardFonts.TimesRoman;
  }
  if (kind === "mono") {
    return bold && italic ? StandardFonts.CourierBoldOblique : bold ? StandardFonts.CourierBold : italic ? StandardFonts.CourierOblique : StandardFonts.Courier;
  }
  return bold && italic ? StandardFonts.HelveticaBoldOblique : bold ? StandardFonts.HelveticaBold : italic ? StandardFonts.HelveticaOblique : StandardFonts.Helvetica;
}

/** WinAnsi's repertoire, as pdf-lib's standard fonts can encode it. */
function winAnsiEncodable(code: number): boolean {
  if (code < 0x80) {
    return code >= 0x20 || code === 0x0a || code === 0x0d || code === 0x09;
  }
  if (code >= 0xa0 && code <= 0xff) {
    return true;
  }
  return [0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178].includes(code);
}

export interface FontSetOptions {
  /** PDF/A: no standard-14 fallback, no `.notdef` in text. */
  strict?: boolean;
  /**
   * PDF/A level "a": a Private Use Area character is replaced too, even when the font has a
   * glyph for it — the level asks that every glyph carry text a reader can use, which a PUA
   * code point does not.
   */
  noPrivateUse?: boolean;
}

/** Whether a code point is in a Unicode Private Use Area (the BMP block, or planes 15 and 16). */
export function isPrivateUse(code: number): boolean {
  return (code >= 0xe000 && code <= 0xf8ff) || (code >= 0xf0000 && code <= 0x10ffff);
}

export class FontSet {
  private readonly loaded = new Map<string, LoadedFont>();
  private readonly resourcesByFamily = new Map<string, PdfFontResource[]>();
  private readonly warnings: PdfWarning[] = [];
  private readonly reported = new Set<string>();
  private embedCounter = 0;
  private fontkitRegistered = false;
  public readonly strict: boolean;
  private readonly noPrivateUse: boolean;

  constructor(
    private readonly document: PDFDocument,
    resources: readonly PdfFontResource[],
    private readonly fallbacks: Record<string, string> = {},
    options: FontSetOptions = {}
  ) {
    this.strict = options.strict === true;
    this.noPrivateUse = this.strict && options.noPrivateUse === true;
    for (const resource of resources) {
      const key = resource.family.toLowerCase();
      const list = this.resourcesByFamily.get(key) ?? [];
      list.push(resource);
      this.resourcesByFamily.set(key, list);
    }
  }

  public takeWarnings(): PdfWarning[] {
    return this.warnings.splice(0);
  }

  /** The family a script falls back to when the main family has no resource for it. */
  public fallbackFamily(script: string): string | undefined {
    return this.fallbacks[script];
  }

  public hasResource(family: string): boolean {
    return this.resourcesByFamily.has(family.toLowerCase());
  }

  /** The face for a family at a CSS weight (400 regular, 700 bold): the nearest weight the resources offer, a standard font's bold from 600 up. */
  public async get(family: string, weight = 400, italic = false): Promise<LoadedFont> {
    const key = `${family.toLowerCase()}|${weight}|${italic ? "i" : ""}`;
    const cached = this.loaded.get(key);
    if (cached) {
      return cached;
    }
    const bold = weight >= 600;
    const kind = GENERIC_FAMILIES[family.toLowerCase()];
    // A named family no resource covers is drawn in the default pack's sans-serif face (the
    // host's DejaVu), embedded, rather than in a standard font: a theme whose own face failed to
    // load still prints in a face that covers the text, under PDF/A too.
    const own = this.pickResource(family, weight, italic);
    const substitute = own === undefined && kind === undefined ? this.pickResource("sans-serif", weight, italic) : undefined;
    const resource = own ?? substitute;
    let loaded: LoadedFont;
    if (resource) {
      if (substitute) {
        this.warnOnce(`fallback:${family}`, "font.fallback_default", `No font resource for family "${family}"; the default sans-serif face was used.`);
      }
      loaded = { font: await this.embedResource(resource), family, weight, italic, standard: false };
    } else if (this.strict) {
      throw new PdfKernelError("font", `PDF/A needs every font embedded, and no font resource covers the family "${family}"; supply one.`);
    } else {
      if (kind === undefined) {
        this.warnOnce(`fallback:${family}`, "font.fallback_standard14", `No font resource for family "${family}" and no default font was supplied; Helvetica was used.`);
      }
      const font = await this.document.embedFont(standardFor(kind ?? "sans", bold, italic));
      loaded = { font, family, weight, italic, standard: true };
    }
    this.loaded.set(key, loaded);
    return loaded;
  }

  private async embedResource(resource: PdfFontResource): Promise<PDFFont> {
    if (!this.fontkitRegistered) {
      this.document.registerFontkit(fontkit as unknown as Parameters<PDFDocument["registerFontkit"]>[0]);
      this.fontkitRegistered = true;
    }
    this.embedCounter += 1;
    return this.document.embedFont(base64ToBytes(resource.data), {
      subset: true,
      // A fixed name: pdf-lib would otherwise append a random suffix, and the sandbox has no randomness.
      customName: `DatumFont${this.embedCounter}`
    });
  }

  private pickResource(family: string, wantWeight: number, italic: boolean): PdfFontResource | undefined {
    const candidates = this.resourcesByFamily.get(family.toLowerCase());
    if (!candidates || candidates.length === 0) {
      return undefined;
    }
    const wantStyle = italic ? "italic" : "normal";
    const scored = candidates
      .map((resource) => {
        const weight = resource.weight ?? 400;
        const style = resource.style ?? "normal";
        return { resource, score: Math.abs(weight - wantWeight) + (style === wantStyle ? 0 : 1000) };
      })
      .sort((a, b) => a.score - b.score);
    return scored[0]!.resource;
  }

  /** Whether a font has a glyph for a character: WinAnsi for a standard font, the font's cmap otherwise. */
  public covers(loaded: LoadedFont, char: string): boolean {
    const code = char.codePointAt(0);
    if (code === undefined) {
      return true;
    }
    if (loaded.standard) {
      return winAnsiEncodable(code);
    }
    const embedder = (loaded.font as unknown as { embedder?: { font?: { hasGlyphForCodePoint?(cp: number): boolean } } }).embedder;
    const has = embedder?.font?.hasGlyphForCodePoint;
    return typeof has === "function" ? has.call(embedder!.font, code) : true;
  }

  /**
   * Text a font can draw: for a standard font, characters outside WinAnsi become `?`, and the
   * document is told once. An embedded font draws what it has and pdf-lib substitutes the
   * rest with the font's notdef glyph — except under `strict`, where those too become `?`
   * (whitespace and line breaks aside: they are never drawn), so no glyph lacks a Unicode
   * mapping.
   */
  public encodable(text: string, loaded: LoadedFont): string {
    if (!loaded.standard && !this.strict) {
      // An embedded font draws a missing-glyph box for what it lacks; say so.
      for (const char of text) {
        if (!/\s/.test(char) && !this.covers(loaded, char)) {
          this.warnOnce("glyphMissing", "text.glyphMissing", "Some characters have no glyph in the font used and were drawn as missing-glyph boxes. Supply a font resource covering them.");
          break;
        }
      }
      return text;
    }
    const drawable = loaded.standard
      ? (char: string) => winAnsiEncodable(char.codePointAt(0)!)
      : (char: string) => /\s/.test(char) || this.covers(loaded, char);
    const privateUse = (char: string): boolean => !loaded.standard && this.noPrivateUse && isPrivateUse(char.codePointAt(0)!);
    // A font with no `?` of its own (rare) gets the character dropped rather than a notdef.
    const mark = loaded.standard || this.covers(loaded, "?") ? "?" : "";
    let out = "";
    let replaced = false;
    let privateUseReplaced = false;
    for (const char of text) {
      if (privateUse(char)) {
        out += mark;
        privateUseReplaced = true;
      } else if (drawable(char)) {
        out += char;
      } else {
        out += mark;
        replaced = true;
      }
    }
    if (privateUseReplaced) {
      this.warnOnce("privateUse", "font.privateUse", "Some characters are Private Use Area code points, which carry no text a reader can use; PDF/A level \"a\" replaces them with '?'.");
    }
    if (replaced) {
      this.warnOnce(
        "unencodable",
        "font.unencodable",
        loaded.standard
          ? "Some characters are outside the standard fonts' repertoire and were replaced with '?'. Supply a font resource covering them."
          : "Some characters have no glyph in the fonts supplied and were replaced with '?'; PDF/A draws no missing-glyph marks. Supply a font resource covering them."
      );
    }
    return out;
  }

  private warnOnce(key: string, code: string, message: string): void {
    if (this.reported.has(key)) {
      return;
    }
    this.reported.add(key);
    this.warnings.push({ code, message });
  }
}
