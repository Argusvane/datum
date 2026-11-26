/**
 * Text into lines: itemize runs by style, find break opportunities (UAX #14 through
 * `linebreak`), measure with the embedded font's metrics, fill lines greedily, and order each
 * line for its direction (UAX #9 through `bidi-js`). Output is what the writer draws: for each
 * line, the pieces in visual order with an x offset each.
 *
 * Shaping is fontkit's, reached through pdf-lib when the piece is drawn; fontkit reverses a
 * right-to-left script's glyph run itself, so a piece is always handed over in logical order.
 */
import bidiFactory from "bidi-js";
import { LineBreaker } from "linebreak";
import type { PdfTextRun } from "@argusvane/datum-engine/render";
import type { FontSet, LoadedFont } from "./fonts.js";

export interface TextStyle {
  family: string;
  size: number;
  lineHeight: number;
  color: string;
  bold?: boolean;
  /** CSS weight; wins over `bold`. */
  weight?: number;
  italic?: boolean;
  /** Applied to every run's text before shaping. */
  transform?: "none" | "uppercase";
}

/** The weight a run or style asks for: an explicit weight, else the bold flag, else regular. */
export function weightOf(style: { weight?: number | undefined; bold?: boolean | undefined }): number | undefined {
  return style.weight ?? (style.bold === undefined ? undefined : style.bold ? 700 : 400);
}

/** A run resolved to a font, ready to measure. */
interface ShapedRun {
  text: string;
  font: LoadedFont;
  size: number;
  color: string;
  token?: PdfTextRun["token"];
}

export interface LinePiece {
  text: string;
  font: LoadedFont;
  size: number;
  color: string;
  /** Offset from the line's start edge, in points. */
  x: number;
  width: number;
  token?: PdfTextRun["token"];
}

export interface TextLine {
  pieces: LinePiece[];
  width: number;
  height: number;
  /** Distance from the line's top to the baseline. */
  ascent: number;
}

const bidi = bidiFactory();

/** A page token's widest plausible rendering, so a line laid out before pagination still fits. */
const TOKEN_PLACEHOLDER = "999";

const WIDTH_CACHE_MAX_TEXT = 64;
const WIDTH_CACHE_MAX_ENTRIES = 20000;
const widthCache = new WeakMap<object, Map<string, number>>();

function widthOf(text: string, run: ShapedRun): number {
  if (text.length === 0) {
    return 0;
  }
  if (text.length > WIDTH_CACHE_MAX_TEXT) {
    return run.font.font.widthOfTextAtSize(text, run.size);
  }
  // Greedy line filling measures the same words again and again.
  let byKey = widthCache.get(run.font.font);
  if (!byKey) {
    byKey = new Map();
    widthCache.set(run.font.font, byKey);
  }
  const key = `${run.size}|${text}`;
  let width = byKey.get(key);
  if (width === undefined) {
    width = run.font.font.widthOfTextAtSize(text, run.size);
    if (byKey.size >= WIDTH_CACHE_MAX_ENTRIES) {
      byKey.clear();
    }
    byKey.set(key, width);
  }
  return width;
}

/** Unicode script of a character, for the writing systems a theme may name a fallback font for. */
const SCRIPT_RANGES: Array<[string, RegExp]> = [
  ["Arab", /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/u],
  ["Hebr", /[֐-׿יִ-ﭏ]/u],
  ["Cyrl", /[Ѐ-ӿԀ-ԯ]/u],
  ["Grek", /[Ͱ-Ͽἀ-῿]/u],
  ["Hani", /[一-鿿㐀-䶿]/u],
  ["Hira", /[぀-ゟ]/u],
  ["Kana", /[゠-ヿ]/u],
  ["Hang", /[가-힯ᄀ-ᇿ]/u],
  ["Deva", /[ऀ-ॿ]/u],
  ["Thai", /[฀-๿]/u],
  ["Cans", /[᐀-ᙿᢰ-᣿]/u]
];

function scriptOf(char: string): string | undefined {
  for (const [script, pattern] of SCRIPT_RANGES) {
    if (pattern.test(char)) {
      return script;
    }
  }
  return undefined;
}

interface ScriptSegment {
  text: string;
  script: string | undefined;
}

/**
 * Splits text into runs of one script. Characters with no script of their own (spaces,
 * digits, punctuation) stay with the segment they follow, so a sentence does not shatter
 * into pieces at every space.
 */
function segmentByScript(text: string): ScriptSegment[] {
  const segments: ScriptSegment[] = [];
  for (const char of text) {
    const script = scriptOf(char);
    const last = segments[segments.length - 1];
    if (last && (script === undefined || last.script === script || last.script === undefined)) {
      last.text += char;
      if (last.script === undefined && script !== undefined) {
        last.script = script;
      }
    } else {
      segments.push({ text: char, script });
    }
  }
  return segments;
}

/**
 * A segment split between the main font and its fallback: a character the main font has
 * stays with it, one it lacks goes to the fallback, and a character neither script claims
 * (a space, a digit) follows whatever came before it when that font has it, so words do
 * not shatter.
 */
function splitByCoverage(text: string, main: LoadedFont, fallback: LoadedFont, fonts: FontSet): Array<{ text: string; font: LoadedFont }> {
  const pieces: Array<{ text: string; font: LoadedFont }> = [];
  for (const char of text) {
    const last = pieces[pieces.length - 1];
    const neutral = scriptOf(char) === undefined && /[\s\d\p{P}]/u.test(char);
    const preferred = neutral && last ? last.font : main;
    const font = fonts.covers(preferred, char) ? preferred : fonts.covers(main, char) ? main : fallback;
    if (last && last.font === font) {
      last.text += char;
    } else {
      pieces.push({ text: char, font });
    }
  }
  return pieces;
}

export async function resolveRuns(
  runs: readonly PdfTextRun[],
  style: TextStyle,
  fonts: FontSet,
  tokens?: { pageNumber: number; pageCount: number }
): Promise<ShapedRun[]> {
  const out: ShapedRun[] = [];
  for (const run of runs) {
    const family = run.family ?? style.family;
    const weight = weightOf(run) ?? weightOf(style) ?? 400;
    const italic = run.italic ?? style.italic ?? false;
    const mainFont = await fonts.get(family, weight, italic);
    const transform = run.transform ?? style.transform ?? "none";
    const raw = run.token
      ? tokens
        ? String(run.token === "pageNumber" ? tokens.pageNumber : tokens.pageCount)
        : TOKEN_PLACEHOLDER
      : transform === "uppercase"
        ? run.text.toUpperCase()
        : run.text;
    // Direction controls typed into an answer are removed where the answer is formatted
    // (`stripAnswerBidi`, engine), not here: author text keeps its own isolates.
    const size = run.size ?? style.size;
    const color = run.color ?? style.color;
    const token = run.token && !tokens ? { token: run.token } : {};
    // A script the main font cannot draw goes to the theme's fallback family for that script,
    // when there is one; otherwise it is drawn with the main font as best it can.
    for (const segment of segmentByScript(raw)) {
      let fallbackFont: LoadedFont | undefined;
      if (segment.script !== undefined) {
        const probe = [...segment.text].find((char) => scriptOf(char) === segment.script) ?? segment.text;
        if (!fonts.covers(mainFont, probe)) {
          const fallback = fonts.fallbackFamily(segment.script);
          if (fallback && fallback.toLowerCase() !== family.toLowerCase()) {
            const candidate = await fonts.get(fallback, weight, italic);
            if (fonts.covers(candidate, probe)) {
              fallbackFont = candidate;
            }
          }
        }
      }
      // Only what the main font lacks moves to the fallback: the Latin around a syllabics word
      // (letters have no script range of their own, so they share the segment) stays where it was.
      for (const piece of fallbackFont ? splitByCoverage(segment.text, mainFont, fallbackFont, fonts) : [{ text: segment.text, font: mainFont }]) {
        const text = fonts.encodable(piece.text, piece.font);
        const previous = out[out.length - 1];
        if (previous && previous.font === piece.font && previous.size === size && previous.color === color && !previous.token && !run.token) {
          previous.text += text;
        } else {
          out.push({ text, font: piece.font, size, color, ...token });
        }
      }
    }
  }
  return out;
}

interface Atom {
  text: string;
  run: ShapedRun;
  width: number;
  /** Trailing whitespace the atom carries, dropped at a line end. */
  trailing: string;
  trailingWidth: number;
  required: boolean;
}

/** Splits the runs into unbreakable atoms at UAX #14 opportunities, keeping run boundaries. */
function atomize(runs: ShapedRun[]): Atom[] {
  const full = runs.map((run) => run.text).join("");
  const atoms: Atom[] = [];
  if (full.length === 0) {
    return atoms;
  }
  const breaker = new LineBreaker(full);
  let last = 0;
  let next = breaker.nextBreak();
  const boundaries: Array<{ position: number; required: boolean }> = [];
  while (next) {
    boundaries.push({ position: next.position, required: next.required });
    next = breaker.nextBreak();
  }
  if (boundaries.length === 0 || boundaries[boundaries.length - 1]!.position < full.length) {
    boundaries.push({ position: full.length, required: false });
  }
  // Map each boundary segment back onto the runs it spans.
  let runIndex = 0;
  let runOffset = 0;
  for (const boundary of boundaries) {
    let segmentStart = last;
    while (segmentStart < boundary.position) {
      const run = runs[runIndex]!;
      const runEnd = runOffset + run.text.length;
      const take = Math.min(boundary.position, runEnd) - segmentStart;
      const text = run.text.slice(segmentStart - runOffset, segmentStart - runOffset + take);
      const isLast = segmentStart + take >= boundary.position;
      const trailingMatch = isLast ? /\s+$/.exec(text) : null;
      const trailing = trailingMatch ? trailingMatch[0] : "";
      const body = trailing ? text.slice(0, text.length - trailing.length) : text;
      atoms.push({
        text: body,
        run,
        width: widthOf(body, run),
        trailing,
        trailingWidth: widthOf(trailing, run),
        required: isLast && boundary.required
      });
      segmentStart += take;
      if (segmentStart >= runEnd) {
        runIndex += 1;
        runOffset = runEnd;
      }
    }
    last = boundary.position;
  }
  return atoms;
}

/**
 * Splits an atom wider than the column at character boundaries (a combining mark stays with its
 * base), so an unbroken value never runs past the edge. Only the last
 * piece keeps the atom's trailing space and its required break.
 */
function breakAtom(atom: Atom, maxWidth: number): Atom[] {
  const chars = atom.text.match(/\P{M}\p{M}*/gu) ?? [atom.text];
  const pieces: string[] = [];
  let piece = "";
  let sum = 0;
  for (const char of chars) {
    const width = widthOf(char, atom.run);
    if (piece !== "" && sum + width > maxWidth) {
      pieces.push(piece);
      piece = "";
      sum = 0;
    }
    piece += char;
    sum += width;
  }
  pieces.push(piece);
  return pieces.map((text, index) => {
    const last = index === pieces.length - 1;
    return {
      text,
      run: atom.run,
      width: widthOf(text, atom.run),
      trailing: last ? atom.trailing : "",
      trailingWidth: last ? atom.trailingWidth : 0,
      required: last && atom.required
    };
  });
}

/** Lays the runs out into lines no wider than `maxWidth` (an atom wider than that is broken at character boundaries). */
export function layoutLines(runs: ShapedRun[], maxWidth: number, textDirection: "ltr" | "rtl", lineHeight: number): TextLine[] {
  const atoms = atomize(runs);
  const lines: TextLine[] = [];
  let current: Atom[] = [];
  let currentWidth = 0;
  const flush = (): void => {
    lines.push(composeLine(current, textDirection, lineHeight));
    current = [];
    currentWidth = 0;
  };
  const place = (atom: Atom): void => {
    const atomWidth = atom.width;
    if (current.length > 0 && currentWidth + atomWidth > maxWidth + 0.01) {
      flush();
    }
    current.push(atom);
    currentWidth += atomWidth + atom.trailingWidth;
    if (atom.required) {
      flush();
    }
  };
  for (const atom of atoms) {
    if (atom.width > maxWidth + 0.01 && maxWidth > 0) {
      if (current.length > 0) {
        flush();
      }
      const pieces = breakAtom(atom, maxWidth);
      pieces.slice(0, -1).forEach((piece) => {
        current.push(piece);
        flush();
      });
      place(pieces[pieces.length - 1]!);
    } else {
      place(atom);
    }
  }
  if (current.length > 0 || lines.length === 0) {
    flush();
  }
  return lines;
}

function lineMetrics(atoms: Atom[], lineHeight: number): { height: number; ascent: number } {
  let size = 0;
  let ascentRatio = 0.8;
  for (const atom of atoms) {
    if (atom.run.size > size) {
      size = atom.run.size;
      const font = atom.run.font.font;
      const ascent = font.heightAtSize(atom.run.size, { descender: false });
      ascentRatio = ascent / atom.run.size;
    }
  }
  if (size === 0) {
    size = 10;
  }
  const height = size * lineHeight;
  return { height, ascent: Math.min(height, size * ascentRatio + (height - size) / 2) };
}

/** One line's atoms into visually ordered pieces. */
function composeLine(atoms: Atom[], textDirection: "ltr" | "rtl", lineHeight: number): TextLine {
  const metrics = lineMetrics(atoms, lineHeight);
  // Trailing whitespace of the last atom is not drawn; inner whitespace is kept with its atom.
  const pieces: Array<{ text: string; run: ShapedRun; width: number }> = [];
  atoms.forEach((atom, index) => {
    const last = index === atoms.length - 1;
    const text = last ? atom.text : atom.text + atom.trailing;
    if (text.length === 0) {
      return;
    }
    pieces.push({ text, run: atom.run, width: last ? atom.width : atom.width + atom.trailingWidth });
  });
  // Merge adjacent pieces of the same run before bidi, so a run is a single span where it can be.
  const merged: typeof pieces = [];
  for (const piece of pieces) {
    const previous = merged[merged.length - 1];
    if (previous && previous.run === piece.run) {
      previous.text += piece.text;
      previous.width += piece.width;
    } else {
      merged.push({ ...piece });
    }
  }
  const ordered = reorderForDirection(merged, textDirection);
  let x = 0;
  const out: LinePiece[] = ordered.map((piece) => {
    const placed: LinePiece = {
      text: piece.text,
      font: piece.run.font,
      size: piece.run.size,
      color: piece.run.color,
      x,
      width: piece.width,
      ...(piece.run.token ? { token: piece.run.token } : {})
    };
    x += piece.width;
    return placed;
  });
  return { pieces: out, width: x, height: metrics.height, ascent: metrics.ascent };
}

/**
 * UAX #9 over the line: embedding levels per character, then the segments to reverse. A piece
 * is split where its characters change level so mixed-direction runs come out right, and the
 * pieces are then placed in visual order. Mirrored characters in right-to-left spans are
 * swapped (a "(" becomes ")"), as the algorithm requires.
 */
function reorderForDirection(
  pieces: Array<{ text: string; run: ShapedRun; width: number }>,
  textDirection: "ltr" | "rtl"
): Array<{ text: string; run: ShapedRun; width: number }> {
  const full = pieces.map((piece) => piece.text).join("");
  if (full.length === 0) {
    return pieces;
  }
  const embedding = bidi.getEmbeddingLevels(full, textDirection);
  const levels = embedding.levels;
  let hasRtl = false;
  for (let i = 0; i < levels.length; i += 1) {
    if ((levels[i]! & 1) === 1) {
      hasRtl = true;
      break;
    }
  }
  if (!hasRtl && textDirection === "ltr") {
    return pieces;
  }
  // Characters as units, each tagged with its piece; then reorder by the algorithm's segments.
  interface Char {
    char: string;
    piece: (typeof pieces)[number];
    level: number;
  }
  const chars: Char[] = [];
  let offset = 0;
  const mirrored = bidi.getMirroredCharactersMap(full, embedding);
  for (const piece of pieces) {
    for (const char of piece.text) {
      const index = offset;
      const level = levels[index] ?? 0;
      chars.push({ char: (level & 1) === 1 ? mirrored.get(index) ?? char : char, piece, level });
      offset += char.length;
    }
  }
  // bidi-js works on UTF-16 indices; rebuild per code unit to apply its segments faithfully.
  const units: Char[] = [];
  for (const entry of chars) {
    for (let i = 0; i < entry.char.length; i += 1) {
      units.push({ ...entry, char: i === 0 ? entry.char : "" });
    }
  }
  const visual = [...units];
  for (const [start, end] of bidi.getReorderSegments(full, embedding)) {
    const segment = visual.slice(start, end + 1).reverse();
    visual.splice(start, segment.length, ...segment);
  }
  // Group consecutive units of one piece and one direction into drawable spans. A
  // right-to-left span's characters are reversed back to logical order here, because fontkit
  // reverses a right-to-left glyph run itself when the text is drawn.
  const out: Array<{ text: string; run: ShapedRun; width: number }> = [];
  let group: Char[] = [];
  const flush = (): void => {
    if (group.length === 0) {
      return;
    }
    const first = group[0]!;
    const rtl = (first.level & 1) === 1;
    const text = (rtl ? [...group].reverse() : group).map((unit) => unit.char).join("");
    out.push({ text, run: first.piece.run, width: widthOf(text, first.piece.run) });
    group = [];
  };
  for (const unit of visual) {
    const first = group[0];
    if (first && (first.piece !== unit.piece || (first.level & 1) !== (unit.level & 1))) {
      flush();
    }
    group.push(unit);
  }
  flush();
  return out;
}
