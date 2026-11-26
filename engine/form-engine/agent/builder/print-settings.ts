/**
 * The form-wide print settings (`configuration.print` on the form root) as the agent tools see
 * them. The root's inspector does not list them (the Print workspace edits them), so what
 * `get_component` shows for the root and what `set_properties` accepts and checks is declared
 * here: each setting's path, control, words and default.
 */
import { DEFAULT_PRINT_CONFIGURATION, PRINT_RENDITIONS, PRINT_SCALE_MAX, PRINT_SCALE_MIN, isPrintRendition } from "../../core/schema/print.js";
import type { InspectorControl, InspectorField } from "../../builder/property-editor/inspector-model.js";

interface RootPrintSetting {
  path: string;
  /** The control that decides how a value is coerced and shaped; `undefined` leaves the value as sent (a list). */
  control: InspectorControl | undefined;
  label: string;
  description: string;
  /** What the form does while the setting is unset. */
  fallback: unknown;
  choices?: ReadonlyArray<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
}

const SLOT_WORDS = "One line of text; placeholders go in double braces: title, date, page, pages, receipt.PATH, host.KEY or a field's data path. Empty prints nothing there; unset keeps the default.";

const SETTINGS: readonly RootPrintSetting[] = [
  {
    path: "print.renditions",
    control: undefined,
    label: "Renditions offered",
    description: `The printed copies a person may choose from, a list of ${PRINT_RENDITIONS.join(", ")}.`,
    fallback: DEFAULT_PRINT_CONFIGURATION.renditions
  },
  {
    path: "print.defaultRendition",
    control: "select",
    label: "Default rendition",
    description: "The copy printed when none is asked for; one of the renditions offered, else the first of them.",
    fallback: DEFAULT_PRINT_CONFIGURATION.defaultRendition,
    choices: PRINT_RENDITIONS.map((value) => ({ value, label: value }))
  },
  { path: "print.titleOnFirstPage", control: "checkbox", label: "Title at the top of the form", description: "The form's title above the first page's content.", fallback: DEFAULT_PRINT_CONFIGURATION.titleOnFirstPage },
  {
    path: "print.scale",
    control: "number",
    label: "Scale (1 = 100%)",
    description: "How large the printed form is drawn.",
    fallback: DEFAULT_PRINT_CONFIGURATION.scale,
    min: PRINT_SCALE_MIN,
    max: PRINT_SCALE_MAX,
    step: 0.05
  },
  { path: "print.header.start", control: "localized-text", label: "Header, start", description: SLOT_WORDS, fallback: DEFAULT_PRINT_CONFIGURATION.header.start },
  { path: "print.header.end", control: "localized-text", label: "Header, end", description: SLOT_WORDS, fallback: DEFAULT_PRINT_CONFIGURATION.header.end },
  { path: "print.footer.start", control: "localized-text", label: "Footer, start", description: SLOT_WORDS, fallback: DEFAULT_PRINT_CONFIGURATION.footer.start },
  { path: "print.footer.end", control: "localized-text", label: "Footer, end", description: `${SLOT_WORDS} Unset: the page number line.`, fallback: null },
  {
    path: "print.journeyPageBreaks",
    control: "checkbox",
    label: "Each journey page on its own sheet",
    description: "A journey's pages each start a new sheet.",
    fallback: DEFAULT_PRINT_CONFIGURATION.journeyPageBreaks
  }
];

const BY_PATH: ReadonlyMap<string, RootPrintSetting> = new Map(SETTINGS.map((setting) => [setting.path, setting]));

/** Whether `path` is one of the form's print settings (the root's `print.*` leaves). */
export function isRootPrintPath(path: string): boolean {
  return BY_PATH.has(path);
}

/** The control a root print setting is written with, when it has one that coerces. */
export function rootPrintControl(path: string): InspectorControl | undefined {
  return BY_PATH.get(path)?.control;
}

/** What is wrong with a value for a root print setting the reader would drop without a word, in words for a refusal; `undefined` when it is fine (or clears the setting). */
export function rootPrintValueProblem(path: string, value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const names = PRINT_RENDITIONS.join(", ");
  if (path === "print.renditions" && !(Array.isArray(value) && value.length > 0 && value.every(isPrintRendition))) {
    return `a non-empty list of renditions from ${names}`;
  }
  if (path === "print.defaultRendition" && !isPrintRendition(value)) {
    return `one of ${names}`;
  }
  return undefined;
}

/**
 * The root's print settings as inspector fields, `read` giving what the form stores at a path
 * (an unset one shows what the form does then), for `get_component` to list beside the
 * inspector's own.
 */
export function rootPrintFields(read: (path: string) => unknown): InspectorField[] {
  return SETTINGS.map((setting) => {
    const stored = read(setting.path);
    const field: InspectorField = {
      propertyPath: setting.path,
      label: setting.label,
      description: setting.description,
      control: setting.control ?? "custom",
      value: stored === undefined ? setting.fallback : stored,
      choices: (setting.choices ?? []).map((choice) => ({ ...choice }))
    };
    if (setting.min !== undefined) {
      field.min = setting.min;
    }
    if (setting.max !== undefined) {
      field.max = setting.max;
    }
    if (setting.step !== undefined) {
      field.step = setting.step;
    }
    return field;
  });
}
