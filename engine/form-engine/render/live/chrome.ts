/**
 * Form chrome and frames: the pieces drawn with the form that are not
 * fields. A {@link LiveFeature} (`chromeFeature()`) the host lists in `features`; it fills the
 * `header` and `footer` regions and puts the frame's class on the form element.
 *
 * Two regions, each a vertical stack of rows of typed parts (a language switcher, a picture, a
 * heading, a paragraph, allowlisted markup, the form's title or description, a group of
 * parts). The parts come from the form's author (`root.configuration.chrome`) and the host
 * (`chromeFeature({ chrome })`); the schema's `resolveRegionParts` says how they meet. A region
 * with nothing to draw draws nothing, never an empty box.
 *
 * What the renderer owns, whatever binding draws:
 * - which parts there are, in what order, with their texts resolved for the locale
 *   (`chrome > <part id> > <property>` through the form's translations, a host part's own
 *   words), a picture's URL checked, a part's markup reduced to the allowlist;
 * - the form's own title over the fields unless a `form-title` part already says it, and unless
 *   a journey page heads itself (the title is then the caption over the page heading);
 * - the language switch: the runtime decides (`setLocale` throws for a locale the form does not
 *   offer), and the outcome is `datum-locale-applied` or `datum-locale-rejected`. A switcher
 *   over fewer than two locales draws nothing;
 * - the regions are `inert` while a submission is in flight, so a locale cannot change under
 *   values chosen in the other;
 * - the frame: `chrome.frame` resolved (the host's when fixed or the author picked none), a
 *   class `datum-form--frame-<id>` and `data-frame` on the form; `seamless` adds nothing.
 *
 * A part's look is the binding's: `chrome[<part type>]` on the binding, else on Datum's, else
 * the renderer's own markup (its `datum-form__chrome-*` classes, styled by Datum's stylesheet),
 * which an adapter receives as `content`. The language switcher is `binding.languageSwitcher`, else Datum's,
 * else a labelled select.
 */
import { addressOf, resolveText, type TextSources } from "../../core/localization/translations.js";
import { supportedLocaleOptions } from "../../core/localization/supported-locales.js";
import {
  LANGUAGE_SWITCHER_PART_TYPE,
  SEAMLESS_FRAME_ID,
  chromePartText,
  readFormChromeConfiguration,
  readHostChromeConfiguration,
  resolveFrame,
  resolveRegionParts,
  type AuthoredChromeConfiguration,
  type ChromePart,
  type ChromePartAlign,
  type ChromeTextProperty,
  type FormChromeConfiguration,
  type FormChromeRegion
} from "../../core/schema/form-chrome.js";
import { isSafeUrl, sanitizeStaticHtml } from "../../core/schema/static-html.js";
import type { LocalizationConfiguration } from "../../core/schema/types.js";
import type { ChromeAdapter, ChromeState, GroupAdapter, LanguageSwitcherState, View } from "./contract.js";
import { frameClassName, isKnownFrame } from "./datum/frames.js";
import { html, ifDefined, live, nothing, unsafeHTML, type TemplateResult } from "./lit.js";
import type { DrawContext, FormDecor, FormRegion, LiveContext, LiveFeature } from "./mount.js";

/** What the host gives the feature; each is read at every draw, so a later change shows on the next one. */
export interface ChromeFeatureOptions {
  /** The host's chrome (`<datum-form-renderer>.chrome`): its parts, its frame, how they meet the form's own. */
  chrome?: () => unknown;
  /** Whether the form offers locales to switch to (the host's `translations` feature); true when left out. */
  translations?: () => boolean;
  /** The form title's level, the form's place in the page's outline; 1 when left out. */
  headingLevel?: () => number;
}

/** The locale-switch events the host hears (the element's, unchanged). */
export const LOCALE_APPLIED_EVENT = "datum-locale-applied";
export const LOCALE_REJECTED_EVENT = "datum-locale-rejected";

/** What the renderer needs of the runtime beyond `LiveRuntime`. */
interface ChromeRuntime {
  setLocale?(locale: string): void;
  localization?(): LocalizationConfiguration | undefined;
}

const ALIGNS: ReadonlySet<unknown> = new Set<ChromePartAlign>(["start", "center", "end"]);
const JUSTIFIES: ReadonlySet<unknown> = new Set(["start", "center", "end", "space-between"]);

function alignOr(value: unknown, fallback: ChromePartAlign): ChromePartAlign {
  return ALIGNS.has(value) ? (value as ChromePartAlign) : fallback;
}

function justifyOr(value: unknown, fallback: "start" | "center" | "end" | "space-between"): "start" | "center" | "end" | "space-between" {
  return JUSTIFIES.has(value) ? (value as "start" | "center" | "end" | "space-between") : fallback;
}

function levelOr(value: unknown, fallback: 1 | 2 | 3): 1 | 2 | 3 {
  return value === 1 || value === 2 || value === 3 ? value : fallback;
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** A heading element of `level` (clamped to what HTML has) with the classes and part marker given. */
function headingElement(level: number, className: string, part: string | undefined, content: string): TemplateResult {
  const marker = part ?? nothing;
  switch (Math.min(6, Math.max(1, Math.round(level)))) {
    case 1:
      return html`<h1 class=${className} data-chrome-part=${marker}>${content}</h1>`;
    case 2:
      return html`<h2 class=${className} data-chrome-part=${marker}>${content}</h2>`;
    case 3:
      return html`<h3 class=${className} data-chrome-part=${marker}>${content}</h3>`;
    case 4:
      return html`<h4 class=${className} data-chrome-part=${marker}>${content}</h4>`;
    case 5:
      return html`<h5 class=${className} data-chrome-part=${marker}>${content}</h5>`;
    default:
      return html`<h6 class=${className} data-chrome-part=${marker}>${content}</h6>`;
  }
}

/** Own entries only, so a part type named like an `Object.prototype` member resolves to nothing. */
function adapterOf(live: LiveContext, type: string): ChromeAdapter | undefined {
  for (const owner of [live.binding, live.datum]) {
    const chrome = owner.chrome;
    if (chrome !== undefined && Object.prototype.hasOwnProperty.call(chrome, type)) {
      return chrome[type];
    }
  }
  return undefined;
}

/** Everything one region's drawing shares. */
interface RegionDraw {
  draw: DrawContext;
  region: FormChromeRegion;
  sources: TextSources;
  localization: LocalizationConfiguration | undefined;
  /** The form's own heading level, its place in the page's outline (the host's `headingLevel`); 1 when left out. */
  headingLevel: number;
  /** A journey page heads itself at the form's heading level: a `form-title` at or above it is the caption. */
  journey: { headingLevel: number } | undefined;
  rootConfiguration: { title?: unknown; description?: unknown } | undefined;
  /** Switchers drawn in this region so far, so a second (unusual) one gets a distinct control id. */
  switchers: number;
  /** The switcher may switch (the form offers locales, and no submission is in flight). */
  switchTo(code: string): boolean;
}

function textOf(part: ChromePart, property: ChromeTextProperty, region: RegionDraw): string | undefined {
  return nonBlank(chromePartText(part, property, region.draw.form.locale, region.sources));
}

/** The form's own title or description (`form > <property>`) worded for the locale. */
function formTextOf(property: "title" | "description", region: RegionDraw): string | undefined {
  const authored = region.rootConfiguration?.[property];
  return typeof authored === "string" ? nonBlank(resolveText(authored, addressOf.form(property), region.draw.form.locale, region.sources)) : undefined;
}

/** The part drawn through the binding's chrome adapter for its type, else as the renderer's own markup. */
function adapted(part: ChromePart, region: RegionDraw, content: TemplateResult, extra: Partial<ChromeState> = {}): TemplateResult {
  const adapter = adapterOf(region.draw.live, part.type);
  if (adapter === undefined) {
    return content;
  }
  const form = region.draw.form;
  const state: ChromeState = {
    part: part.type,
    region: region.region,
    locale: form.locale,
    dir: form.dir,
    busy: form.busy,
    words: region.draw.words,
    headingLevel: region.headingLevel,
    ...extra,
    content
  };
  return region.draw.live.call("chrome", part.type, () => adapter.template(state)) ?? content;
}

// ── The language switcher ──────────────────────────────────────────────────────────────────

/** The engine's own switcher: a labelled `<select>`, one option per locale, each with its `lang`. */
function defaultSwitcher(state: LanguageSwitcherState): TemplateResult {
  const labelClass = state.hideLabel ? "datum-form__language-switcher-label datum-form__visually-hidden" : "datum-form__language-switcher-label";
  return html`<div class="datum-form__language-switcher" data-chrome-part=${LANGUAGE_SWITCHER_PART_TYPE}><label class=${labelClass} for=${state.controlId}>${state.label}</label><select
      id=${state.controlId}
      class="datum-form__language-switcher-select datum-form__control datum-form__control--select"
      data-locale-switch
      .value=${live(state.current)}
      @change=${(event: Event) => {
        const control = event.currentTarget as HTMLSelectElement;
        if (!state.switchTo(control.value)) {
          control.value = state.current;
        }
      }}
    >${state.locales.map((entry) => html`<option value=${entry.code} lang=${entry.code} ?selected=${entry.code === state.current}>${entry.label}</option>`)}</select></div>`;
}

function switcherPart(part: ChromePart, region: RegionDraw): TemplateResult | undefined {
  const locales = supportedLocaleOptions(region.localization);
  // A switcher with one locale (or none) has nothing to switch to.
  if (locales.length < 2 || part.type !== LANGUAGE_SWITCHER_PART_TYPE) {
    return undefined;
  }
  const live = region.draw.live;
  const index = region.switchers;
  region.switchers += 1;
  const state: LanguageSwitcherState = {
    current: region.draw.form.locale,
    locales,
    label: textOf(part, "label", region) ?? region.draw.words("languageSwitcher"),
    hideLabel: part.hideLabel === true,
    controlId: `datum-form-language-${region.region}${index > 0 ? `-${index + 1}` : ""}`,
    switchTo: region.switchTo,
    words: region.draw.words
  };
  const hook = live.binding.languageSwitcher ?? live.datum.languageSwitcher;
  const content = (hook ? live.call("languageSwitcher", part.type, () => hook.call(live.binding, state)) : undefined) ?? defaultSwitcher(state);
  return adapted(part, region, content);
}

// ── Parts ──────────────────────────────────────────────────────────────────────────────────

function imagePart(part: ChromePart, region: RegionDraw): TemplateResult | undefined {
  const src = textOf(part, "src", region)?.trim();
  // An unsafe URL reads as no picture at all, on this surface as on the `image` component.
  if (!src || !isSafeUrl(src, "image") || part.type !== "image") {
    return undefined;
  }
  const href = textOf(part, "href", region)?.trim();
  // The link is navigated to, not loaded as a picture, so a `data:` URL does not pass here.
  const safeHref = href && isSafeUrl(href, "link") ? href : undefined;
  const alt = textOf(part, "alt", region) ?? "";
  const width = positive(part.width);
  const height = positive(part.height);
  const picture = html`<img src=${src} alt=${alt} width=${ifDefined(width)} height=${ifDefined(height)} referrerpolicy="no-referrer" />`;
  const content = html`<figure class="datum-form__chrome-image" data-chrome-part="image">${safeHref ? html`<a href=${safeHref}>${picture}</a>` : picture}</figure>`;
  return adapted(part, region, content, { image: { src, alt, ...(safeHref ? { href: safeHref } : {}), ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) } });
}

function partView(part: ChromePart, region: RegionDraw): TemplateResult | undefined {
  switch (part.type) {
    case LANGUAGE_SWITCHER_PART_TYPE:
      return switcherPart(part, region);
    case "image":
      return imagePart(part, region);
    case "heading": {
      const text = textOf(part, "text", region);
      const level = levelOr(part.level, 2);
      return text === undefined ? undefined : adapted(part, region, headingElement(level, "datum-form__chrome-heading", "heading", text), { text, level });
    }
    case "text": {
      const text = textOf(part, "text", region);
      return text === undefined ? undefined : adapted(part, region, html`<p class="datum-form__chrome-text" data-chrome-part="text">${text}</p>`, { text });
    }
    case "html": {
      const raw = textOf(part, "html", region);
      const markup = raw === undefined ? "" : sanitizeStaticHtml(raw);
      if (markup.trim().length === 0) {
        return undefined;
      }
      return adapted(part, region, html`<div class="datum-form__chrome-html datum-form__html" data-chrome-part="html">${unsafeHTML(markup)}</div>`, { html: markup });
    }
    case "form-title": {
      const text = formTextOf("title", region);
      if (text === undefined) {
        return undefined;
      }
      const level = levelOr(part.level, 1);
      // An author's title set below the page heading's level stays a heading of its own.
      const caption = region.journey !== undefined && level <= region.journey.headingLevel;
      const content = caption
        ? html`<p class="datum-form__chrome-title datum-form__journey-title" data-chrome-part="form-title">${text}</p>`
        : headingElement(level, "datum-form__title datum-form__chrome-title", "form-title", text);
      return adapted(part, region, content, { text, level, ...(caption ? { caption: true } : {}) });
    }
    case "form-description": {
      const text = formTextOf("description", region);
      return text === undefined ? undefined : adapted(part, region, html`<p class="datum-form__chrome-description" data-chrome-part="form-description">${text}</p>`, { text });
    }
    case "group": {
      // A group without a list of parts (a hand-built one) draws nothing rather than throwing.
      const children: readonly ChromePart[] = Array.isArray(part.parts) ? part.parts : [];
      const drawn = children.map((child) => partView(child, region)).filter((view): view is TemplateResult => view !== undefined);
      if (drawn.length === 0) {
        return undefined;
      }
      const justify = justifyOr(part.justify, "space-between");
      const verticalAlign = alignOr(part.verticalAlign, "center");
      const content = html`<div class="datum-form__chrome-group datum-form__chrome-group--${justify} datum-form__chrome-group--valign-${verticalAlign}" data-chrome-part="group">${drawn}</div>`;
      return adapted(part, region, content, { justify, verticalAlign });
    }
    default:
      return undefined;
  }
}

/** A part's default row placement: a switcher is looked for at the end of its row, content at the start. */
function defaultAlign(part: ChromePart): ChromePartAlign {
  return part.type === LANGUAGE_SWITCHER_PART_TYPE ? "end" : "start";
}

/** Whether any part, at any depth of groups, is a `form-title`. */
function holdsTitle(parts: readonly ChromePart[]): boolean {
  return parts.some((part) => part.type === "form-title" || (part.type === "group" && Array.isArray(part.parts) && holdsTitle(part.parts)));
}

// ── The feature ────────────────────────────────────────────────────────────────────────────

/** The chrome a draw resolves: the host's and the author's, read the way the schema reads them. */
interface Chrome {
  host: FormChromeConfiguration | undefined;
  form: AuthoredChromeConfiguration | undefined;
}

/**
 * The form's name for assistive technology: the root's label, when the author gave one and the
 * adapter drawing the root draws it as no group (`GroupAdapter.formLabelled`), so the name is
 * said once, by the `<form>` element, and not again with each field. The root's legend and hint
 * are folded into a group node by the presentation fold; a root with no label folds to its
 * children alone and the form stays unnamed.
 */
function formNameOf(draw: DrawContext): string | undefined {
  const root = draw.tree.nodes.find((node) => node.kind === "group" && node.model.parentId === undefined);
  if (root === undefined || root.kind !== "group" || root.legend === undefined || root.legend.trim() === "") {
    return undefined;
  }
  const adapter = draw.live.call("formLabelled", root.id, () => draw.live.resolve<GroupAdapter>("group", root.type, root.base)?.adapter);
  return adapter?.formLabelled === true ? root.legend : undefined;
}

/** Form chrome and frames as a renderer module. */
export function chromeFeature(options: ChromeFeatureOptions = {}): LiveFeature {
  const rootConfigurationOf = (live: LiveContext): { title?: unknown; description?: unknown } | undefined => {
    const configuration = live.runtime.formRoot().configuration;
    return configuration !== null && typeof configuration === "object" ? (configuration as { title?: unknown; description?: unknown }) : undefined;
  };

  /** The host's chrome, read again where it is drawn: often an administrator's JSON, no more trusted than the form. */
  const chromeOf = (live: LiveContext): Chrome => ({
    host: readHostChromeConfiguration(options.chrome?.()),
    form: readFormChromeConfiguration(rootConfigurationOf(live))
  });

  const switcher = (live: LiveContext): ((code: string) => boolean) => (code) => {
    const runtime = live.runtime as unknown as ChromeRuntime & { state(): { locale: string } };
    if (!live.mounted() || live.busy() === "submitting") {
      return false;
    }
    if (options.translations?.() === false) {
      live.warnOnce("chrome:translations", "The language switch is ignored: the host's features leave out translations.");
      return false;
    }
    if (runtime.setLocale === undefined) {
      return false;
    }
    if (code === runtime.state().locale) {
      return true;
    }
    try {
      runtime.setLocale(code);
      live.emit(LOCALE_APPLIED_EVENT, { locale: code });
      return true;
    } catch (thrown) {
      live.emit(LOCALE_REJECTED_EVENT, { locale: code, message: thrown instanceof Error ? thrown.message : String(thrown) });
      // A select shows the pick; the draw puts it back to the locale the form is still in.
      live.redraw();
      return false;
    }
  };

  const regionDraw = (region: FormChromeRegion, draw: DrawContext): RegionDraw => {
    const live = draw.live;
    const runtime = live.runtime as unknown as ChromeRuntime;
    const journey = draw.output.meta.journey;
    return {
      draw,
      region,
      headingLevel: options.headingLevel?.() ?? 1,
      sources: { translations: live.runtime.translations?.(), catalog: live.runtime.translationCatalog?.() },
      // A switcher over fewer than two locales draws nothing: with `translations` left out of the host's features the form offers none.
      localization: options.translations?.() === false ? undefined : runtime.localization?.(),
      journey: journey !== undefined && journey.heading !== "hidden" ? { headingLevel: options.headingLevel?.() ?? 1 } : undefined,
      rootConfiguration: rootConfigurationOf(live),
      switchers: 0,
      switchTo: switcher(live)
    };
  };

  const regionView = (region: FormChromeRegion, draw: DrawContext): View => {
    const { host, form } = chromeOf(draw.live);
    const parts = resolveRegionParts(region, host, form);
    const shared = regionDraw(region, draw);
    const rows = parts.flatMap((part) => {
      const view = partView(part, shared);
      return view === undefined ? [] : [html`<div class="datum-form__chrome-row datum-form__chrome-row--${alignOr(part.align, defaultAlign(part))}">${view}</div>`];
    });
    if (rows.length === 0) {
      return nothing;
    }
    // A submission in flight locks the region: a locale changed mid-flight would be stamped on values chosen under the other.
    // The region and its rows are Datum's drawing whichever binding draws a part: inside another binding its tokens tint them.
    const live = draw.live;
    return html`<div class="datum-form__${region}" ?inert=${draw.form.busy === "submitting"} ?data-fallback=${live.binding !== live.datum}>${rows}</div>`;
  };

  /** The form's own title over the fields, unless a `form-title` part or a journey page's heading already says it. */
  const titleView = (draw: DrawContext): View => {
    const live = draw.live;
    const journey = draw.output.meta.journey;
    if (journey !== undefined && journey.heading !== "hidden") {
      return nothing;
    }
    const { host, form } = chromeOf(live);
    if ((["header", "footer"] as const).some((region) => holdsTitle(resolveRegionParts(region, host, form)))) {
      return nothing;
    }
    const title = formTextOf("title", regionDraw("header", draw));
    return title === undefined ? nothing : draw.fallback(headingElement(options.headingLevel?.() ?? 1, "datum-form__title", undefined, title));
  };

  return {
    id: "chrome",
    region: (region: FormRegion, draw: DrawContext): View | undefined => {
      if (region === "header") {
        return html`${regionView("header", draw)}${titleView(draw)}`;
      }
      if (region === "footer") {
        return regionView("footer", draw);
      }
      return undefined;
    },
    formDecor: (draw: DrawContext): FormDecor | undefined => {
      const { host, form } = chromeOf(draw.live);
      const requested = resolveFrame(host, form);
      // A frame id no binding draws (a definition saved for a binding that drew it, opened under one that does not) is drawn in the default frame.
      const known = isKnownFrame(requested, draw.live.binding.frames, draw.live.datum.frames);
      if (!known) {
        draw.live.warnOnce(`frame:${requested}`, `The frame "${requested}" is drawn by no binding: the form is drawn in the default frame.`);
      }
      const frame = known ? requested : SEAMLESS_FRAME_ID;
      const name = formNameOf(draw);
      const attributes: Record<string, string> = {
        ...(frame === SEAMLESS_FRAME_ID ? {} : { "data-frame": frame }),
        ...(name !== undefined ? { "aria-label": name } : {})
      };
      return frame === SEAMLESS_FRAME_ID && name === undefined ? undefined : { classes: frame === SEAMLESS_FRAME_ID ? [] : [frameClassName(frame)], attributes };
    }
  };
}
