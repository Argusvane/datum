/**
 * The Datum binding, assembled: `createDatumBinding(options)` puts Datum's adapters (text-like
 * fields, choices, date, file, signature, buttons, static blocks, containers, data grid, tabs,
 * steps), its chrome, summary and notices, its stylesheet and its token sets together into one
 * {@link LiveBinding}. With no options it is Datum's own look; the options are its seams,
 * each typed, none taking HTML strings:
 *
 * - `tokens`, `responsiveTokens`, `dark`: the token sets. `tokens` go over Datum's light set on
 *   `.datum-form`, `dark` over its dark set on `.datum-form--dark` (drawn while the host's colour
 *   scheme is dark); `dark: false` keeps the light look in either scheme.
 * - `frame`: frame presets beside the built-in `seamless`, `outlined` and `paper` (the chrome's
 *   `frame` picks one by id): a preset's label for a picker and its `.datum-form--frame-<id>`
 *   rules, adopted with the binding's css. A preset under a built-in id relabels or restyles it.
 * - `parts`: part templates (`parts.ts`): marks, help mark, inline error, option rows, the shell
 *   around a field, buttons, the steps' Back, summary, receipt, in-flight line, required note,
 *   a journey page's heading and actions. Each is handed Datum's own drawing to wrap or replace.
 * - `renderers`: per component type, an adapter (or a list told apart by `when`) in place of
 *   Datum's, or a function of Datum's entry that wraps or patches it. Container types
 *   take container adapters the same way. `chrome` does the same for the chrome parts and
 *   `languageSwitcher` for the switcher.
 * - `controls`: the native-control choices (a design system's native-control choices): the field
 *   controls, the container controls, the drawn marks, the summary list, error focus, the width
 *   tabs need, the date's controls and the switcher drawn as links.
 * - `fieldOrder`: the order of a field's label, description, control and error, and the order
 *   of a date's parts (fixed, or by locale).
 * - `texts`, `messages`: the binding's language pack (under the form's translations, over the
 *   engine's English); `cssClasses`: the author classes it gives a meaning to (the four panel looks, and
 *   the host's own beside them).
 *
 * `composeDatumOptions(base, ...more)` builds one option set on another; `createDatumFeatures(options)` lists the renderer modules a host mounts the
 * Datum binding with (or a design-system binding with Datum's behind it): the date's state
 * follows the part order of the binding whose adapter draws it (`LiveBinding.dateOrder`, which
 * the Datum binding sets from `fieldOrder.date`).
 */
import type { LocalizedText } from "../../../core/schema/contracts.js";
import type { LanguagePackTable } from "../../../core/localization/translations.js";
import { createAnnouncerFeature } from "../announcer.js";
import { assetsFeature } from "../assets-feature.js";
import { createButtonsFeature } from "../buttons.js";
import { chromeFeature, type ChromeFeatureOptions } from "../chrome.js";
import type { Adapter, AdapterEntry, ChromeAdapter, CssClassEntry, FieldAdapter, LanguageSwitcherState, LiveBinding, ReviewState } from "../contract.js";
import { mergeCssClasses, PANEL_LOOK_CLASSES } from "../look-classes.js";
import { createDataGridFeature } from "../data-grid.js";
import { createFieldsFeature, type FieldStateBuilder } from "../fields.js";
import { createFilesFeature } from "../files.js";
import { createMediaLabelsFeature } from "../media-labels.js";
import { createReadonlySizingFeature } from "../readonly-sizing.js";
import { createFormNoticesFeature, type FormNoticesOptions } from "../form-notices.js";
import { html, type TemplateResult } from "../lit.js";
import type { LiveFeature } from "../mount.js";
import { createSourcesFeature } from "../sources.js";
import { stepsFeature } from "../steps.js";
import { createSummaryFeature } from "../summary.js";
import { createTabsFeature } from "../tabs.js";
import { createTooltipsFeature } from "../tooltips.js";
import { buttonClassName, buttonFiguresOf } from "./buttons.js";
import { datumChoiceComponents } from "./choice-fields.js";
import type { LanguageLinksOptions } from "./chrome.js";
import { createDatumChromeFiles } from "./chrome-files.js";
import type { DatumContainerControls } from "./container-kit.js";
import { DATUM_CONTAINER_CSS, datumContainerComponents } from "./containers.js";
import type { DatumCssOptions } from "./css.js";
import { createDatumDateAdapter, createDatumDateStateBuilder, normalizeDatePartOrder, type DatumDateOptions } from "./date.js";
import { resolveFieldOptions, type DatumFieldControls, type DatumFieldOptionsInput } from "./field-scaffold.js";
import { frameClassName, frameOptions, type FormFrameDefinition, type FrameOption } from "./frames.js";
import { datumPage } from "./page.js";
import { drawPart, normalizeParts, type DatumParts } from "./parts.js";
import { datumTextComponents } from "./text-fields.js";
import type { DatumTokens } from "./tokens.js";

// ── Options ────────────────────────────────────────────────────────────────────────────────

/**
 * The native-control choices of the Datum look. Every one is optional and keeps Datum's own
 * when left out; names and meanings are a design system's own differences.
 */
export interface DatumControls extends Partial<DatumFieldControls>, Partial<DatumContainerControls> {
  /** Checkboxes and radios drawn by Datum (`drawn`) or the browser's (`native`, the default). */
  choiceMarks?: "native" | "drawn";
  /** An inline error led by a drawn icon (`drawn`, Datum's own), or not (`none`). */
  errorIcon?: "none" | "native" | "drawn";
  /** The error summary's list: unordered (the default) or numbered. */
  summaryList?: "unordered" | "ordered";
  /** Where focus goes after a check that found errors: the summary (the default) or the first field in error. */
  errorFocus?: "summary" | "field";
  /**
   * From what width of the form a tabs container is a strip of tabs: `always` (the default), or
   * a width in CSS px (a number, `"640px"`, or `"40em"` read at 16px to the em). Below it the
   * tabs draw the narrow view: a contents list over the stacked panels.
   */
  tabsFrom?: "always" | number | string;
  /** The date's controls: part boxes or the browser's box, the month control, widths, classes, autocomplete, hints. */
  date?: Omit<DatumDateOptions, "order">;
  /** The language switcher drawn as links rather than Datum's select. */
  languageLinks?: LanguageLinksOptions;
}

/** The order of a field's parts, and of a date's parts. */
export interface DatumFieldOrder {
  /** Label, description, control and error, each once; anything else is Datum's order. */
  parts?: readonly string[];
  /** The date's parts in reading order, or a function of the locale (en: month, day, year). */
  date?: DatumDateOptions["order"];
}

/** A frame preset: its label in a picker, and the rules (for `.datum-form--frame-<id>`, `frameClassName`) that draw it, adopted with the binding's css. */
export type DatumFrame = FormFrameDefinition;

/** A component override: an adapter (or a list), or a function of Datum's own entry that wraps or patches it. */
export type AdapterOverride = AdapterEntry | ((base: AdapterEntry | undefined) => AdapterEntry);

/** A chrome part override: an adapter, or a function of Datum's own that wraps it. */
export type ChromeOverride = ChromeAdapter | ((base: ChromeAdapter | undefined) => ChromeAdapter);

type LanguageSwitcherHook = NonNullable<LiveBinding["languageSwitcher"]>;

export interface DatumBindingOptions {
  /** The binding's id (`datum`) and its name in a picker (`Datum`). */
  id?: string;
  label?: string;
  /** Tokens over Datum's light set. */
  tokens?: DatumTokens;
  /** Token sets that change with the viewport or the form's own width. */
  responsiveTokens?: DatumCssOptions["responsiveTokens"];
  /** Tokens over Datum's dark set, drawn while the colour scheme is dark; `false` draws the light look in either scheme. */
  dark?: DatumTokens | false;
  /** Rules after the sheet and the token sets. */
  css?: string | readonly string[];
  /** Frame presets by id, beside the built-ins. */
  frame?: Readonly<Record<string, DatumFrame>>;
  parts?: DatumParts;
  /** Component adapters by type, over Datum's. */
  renderers?: Readonly<Record<string, AdapterOverride>>;
  /** Chrome part adapters by part type, over Datum's. */
  chrome?: Readonly<Record<string, ChromeOverride>>;
  /** The language switcher, handed Datum's (or the links `controls.languageLinks` asks for) to wrap or draw in place of. */
  languageSwitcher?: (state: LanguageSwitcherState, base: LanguageSwitcherHook) => TemplateResult;
  controls?: DatumControls;
  /** The field parts' order (an array), or the field parts' and the date parts' orders. */
  fieldOrder?: readonly string[] | DatumFieldOrder;
  texts?: LanguagePackTable;
  messages?: LanguagePackTable;
  /** Author classes Datum gives a meaning to, beside the four panel looks it always declares. */
  cssClasses?: readonly CssClassEntry[];
  /** More classes on the form element. */
  formClass?: string;
}

/** The Datum binding with what it was made from: its frames for a picker, its options for composition. */
export interface DatumBinding extends LiveBinding {
  /** The frame presets it adds to the built-ins. */
  frames: Readonly<Record<string, DatumFrame>>;
  options: Readonly<DatumBindingOptions>;
}

// ── Reading the options ────────────────────────────────────────────────────────────────────

/** A frame id that makes a class name: letters, digits and hyphens, starting with a letter. */
const FRAME_ID = /^[A-Za-z][A-Za-z0-9-]*$/;

function framesOf(frames: DatumBindingOptions["frame"]): Record<string, DatumFrame> {
  const out: Record<string, DatumFrame> = {};
  for (const [id, frame] of Object.entries(frames ?? {})) {
    if (FRAME_ID.test(id) && frame !== null && typeof frame === "object") {
      out[id] = frame;
    }
  }
  return out;
}

function orderOf(order: DatumBindingOptions["fieldOrder"]): DatumFieldOrder {
  if (order === undefined) {
    return {};
  }
  return Array.isArray(order) ? { parts: order as readonly string[] } : (order as DatumFieldOrder);
}

/** `tabsFrom` as the form width in px under which tabs take the narrow view; `undefined` for always tabs. */
export function tabsNarrowBelowOf(value: DatumControls["tabsFrom"]): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const match = /^(\d+(?:\.\d+)?)(px|em|rem)$/.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const amount = Number(match[1]);
  return match[2] === "px" ? amount : amount * 16;
}

function cssListOf(css: DatumBindingOptions["css"]): string[] {
  return typeof css === "string" ? [css] : [...(css ?? [])];
}

/** Applies a component override to Datum's own entry. */
function applyOverride(base: AdapterEntry | undefined, override: AdapterOverride): AdapterEntry {
  return typeof override === "function" ? override(base) : override;
}

function applyChrome(base: ChromeAdapter | undefined, override: ChromeOverride): ChromeAdapter {
  return typeof override === "function" ? override(base) : override;
}

// ── Parts that wrap whole adapters and hooks ───────────────────────────────────────────────

/** Every field adapter of `entry` mapped by `wrap`; containers left as they are. */
function mapFieldAdapters(entry: AdapterEntry, wrap: (adapter: FieldAdapter) => FieldAdapter): AdapterEntry {
  const one = (adapter: Adapter): Adapter => (adapter.kind === "field" ? wrap(adapter) : adapter);
  return Array.isArray(entry) ? (entry as readonly Adapter[]).map(one) : one(entry as Adapter);
}

/** The `fieldShell` part around a value-bearing field (a button or a static block has no shell). */
function withFieldShell(adapter: FieldAdapter, parts: Readonly<DatumParts>): FieldAdapter {
  return {
    ...adapter,
    template: (state, on) => {
      const drawn = adapter.template(state, on);
      return state.kind === undefined ? drawn : html`${drawPart(parts, "fieldShell", { state, kind: state.base, default: drawn })}`;
    }
  };
}

/** The `button` part over Datum's button. */
function withButtonPart(adapter: FieldAdapter, parts: Readonly<DatumParts>): FieldAdapter {
  return {
    ...adapter,
    template: (state, on) => {
      const drawn = adapter.template(state, on);
      const figures = buttonFiguresOf(state);
      return html`${drawPart(parts, "button", {
        state,
        label: state.label,
        action: figures.action,
        variant: figures.variant,
        size: figures.size,
        className: buttonClassName(figures),
        busy: state.busy === "submitting" || state.busy === "navigating",
        default: drawn
      })}`;
    }
  };
}

// ── The binding ────────────────────────────────────────────────────────────────────────────

export const DATUM_BINDING_ID = "datum";

export function createDatumBinding(options: DatumBindingOptions = {}): DatumBinding {
  const controls: DatumControls = options.controls ?? {};
  const order = orderOf(options.fieldOrder);
  const parts = normalizeParts(options.parts);
  const frames = framesOf(options.frame);

  const fieldInput: DatumFieldOptionsInput = {
    controls,
    ...(order.parts ? { fieldOrder: order.parts } : {}),
    ...(parts ? { parts } : {})
  };
  const field = resolveFieldOptions(fieldInput);
  const date: DatumDateOptions = { ...(controls.date ?? {}), ...(order.date !== undefined ? { order: order.date } : {}) };
  const errorIcon = controls.errorIcon === "none" ? "native" : controls.errorIcon;

  const slice = createDatumChromeFiles({
    fields: fieldInput,
    ...(controls.summaryList !== undefined ? { summary: { list: controls.summaryList } } : {}),
    ...(controls.buttonGroup !== undefined ? { buttonGroup: controls.buttonGroup } : {}),
    ...(controls.languageLinks !== undefined ? { languageLinks: controls.languageLinks } : {}),
    css: {
      ...(options.tokens ? { tokens: options.tokens } : {}),
      ...(options.dark ? { dark: options.dark } : {}),
      ...(options.responsiveTokens ? { responsiveTokens: options.responsiveTokens } : {}),
      css: [DATUM_CONTAINER_CSS, ...Object.values(frames).map((frame) => frame.css ?? ""), ...cssListOf(options.css)]
    },
    drawn: {
      ...(controls.choiceMarks !== undefined ? { choiceMarks: controls.choiceMarks } : {}),
      ...(controls.selectChevron !== undefined ? { selectChevron: controls.selectChevron } : {}),
      ...(errorIcon !== undefined ? { errorIcon } : {})
    }
  });

  // The containers' button group (author classes, the same `buttonGroup` choice) stands over the slice's.
  let components: Record<string, AdapterEntry> = {
    ...slice.components,
    ...datumTextComponents(fieldInput),
    ...datumChoiceComponents(fieldInput),
    date: createDatumDateAdapter(date, field),
    ...datumContainerComponents({ controls, ...(parts ? { parts } : {}) })
  };

  if (parts?.fieldShell) {
    components = Object.fromEntries(Object.entries(components).map(([type, entry]) => [type, mapFieldAdapters(entry, (adapter) => withFieldShell(adapter, parts))]));
  }
  if (parts?.button && components.button !== undefined) {
    components.button = mapFieldAdapters(components.button, (adapter) => withButtonPart(adapter, parts));
  }
  for (const [type, override] of Object.entries(options.renderers ?? {})) {
    components[type] = applyOverride(components[type], override);
  }

  const chrome: Record<string, ChromeAdapter> = { ...slice.chrome };
  for (const [part, override] of Object.entries(options.chrome ?? {})) {
    chrome[part] = applyChrome(chrome[part], override);
  }
  const switcher = options.languageSwitcher;
  const datumSwitcher = slice.languageSwitcher;
  const languageSwitcher: LanguageSwitcherHook = switcher === undefined ? datumSwitcher : (state) => switcher(state, datumSwitcher);

  const summary = slice.summary;
  const notice = slice.notice;
  const status = slice.status;
  const requiredNote = slice.requiredNote;
  const darkAllowed = options.dark !== false;
  const extraClass = options.formClass;
  const tabsNarrowBelow = tabsNarrowBelowOf(controls.tabsFrom);

  const binding: DatumBinding = {
    id: options.id ?? DATUM_BINDING_ID,
    label: options.label ?? "Datum",
    components,
    css: slice.css,
    formClass: (context) => slice.formClass(darkAllowed ? context : { ...context, colorScheme: "light" }) + (extraClass?.trim() ? ` ${extraClass.trim()}` : ""),
    chrome,
    languageSwitcher,
    summary: parts?.summary ? (entries, state) => html`${drawPart(parts, "summary", { state, entries, default: summary(entries, state) })}` : summary,
    notice: parts?.notice ? (state) => html`${drawPart(parts, "notice", { state, default: notice(state) })}` : notice,
    status: parts?.status ? (state) => html`${drawPart(parts, "status", { state, default: status(state) })}` : status,
    requiredNote: parts?.requiredNote ? (state) => html`${drawPart(parts, "requiredNote", { state, default: requiredNote(state) })}` : requiredNote,
    ...(parts?.journeyHeading || parts?.journeyActions
      ? {
          page: {
            heading: (state) => html`${drawPart(parts, "journeyHeading", { state, default: datumPage.heading(state) })}`,
            actions: (state) => html`${drawPart(parts, "journeyActions", { state, default: datumPage.actions(state) })}`
          }
        }
      : {}),
    // A Check answers list's drawing is Datum's own in the journeys chunk (`state.content`): the part wraps it.
    ...(parts?.journeyReview ? { review: (state: ReviewState) => html`${drawPart(parts, "journeyReview", { state, default: state.content })}` } : {}),
    // The order its date draws the parts in, which the date's state follows (`missingParts`).
    dateOrder: (locale) => normalizeDatePartOrder(typeof date.order === "function" ? date.order(locale) : date.order),
    ...(controls.errorFocus !== undefined ? { errorFocus: controls.errorFocus } : {}),
    ...(tabsNarrowBelow !== undefined ? { tabsNarrowBelow } : {}),
    ...(options.texts ? { texts: options.texts } : {}),
    ...(options.messages ? { messages: options.messages } : {}),
    // The shared panel looks (look-classes.ts) first, then the host's own; a host entry under a look's name replaces it.
    cssClasses: mergeCssClasses(PANEL_LOOK_CLASSES, options.cssClasses),
    frames,
    options
  };
  return binding;
}

// ── Composition ────────────────────────────────────────────────────────────────────────────

function composeAdapterOverride(first: AdapterOverride | undefined, then: AdapterOverride): AdapterOverride {
  if (first === undefined || typeof then !== "function") {
    return then;
  }
  return (base) => then(applyOverride(base, first));
}

function composeChromeOverride(first: ChromeOverride | undefined, then: ChromeOverride): ChromeOverride {
  if (first === undefined || typeof then !== "function") {
    return then;
  }
  return (base) => then(applyChrome(base, first));
}

function mergePacks(first: LanguagePackTable | undefined, then: LanguagePackTable | undefined): LanguagePackTable | undefined {
  if (!first || !then) {
    return then ?? first;
  }
  const out: Record<string, Record<string, string>> = {};
  for (const locale of new Set([...Object.keys(first), ...Object.keys(then)])) {
    out[locale] = { ...(first[locale] ?? {}), ...(then[locale] ?? {}) };
  }
  return out;
}

/**
 * One option set built on others, later over earlier (a host's accent over a look of its own):
 * token sets merged, css and responsive sets appended, frames, parts and controls merged by
 * name, a component or chrome override that is a function wrapping what the earlier sets
 * resolve to, field orders replaced, language packs merged per locale, author classes joined.
 */
export function composeDatumOptions(base: DatumBindingOptions, ...more: readonly DatumBindingOptions[]): DatumBindingOptions {
  return more.reduce<DatumBindingOptions>((acc, next) => {
    const out: DatumBindingOptions = { ...acc };
    const set = <K extends keyof DatumBindingOptions>(key: K, value: DatumBindingOptions[K] | undefined): void => {
      if (value !== undefined) {
        out[key] = value;
      } else {
        delete out[key];
      }
    };
    set("id", next.id ?? acc.id);
    set("label", next.label ?? acc.label);
    set("tokens", acc.tokens || next.tokens ? { ...acc.tokens, ...next.tokens } : undefined);
    set("dark", next.dark === false ? false : next.dark ? { ...(acc.dark || {}), ...next.dark } : acc.dark);
    set("responsiveTokens", acc.responsiveTokens || next.responsiveTokens ? [...(acc.responsiveTokens ?? []), ...(next.responsiveTokens ?? [])] : undefined);
    set("css", acc.css !== undefined || next.css !== undefined ? [...cssListOf(acc.css), ...cssListOf(next.css)] : undefined);
    set("frame", acc.frame || next.frame ? { ...acc.frame, ...next.frame } : undefined);
    set("parts", acc.parts || next.parts ? { ...acc.parts, ...next.parts } : undefined);
    if (acc.renderers || next.renderers) {
      const renderers: Record<string, AdapterOverride> = { ...acc.renderers };
      for (const [type, override] of Object.entries(next.renderers ?? {})) {
        renderers[type] = composeAdapterOverride(renderers[type], override);
      }
      out.renderers = renderers;
    }
    if (acc.chrome || next.chrome) {
      const chrome: Record<string, ChromeOverride> = { ...acc.chrome };
      for (const [part, override] of Object.entries(next.chrome ?? {})) {
        chrome[part] = composeChromeOverride(chrome[part], override);
      }
      out.chrome = chrome;
    }
    set("languageSwitcher", next.languageSwitcher ?? acc.languageSwitcher);
    set(
      "controls",
      acc.controls || next.controls
        ? {
            ...acc.controls,
            ...next.controls,
            ...(acc.controls?.date || next.controls?.date ? { date: { ...acc.controls?.date, ...next.controls?.date } } : {})
          }
        : undefined
    );
    set("fieldOrder", next.fieldOrder === undefined ? acc.fieldOrder : Array.isArray(next.fieldOrder) ? { ...orderOf(acc.fieldOrder), parts: next.fieldOrder } : { ...orderOf(acc.fieldOrder), ...(next.fieldOrder as DatumFieldOrder) });
    set("texts", mergePacks(acc.texts, next.texts));
    set("messages", mergePacks(acc.messages, next.messages));
    set("cssClasses", acc.cssClasses || next.cssClasses ? mergeCssClasses(acc.cssClasses, next.cssClasses) : undefined);
    set("formClass", [acc.formClass, next.formClass].filter((value) => value !== undefined && value.trim() !== "").join(" ") || undefined);
    return out;
  }, { ...base });
}

// ── Frames for a picker ────────────────────────────────────────────────────────────────────

/**
 * The frames a picker offers under the binding, labelled for `locale`: the built-ins in their
 * order (a preset under a built-in id relabels it), then the binding's own.
 */
export function datumFrameOptions(binding: Pick<DatumBinding, "frames"> | undefined, locale = "en"): FrameOption[] {
  return frameOptions(binding?.frames, locale);
}

export { frameClassName };

// ── The renderer modules a Datum form is mounted with ──────────────────────────────────────

/**
 * The state builders the Datum adapters need beyond the renderer's: the date's. Its part order is
 * the drawing binding's `dateOrder` (the Datum binding declares its own); `options.fieldOrder.date`
 * stands in for a binding that declares none.
 */
export function datumFieldStateBuilders(options: DatumBindingOptions = {}): Record<string, FieldStateBuilder> {
  const order = orderOf(options.fieldOrder).date;
  return { date: createDatumDateStateBuilder(order !== undefined ? { order } : {}) };
}

/** What a host says about the renderer modules it lists with the Datum binding. */
export interface DatumFeatureOptions {
  chrome?: ChromeFeatureOptions;
  formNotices?: FormNoticesOptions;
  files?: Parameters<typeof createFilesFeature>[0];
  announcer?: Parameters<typeof createAnnouncerFeature>[0];
  /** Where the error summary goes (the host's `error-summary-placement`). */
  summary?: Parameters<typeof createSummaryFeature>[0];
}

/**
 * The renderer's modules for a form drawn by the Datum binding (or by a design-system binding
 * with Datum's adapters as its fallbacks), in the order they apply: the host's files, the field
 * state (the date's builder from `options`), the help marks, the count announcer, data-source
 * states, buttons, files, chrome, the receipt and status lines, the summary, tabs, data grids and
 * steps. A journey form adds the journey kit's page module.
 */
export function createDatumFeatures(options: DatumBindingOptions = {}, features: DatumFeatureOptions = {}): LiveFeature[] {
  return [
    assetsFeature(),
    createFieldsFeature(datumFieldStateBuilders(options)),
    createTooltipsFeature(),
    createAnnouncerFeature(features.announcer),
    createSourcesFeature(),
    createMediaLabelsFeature(),
    createReadonlySizingFeature(),
    createButtonsFeature(),
    createFilesFeature(features.files),
    chromeFeature(features.chrome),
    createFormNoticesFeature(features.formNotices),
    createSummaryFeature(features.summary),
    createTabsFeature(),
    createDataGridFeature(),
    stepsFeature()
  ];
}
