import type { LocalizedText } from "./contracts.js";
import { resolveLocalizedText } from "../localization/localized-text.js";
import { addressOf, isSafeSegment, resolveText, type TextSources } from "../localization/translations.js";
import { kernelMaxComponentDepth } from "../expressions/compile.js";

/**
 * Form chrome: the pieces drawn *with* the form, above and below its fields — a logo, the
 * form's title, instructions, a language switcher. Two regions, `header` and `footer`, each a
 * list of typed parts. Two parties compose them:
 *
 * - the form's author, in the builder's Form panel, saved as `root.configuration.chrome`
 *   (read by {@link readFormChromeConfiguration}); and
 * - the host, on `<datum-form-renderer>.chrome` (forwarded by `<datum-form-host>.chrome` and
 *   `<datum-form>.chrome`), whose parts are added after the form's — see
 *   {@link resolveRegionParts} for the merge — or replace them.
 *
 * The two differ in their texts. An authored part carries an `id`, unique across
 * both regions, and its texts are strings in the form's default language, translated in
 * the definition's map at `chrome › <id> › <property>`. A host's part is host data: its texts
 * are `LocalizedText` with their languages inline, and it needs no id. {@link chromePartText}
 * resolves either. The types live here, at the schema layer, because a definition carries
 * them; `render/live/chrome.ts` draws them.
 */

export type FormChromeRegion = "header" | "footer";

export const LANGUAGE_SWITCHER_PART_TYPE = "language-switcher";

/** Where a part sits on its own row of the region (the region is a vertical stack of rows). */
export type ChromePartAlign = "start" | "center" | "end";

/** How a group spreads its parts along its row. */
export type ChromeGroupJustify = "start" | "center" | "end" | "space-between";

export type ChromeHeadingLevel = 1 | 2 | 3;

/** What every part may say about its placement, whoever wrote it. */
interface ChromePlacement {
  /**
   * The part's horizontal placement on its row, in the writing direction (`end` is the right
   * edge of a left-to-right form). Defaults to `end` for a language switcher, `start` for
   * everything else. Ignored inside a group, whose `justify` places its parts.
   */
  align?: ChromePartAlign | undefined;
}

/** An authored part's base. */
interface ChromePartBase extends ChromePlacement {
  /**
   * The part's id: required, unique across the header and the footer, and the key its
   * translations live under (`chrome › <id> › <property>`). The builder assigns one
   * (`part_1`-style) to every part it creates; a part without one is not read.
   */
  id: string;
}

/**
 * A part as a region draws it ({@link resolveRegionParts}): the author's, or one a host gave,
 * marked `host` — its texts are then the host's `LocalizedText`, resolved as host data.
 */
interface DrawnPartBase extends ChromePlacement {
  id?: string | undefined;
  host?: true | undefined;
}

/**
 * A language switcher over the form's own locales. The option list is the form's
 * (`localization.supportedLocales`, in its order, each under its authored label or, absent
 * one, named in its own language), never the host's. A form author placing one
 * says where the switcher goes; a host that offers one through `chrome` fills that spot
 * rather than adding a second (see {@link resolveRegionParts}).
 */
interface SwitcherFields<Text> {
  type: typeof LANGUAGE_SWITCHER_PART_TYPE;
  /** The control's label. Defaults to "Language". */
  label?: Text | undefined;
  /** Keeps the label for assistive technology only. */
  hideLabel?: boolean | undefined;
}

/**
 * A picture from a URL — a logo, first of all. Whatever `src` resolves to is held to the `html`
 * component's URL rule (`http(s)`, relative, `data:image/*`), and an unsafe or empty one draws
 * nothing. `href` wraps the picture in a link, held to the same rule.
 */
interface ImageFields<Text> {
  type: "image";
  src: Text;
  /** The picture's text alternative; absent, the picture is decorative (`alt=""`). */
  alt?: Text | undefined;
  href?: Text | undefined;
  /** Rendered size in CSS pixels, when fixed. */
  width?: number | undefined;
  height?: number | undefined;
}

interface HeadingFields<Text> {
  type: "heading";
  text: Text;
  /** The heading element's level; default 2 (the form's own title is the `h1`). */
  level?: ChromeHeadingLevel | undefined;
}

/** A paragraph of plain text. */
interface TextFields<Text> {
  type: "text";
  text: Text;
}

/**
 * Author-written markup — instructions with links and lists — reduced to the `html`
 * component's allowlist (`sanitizeStaticHtml`) after the locale's text is chosen.
 */
interface HtmlFields<Text> {
  type: "html";
  html: Text;
}

/** The form's own title (the root's `title`, the builder's "Form title"); nothing without one. */
interface FormTitleFields {
  type: "form-title";
  /** Default 1. */
  level?: ChromeHeadingLevel | undefined;
}

/** The form's own description (the root's `description`); nothing without one. */
interface FormDescriptionFields {
  type: "form-description";
}

/**
 * Several parts on one row — a logo beside the switcher. The parts wrap when the row is too
 * narrow, and mirror with the rest of a right-to-left form.
 */
interface GroupFields<Child> {
  type: "group";
  parts: Child[];
  /** How the parts spread along the row; default `space-between`. */
  justify?: ChromeGroupJustify | undefined;
  /** How the parts line up vertically when their heights differ; default `center`. */
  verticalAlign?: ChromePartAlign | undefined;
}

export interface LanguageSwitcherPart extends ChromePartBase, SwitcherFields<string> {}
export interface ChromeImagePart extends ChromePartBase, ImageFields<string> {}
export interface ChromeHeadingPart extends ChromePartBase, HeadingFields<string> {}
export interface ChromeTextPart extends ChromePartBase, TextFields<string> {}
export interface ChromeHtmlPart extends ChromePartBase, HtmlFields<string> {}
export interface ChromeFormTitlePart extends ChromePartBase, FormTitleFields {}
export interface ChromeFormDescriptionPart extends ChromePartBase, FormDescriptionFields {}
export interface ChromeGroupPart extends ChromePartBase, GroupFields<FormChromePart> {}

/**
 * Every kind of chrome a form's author may place: a discriminated union on `type`, so adding a
 * kind is a new member here and a case in `chromePartHtml`, never a change to the host-facing
 * configuration shape.
 */
export type FormChromePart =
  | LanguageSwitcherPart
  | ChromeImagePart
  | ChromeHeadingPart
  | ChromeTextPart
  | ChromeHtmlPart
  | ChromeFormTitlePart
  | ChromeFormDescriptionPart
  | ChromeGroupPart;

export interface DrawnLanguageSwitcherPart extends DrawnPartBase, SwitcherFields<LocalizedText> {}
export interface DrawnChromeImagePart extends DrawnPartBase, ImageFields<LocalizedText> {}
export interface DrawnChromeHeadingPart extends DrawnPartBase, HeadingFields<LocalizedText> {}
export interface DrawnChromeTextPart extends DrawnPartBase, TextFields<LocalizedText> {}
export interface DrawnChromeHtmlPart extends DrawnPartBase, HtmlFields<LocalizedText> {}
export interface DrawnChromeFormTitlePart extends DrawnPartBase, FormTitleFields {}
export interface DrawnChromeFormDescriptionPart extends DrawnPartBase, FormDescriptionFields {}
export interface DrawnChromeGroupPart extends DrawnPartBase, GroupFields<ChromePart> {}

/**
 * A part as a host gives it on `.chrome` and as a region draws it once the host's parts meet
 * the form's: an authored {@link FormChromePart} (assignable as it is), or a host's, which
 * `readHostChromeConfiguration` marks `host: true` and whose texts may be `LocalizedText`.
 */
export type ChromePart =
  | DrawnLanguageSwitcherPart
  | DrawnChromeImagePart
  | DrawnChromeHeadingPart
  | DrawnChromeTextPart
  | DrawnChromeHtmlPart
  | DrawnChromeFormTitlePart
  | DrawnChromeFormDescriptionPart
  | DrawnChromeGroupPart;

export type FormChromePartType = FormChromePart["type"];

export const FORM_CHROME_PART_TYPES: readonly FormChromePartType[] = [
  LANGUAGE_SWITCHER_PART_TYPE,
  "image",
  "heading",
  "text",
  "html",
  "form-title",
  "form-description",
  "group"
];

/** The text members a part may carry, by the property name its translation is stored under. */
export type ChromeTextProperty = "label" | "src" | "alt" | "href" | "text" | "html";

/**
 * What a drawn part shows for `property` in `locale`: a host's part resolves its own
 * `LocalizedText`; an authored part's string is the default, translated at
 * `chrome › <id> › <property>` through the definition's map and the host's catalog.
 * `undefined` when the part has no such text.
 */
export function chromePartText(part: ChromePart, property: ChromeTextProperty, locale: string, sources: TextSources): string | undefined {
  const value = (part as unknown as Record<string, LocalizedText | undefined>)[property];
  if (value === undefined) {
    return undefined;
  }
  if (part.host === true || typeof value !== "string" || part.id === undefined) {
    return resolveLocalizedText(value, locale);
  }
  return resolveText(value, addressOf.chrome(part.id, property), locale, sources);
}

/**
 * What a form's author saves as `root.configuration.chrome`, as {@link readFormChromeConfiguration}
 * reads it: the parts of each region and a frame preset id.
 */
export interface AuthoredChromeConfiguration {
  /**
   * The parts as the renderer draws them. An authored part whose id is missing, unsafe or
   * shared with another part is kept without one ({@link readFormChromeConfiguration}), so it
   * draws in the form's own language and never in another part's translation.
   */
  header?: ChromePart[] | undefined;
  footer?: ChromePart[] | undefined;
  /** A frame preset id; see {@link FormChromeConfiguration.frame}. */
  frame?: string | undefined;
}

/**
 * What a host sets on `<datum-form-renderer>.chrome` (or `<datum-form-host>.chrome`,
 * `<datum-form>.chrome`): its parts, its frame, and how they meet the form's own
 * ({@link AuthoredChromeConfiguration}).
 */
export interface FormChromeConfiguration {
  header?: ChromePart[] | undefined;
  footer?: ChromePart[] | undefined;
  /**
   * The frame drawn around the form: a preset id — the engine's `seamless`,
   * `outlined` and `paper`, or one the binding that draws the form defines in its `frames`. The form's author
   * picks one in the builder (a string). A host's frame is a *default*, used when the author
   * picked none, unless the host marks it `fixed`, which wins on that page whatever the author
   * chose. See {@link resolveFrame}.
   */
  frame?: string | FormChromeFrameSetting | undefined;
  /**
   * `include` (the default) draws the form's authored parts first and the host's after them;
   * `exclude` draws the host's alone — for a page that composes the whole header itself.
   */
  formChrome?: "include" | "exclude" | undefined;
  /**
   * `false` drops a language switcher the form's author placed — for a page that has language
   * controls of its own. Default `true`.
   */
  formLanguageSwitcher?: boolean | undefined;
}

/** The host's frame with its precedence: `fixed` wins over the author's; otherwise it is the default. */
export interface FormChromeFrameSetting {
  id: string;
  fixed?: boolean | undefined;
}

export const SEAMLESS_FRAME_ID = "seamless";

/** A frame preset id: lower-case, digits and dashes, as a class-name suffix must be. */
const FRAME_ID = /^[a-z][a-z0-9-]*$/;

export function isFrameId(value: unknown): value is string {
  return typeof value === "string" && FRAME_ID.test(value);
}

/** The frame a value names, in either form, or `undefined` when it names none. */
export function readFrameSetting(value: unknown): FormChromeFrameSetting | undefined {
  if (isFrameId(value)) {
    return { id: value };
  }
  if (isRecord(value) && isFrameId(value.id)) {
    return value.fixed === true ? { id: value.id, fixed: true } : { id: value.id };
  }
  return undefined;
}

/**
 * The frame one render draws: the host's when it is fixed or the author picked none,
 * else the author's, else `seamless`. Independent of `formChrome: "exclude"`, which governs
 * parts; a host that must show a plain form on its own card sets `{ id: "seamless", fixed: true }`.
 */
export function resolveFrame(host: FormChromeConfiguration | undefined, form: AuthoredChromeConfiguration | undefined): string {
  const hostFrame = readFrameSetting(host?.frame);
  const formFrame = readFrameSetting(form?.frame);
  if (hostFrame && (hostFrame.fixed || !formFrame)) {
    return hostFrame.id;
  }
  return formFrame?.id ?? SEAMLESS_FRAME_ID;
}

const ALIGNS: ReadonlySet<string> = new Set(["start", "center", "end"]);
const JUSTIFIES: ReadonlySet<string> = new Set(["start", "center", "end", "space-between"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An authored text: a string in the form's default language. */
function readAuthoredText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A host's text: a string, or a `LocalizedText` object with a string `default` and string translations. */
function readHostText(value: unknown): LocalizedText | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!isRecord(value) || typeof value.default !== "string") {
    return undefined;
  }
  if (!isRecord(value.locales)) {
    return { default: value.default };
  }
  const locales = Object.fromEntries(
    Object.entries(value.locales).filter((entry): entry is [string, string] => isSafeSegment(entry[0]) && typeof entry[1] === "string")
  );
  return { default: value.default, locales };
}

function readAlign(value: unknown): ChromePartAlign | undefined {
  return typeof value === "string" && ALIGNS.has(value) ? (value as ChromePartAlign) : undefined;
}

function readLevel(value: unknown): ChromeHeadingLevel | undefined {
  return value === 1 || value === 2 || value === 3 ? value : undefined;
}

function readDimension(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const size = Math.floor(value);
  return size >= 1 ? size : undefined;
}

/**
 * One authored part, normalised, or `undefined` for one the form cannot draw: one without a
 * safe `id` (its translations would have no key), an unknown type, a text part
 * with no text, an image with no `src`, or a text that is not a string. Unknown types are
 * dropped rather than kept because a definition from a newer engine may name a part this one
 * has no markup for, and a silent gap is the same outcome the renderer would reach. Inside a
 * group the same holds for each part.
 */
export function readFormChromePart(value: unknown): FormChromePart | undefined {
  return readPart(value, { host: false, drawn: false }, 1) as FormChromePart | undefined;
}

/**
 * How a part is read: `host` (a host's part: no id, `LocalizedText` texts) or the author's;
 * `drawn` (for the renderer) keeps an authored part whose id cannot key a translation, without
 * the id, where the strict reader drops it.
 */
interface ReadMode {
  host: boolean;
  drawn: boolean;
}

/**
 * The deepest a group may nest, the depth a definition's components may nest (32): a part past
 * it is dropped, so a hostile chain of groups cannot overflow the stack of a reader or of the
 * markup built from it.
 */
const MAX_PART_DEPTH = kernelMaxComponentDepth();

/**
 * {@link readFormChromePart} for the author's parts (`host` false: an id required, texts
 * strings) or the host's (`host` true: no id read, texts `LocalizedText`, marked `host`).
 */
function readPart(value: unknown, mode: ReadMode, depth: number): ChromePart | undefined {
  const { host } = mode;
  if (depth > MAX_PART_DEPTH || !isRecord(value) || typeof value.type !== "string") {
    return undefined;
  }
  const keyed = isSafeSegment(value.id);
  if (!host && !keyed && !mode.drawn) {
    return undefined;
  }
  const readText = host ? readHostText : readAuthoredText;
  const finish = <T extends ChromePart>(part: T): T => {
    const align = readAlign(value.align);
    return {
      ...(host || !keyed ? {} : { id: value.id as string }),
      ...part,
      ...(align ? { align } : {}),
      ...(host ? { host: true as const } : {})
    };
  };
  switch (value.type) {
    case LANGUAGE_SWITCHER_PART_TYPE: {
      const label = readText(value.label);
      return finish({
        type: LANGUAGE_SWITCHER_PART_TYPE,
        ...(label !== undefined ? { label } : {}),
        // A host's `false` is kept: it shows the label of an author's switcher it words
        // (see resolveRegionParts), where absent it would leave the author's `true`.
        ...(value.hideLabel === true ? { hideLabel: true } : host && value.hideLabel === false ? { hideLabel: false } : {})
      });
    }
    case "image": {
      const src = readText(value.src);
      if (src === undefined) {
        return undefined;
      }
      const alt = readText(value.alt);
      const href = readText(value.href);
      const width = readDimension(value.width);
      const height = readDimension(value.height);
      return finish({
        type: "image",
        src,
        ...(alt !== undefined ? { alt } : {}),
        ...(href !== undefined ? { href } : {}),
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {})
      });
    }
    case "heading": {
      const text = readText(value.text);
      if (text === undefined) {
        return undefined;
      }
      const level = readLevel(value.level);
      return finish({ type: "heading", text, ...(level ? { level } : {}) });
    }
    case "text": {
      const text = readText(value.text);
      return text === undefined ? undefined : finish({ type: "text", text });
    }
    case "html": {
      const html = readText(value.html);
      return html === undefined ? undefined : finish({ type: "html", html });
    }
    case "form-title": {
      const level = readLevel(value.level);
      return finish({ type: "form-title", ...(level ? { level } : {}) });
    }
    case "form-description":
      return finish({ type: "form-description" });
    case "group": {
      const parts = readParts(value.parts, mode, depth + 1);
      const justify =
        typeof value.justify === "string" && JUSTIFIES.has(value.justify) ? (value.justify as ChromeGroupJustify) : undefined;
      const verticalAlign = readAlign(value.verticalAlign);
      return finish({
        type: "group",
        parts,
        ...(justify ? { justify } : {}),
        ...(verticalAlign ? { verticalAlign } : {})
      });
    }
    default:
      return undefined;
  }
}

/** A region's authored parts, normalised; anything that is not a list reads as none. */
export function readFormChromeParts(value: unknown): FormChromePart[] {
  return readParts(value, { host: false, drawn: false }, 1) as FormChromePart[];
}

function readParts(value: unknown, mode: ReadMode, depth: number): ChromePart[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((part) => readPart(part, mode, depth)).filter((part): part is ChromePart => part !== undefined);
}

/** Every authored part record of `chrome`, groups walked: where it sits and the id as written. */
function rawChromeParts(chrome: Record<string, unknown>): Array<{ region: FormChromeRegion; position: number[]; id: unknown }> {
  const found: Array<{ region: FormChromeRegion; position: number[]; id: unknown }> = [];
  const walk = (parts: unknown, region: FormChromeRegion, path: number[]): void => {
    if (!Array.isArray(parts) || path.length >= MAX_PART_DEPTH) {
      return;
    }
    parts.forEach((part, index) => {
      if (!isRecord(part)) {
        return;
      }
      found.push({ region, position: [...path, index], id: part.id });
      walk(part.parts, region, [...path, index]);
    });
  };
  walk(chrome.header, "header", []);
  walk(chrome.footer, "footer", []);
  return found;
}

/**
 * How many records carry each usable id. Counted over the records as written, not over the parts
 * a reader keeps: a holder the reader cannot draw still holds the id, so a translation written
 * for it is not knowably the other holder's.
 */
function idCounts(found: ReadonlyArray<{ id: unknown }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of found) {
    if (isSafeSegment(entry.id)) {
      counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
    }
  }
  return counts;
}

/** The parts with the id taken off every one whose id is in `repeated`. */
function withoutIds(parts: readonly ChromePart[], repeated: ReadonlySet<string>): ChromePart[] {
  return parts.map((part) => {
    const inner = part.type === "group" ? { parts: withoutIds(part.parts, repeated) } : {};
    if (part.id !== undefined && repeated.has(part.id)) {
      const { id: _dropped, ...rest } = part;
      return { ...rest, ...inner } as ChromePart;
    }
    return part.type === "group" ? ({ ...part, ...inner } as ChromePart) : part;
  });
}

/** What is wrong with the ids of a form's authored chrome parts, for a load check. */
export interface ChromePartIdProblem {
  code: "missing" | "unsafe" | "repeated";
  region: FormChromeRegion;
  /** The part's place: indexes down through groups, `[0, 2]` being the third part of the first part (a group). */
  position: number[];
  /** The id as written (absent for a missing one). */
  id?: string;
}

/**
 * The ids of `chrome`'s authored parts that cannot key a translation: a part with none, one
 * `__proto__`-style or empty, and every part of an id that more than one part carries, across
 * the header and the footer and the groups inside them. The renderer draws such a part
 * untranslated ({@link readFormChromeConfiguration}); a load or save check reports them here.
 * Never throws; anything that is not a list of records is skipped.
 */
export function chromePartIdProblems(rootConfiguration: unknown): ChromePartIdProblem[] {
  const chrome = isRecord(rootConfiguration) ? rootConfiguration.chrome : undefined;
  if (!isRecord(chrome)) {
    return [];
  }
  const found = rawChromeParts(chrome);
  const counts = idCounts(found);
  const problems: ChromePartIdProblem[] = [];
  for (const entry of found) {
    if (entry.id === undefined || entry.id === null) {
      problems.push({ code: "missing", region: entry.region, position: entry.position });
    } else if (!isSafeSegment(entry.id)) {
      problems.push({ code: "unsafe", region: entry.region, position: entry.position, ...(typeof entry.id === "string" ? { id: entry.id } : {}) });
    } else if ((counts.get(entry.id) ?? 0) > 1) {
      problems.push({ code: "repeated", region: entry.region, position: entry.position, id: entry.id });
    }
  }
  return problems;
}

/**
 * The form's own chrome from its root configuration (`configuration.chrome`), or `undefined`
 * when it authored none. Read where it is drawn, like the print block: nothing is rewritten
 * into the definition.
 */
export function readFormChromeConfiguration(rootConfiguration: unknown): AuthoredChromeConfiguration | undefined {
  if (!isRecord(rootConfiguration) || !isRecord(rootConfiguration.chrome)) {
    return undefined;
  }
  // The renderer's read keeps a part whose id cannot key a translation (none, unsafe, or shared
  // with another part) but takes the id off it: the part draws in the form's own language, and
  // never in the translation of the part it shares an id with. Which of two parts a translation
  // was written for is not knowable, so every holder of a repeated id goes untranslated.
  const mode: ReadMode = { host: false, drawn: true };
  let header = readParts(rootConfiguration.chrome.header, mode, 1);
  let footer = readParts(rootConfiguration.chrome.footer, mode, 1);
  const repeated = new Set<string>();
  for (const [id, count] of idCounts(rawChromeParts(rootConfiguration.chrome))) {
    if (count > 1) {
      repeated.add(id);
    }
  }
  if (repeated.size > 0) {
    header = withoutIds(header, repeated);
    footer = withoutIds(footer, repeated);
  }
  // The author's frame is a plain id: `fixed` is the host's word, not the form's.
  const frame = readFrameSetting(rootConfiguration.chrome.frame)?.id;
  if (header.length === 0 && footer.length === 0 && frame === undefined) {
    return undefined;
  }
  return {
    ...(header.length > 0 ? { header } : {}),
    ...(footer.length > 0 ? { footer } : {}),
    ...(frame !== undefined ? { frame } : {})
  };
}

/**
 * The host's chrome (`<datum-form-renderer>.chrome`), read the way the author's is but as host
 * data: each part marked `host`, its texts `LocalizedText`, no id needed (a switcher's
 * `hideLabel: false` kept — the host words the author's switcher); the frame through
 * {@link readFrameSetting} (its `fixed` kept — that is the host's word), and the two host-only
 * fields when they hold a value they can take. A host's chrome is often an administrator's
 * JSON, no more trusted than a definition, so nothing reaches the markup as given. `undefined`
 * for anything that is not an object.
 */
export function readHostChromeConfiguration(value: unknown): FormChromeConfiguration | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const hostMode: ReadMode = { host: true, drawn: false };
  const header = readParts(value.header, hostMode, 1);
  const footer = readParts(value.footer, hostMode, 1);
  const frame = readFrameSetting(value.frame);
  const formChrome = value.formChrome === "include" || value.formChrome === "exclude" ? value.formChrome : undefined;
  return {
    ...(header.length > 0 ? { header } : {}),
    ...(footer.length > 0 ? { footer } : {}),
    ...(frame !== undefined ? { frame: frame.fixed ? frame : frame.id } : {}),
    ...(formChrome !== undefined ? { formChrome } : {}),
    ...(typeof value.formLanguageSwitcher === "boolean" ? { formLanguageSwitcher: value.formLanguageSwitcher } : {})
  };
}

/** Whether the list, groups included, holds a language switcher. */
export function hasLanguageSwitcher(parts: readonly ChromePart[] | undefined): boolean {
  return (parts ?? []).some(
    (part) => part.type === LANGUAGE_SWITCHER_PART_TYPE || (part.type === "group" && hasLanguageSwitcher(part.parts))
  );
}

function firstLanguageSwitcher(parts: readonly ChromePart[] | undefined): DrawnLanguageSwitcherPart | undefined {
  for (const part of parts ?? []) {
    if (part.type === LANGUAGE_SWITCHER_PART_TYPE) {
      return part;
    }
    if (part.type === "group") {
      const nested = firstLanguageSwitcher(part.parts);
      if (nested) {
        return nested;
      }
    }
  }
  return undefined;
}

function mapParts(parts: readonly ChromePart[], fn: (part: ChromePart) => ChromePart | undefined): ChromePart[] {
  const out: ChromePart[] = [];
  for (const part of parts) {
    if (part.type === "group") {
      const nested = mapParts(part.parts, fn);
      // A group whose every part went is gone with them; an empty row would only add a gap.
      if (nested.length > 0) {
        out.push({ ...part, parts: nested });
      }
      continue;
    }
    const mapped = fn(part);
    if (mapped) {
      out.push(mapped);
    }
  }
  return out;
}

function withoutLanguageSwitchers(parts: readonly ChromePart[]): ChromePart[] {
  return mapParts(parts, (part) => (part.type === LANGUAGE_SWITCHER_PART_TYPE ? undefined : part));
}

/**
 * The parts one region draws, the form's and the host's together:
 *
 * 1. `host.formChrome === "exclude"` — the host's parts alone.
 * 2. Otherwise the form's authored parts first, the host's after them.
 * 3. There is one language switcher. When the form's author placed one (in either region, in
 *    a group or not), it is the switcher: the host's own switcher parts are dropped, and the
 *    author's takes the host's `label` and `hideLabel` when the host gave them — the host
 *    still words the control. With `host.formLanguageSwitcher === false` it is the other way
 *    round: the author's switchers go, the host's stay where the host put them.
 *
 * A switcher the host words with a `label` is drawn as the host's (`host: true`): its label is
 * then host data, not the author's text at `chrome › <id> › label`. Read every text
 * through {@link chromePartText}.
 *
 * So `<datum-form-host>.languageSwitcher = true` on a form with an authored header lands the
 * switcher in the author's slot when there is one, and after the authored parts when not.
 */
export function resolveRegionParts(
  region: FormChromeRegion,
  host: FormChromeConfiguration | undefined,
  form: AuthoredChromeConfiguration | undefined
): ChromePart[] {
  const hostParts = host?.[region] ?? [];
  if (!form || host?.formChrome === "exclude") {
    return [...hostParts];
  }
  if (host?.formLanguageSwitcher === false) {
    return [...withoutLanguageSwitchers(form[region] ?? []), ...hostParts];
  }
  const formParts: readonly ChromePart[] = form[region] ?? [];
  const formHasSwitcher = hasLanguageSwitcher(form.header) || hasLanguageSwitcher(form.footer);
  if (!formHasSwitcher) {
    return [...formParts, ...hostParts];
  }
  // The host's wording for the switcher, from whichever region it put one in.
  const hostSwitcher = firstLanguageSwitcher(host?.header) ?? firstLanguageSwitcher(host?.footer);
  const worded = hostSwitcher
    ? mapParts(formParts, (part): ChromePart =>
        part.type === LANGUAGE_SWITCHER_PART_TYPE
          ? {
              ...part,
              ...(hostSwitcher.label !== undefined ? { label: hostSwitcher.label, host: true as const } : {}),
              ...(hostSwitcher.hideLabel !== undefined ? { hideLabel: hostSwitcher.hideLabel } : {})
            }
          : part
      )
    : [...formParts];
  return [...worded, ...withoutLanguageSwitchers(hostParts)];
}
