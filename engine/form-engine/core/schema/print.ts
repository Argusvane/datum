/**
 * Print presentation, authored on the form root as `configuration.print`.
 *
 * What a printed form carries besides its fields is the form's decision, not the host's: the
 * renditions it offers and the one it prints by default, a heading on the first page, the
 * scale the whole form prints at, a running header and footer, and whether each journey page
 * starts a new sheet. The host decides the paper (size and margins). Every key is optional; a
 * form that says nothing prints its answers with the title in the header and the footer and the
 * page number line at the footer's end.
 */

/**
 * `answers`: a record of what the person gave (the default). `blank`: a paper form to fill in by
 * hand. `filled`: the paper form's look (boxes, every option of a select, date parts) with the
 * person's answers written in.
 */
export type PrintRendition = "answers" | "blank" | "filled";

/** Every rendition, in the order a host offers them. */
export const PRINT_RENDITIONS: readonly PrintRendition[] = ["answers", "blank", "filled"];

/**
 * One running band of the page box: a line of text at its start and one at its end. Each is
 * literal text with `{{placeholders}}` (`{{title}}`, `{{date}}`, `{{page}}`, `{{pages}}`,
 * `{{receipt.<path>}}`, `{{host.<path>}}`, a field's value path). An absent key takes the
 * default; `""` puts nothing there.
 */
export interface PrintSlots {
  start?: string;
  end?: string;
}

export interface PrintConfiguration {
  /** The renditions the form offers a person; default `["answers"]`. */
  renditions?: PrintRendition[];
  /** The rendition a print without one asks for; default the first offered. */
  defaultRendition?: PrintRendition;
  /** The form title as a heading at the top of the printed form. Default `true`. */
  titleOnFirstPage?: boolean;
  /** The scale the form prints at, `1` being 100%; clamped to the printable range. Default `1`. */
  scale?: number;
  /** The running header. Default: the title at the start, nothing at the end. */
  header?: PrintSlots;
  /** The running footer. Default: the title at the start, the page number line at the end. */
  footer?: PrintSlots;
  /** Each journey page starts a new sheet. Default `false`. */
  journeyPageBreaks?: boolean;
}

/** {@link PrintConfiguration} with every choice made. */
export interface ResolvedPrintConfiguration {
  renditions: PrintRendition[];
  defaultRendition: PrintRendition;
  titleOnFirstPage: boolean;
  scale: number;
  journeyPageBreaks: boolean;
  header: { start: string; end: string };
  /** `end` is `undefined` for the engine's own page number line, worded in the print's locale. */
  footer: { start: string; end: string | undefined };
}

/** Smallest scale worth printing at: a quarter size is already unreadable on Letter or A4. */
export const PRINT_SCALE_MIN = 0.25;
/** Largest scale: past double size a form is a poster, not a document. */
export const PRINT_SCALE_MAX = 2;

/** The slot text that prints the form's title. */
export const PRINT_TITLE_SLOT = "{{title}}";

/** The defaults, frozen; {@link readPrintConfiguration} hands back a fresh copy. */
export const DEFAULT_PRINT_CONFIGURATION: Readonly<ResolvedPrintConfiguration> = Object.freeze({
  renditions: Object.freeze(["answers"]) as unknown as PrintRendition[],
  defaultRendition: "answers" as PrintRendition,
  titleOnFirstPage: true,
  scale: 1,
  journeyPageBreaks: false,
  header: Object.freeze({ start: PRINT_TITLE_SLOT, end: "" }),
  footer: Object.freeze({ start: PRINT_TITLE_SLOT, end: undefined })
});

/** The default configuration as a fresh object the caller may change. */
function defaults(): ResolvedPrintConfiguration {
  return {
    renditions: [...DEFAULT_PRINT_CONFIGURATION.renditions],
    defaultRendition: DEFAULT_PRINT_CONFIGURATION.defaultRendition,
    titleOnFirstPage: DEFAULT_PRINT_CONFIGURATION.titleOnFirstPage,
    scale: DEFAULT_PRINT_CONFIGURATION.scale,
    journeyPageBreaks: DEFAULT_PRINT_CONFIGURATION.journeyPageBreaks,
    header: { ...DEFAULT_PRINT_CONFIGURATION.header },
    footer: { ...DEFAULT_PRINT_CONFIGURATION.footer }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Whether `value` names a rendition. */
export function isPrintRendition(value: unknown): value is PrintRendition {
  return typeof value === "string" && (PRINT_RENDITIONS as readonly string[]).includes(value);
}

/**
 * Reads `configuration.print` off the form root, defaults filled in. Never throws: a key that
 * is missing or not the expected type takes its default.
 */
export function readPrintConfiguration(configuration: unknown): ResolvedPrintConfiguration {
  if (!isRecord(configuration)) {
    return defaults();
  }
  const record = configuration.print;
  if (!isRecord(record)) {
    return defaults();
  }
  const fallback = defaults();
  const renditions = readRenditions(record.renditions);
  const header = isRecord(record.header) ? record.header : {};
  const footer = isRecord(record.footer) ? record.footer : {};
  return {
    renditions,
    defaultRendition: isPrintRendition(record.defaultRendition) && renditions.includes(record.defaultRendition) ? record.defaultRendition : renditions[0]!,
    titleOnFirstPage: readFlag(record.titleOnFirstPage, fallback.titleOnFirstPage),
    scale: readScale(record.scale),
    journeyPageBreaks: readFlag(record.journeyPageBreaks, fallback.journeyPageBreaks),
    header: { start: readSlot(header.start, fallback.header.start), end: readSlot(header.end, fallback.header.end) },
    footer: { start: readSlot(footer.start, fallback.footer.start), end: typeof footer.end === "string" ? footer.end : undefined }
  };
}

/** The offered renditions: known ones, each once, in the order written; none is `["answers"]`. */
function readRenditions(value: unknown): PrintRendition[] {
  const out: PrintRendition[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (isPrintRendition(entry) && !out.includes(entry)) {
        out.push(entry);
      }
    }
  }
  return out.length > 0 ? out : [...DEFAULT_PRINT_CONFIGURATION.renditions];
}

function readSlot(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function readFlag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * A finite positive number, clamped to the printable range. Anything else is the default —
 * including the `0` a cleared number box yields and the `NaN` a non-numeric one does.
 */
function readScale(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_PRINT_CONFIGURATION.scale;
  }
  return Math.min(PRINT_SCALE_MAX, Math.max(PRINT_SCALE_MIN, value));
}
