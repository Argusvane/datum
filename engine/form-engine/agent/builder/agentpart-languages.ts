/**
 * The `languages` tool's body, in a chunk of its
 * own (`datum-builder-agentpart-languages-*.js`): the descriptor is eager in tools.ts, and
 * `lazyTool` fetches this module on the first call. A factory over the catalogue's
 * `shared`; nothing lives at module scope. A text is what the controller lists
 * (`translatableTexts()`: the tree's, the header and footer's, options' and messages') beside the
 * journeys' and the PDF layouts' that the shell lends, each with the address its translations
 * live at in the definition's map; the tool and the person's workspace agree on what
 * a text is and what a write does because both go through the controller.
 *
 * What the body holds to:
 * - Every change is one form-controller step, so `history`, Undo all and the notice reach it. A
 *   change of the language list goes through the controller's `localizationActions`, which move
 *   the languages and the map together (a removal prunes, Make default swaps the strings and the
 *   map, a rename moves the entries); the tool never calls the plain localization setter, which
 *   neither prunes nor swaps.
 * - The person always wins. A write yields first (an open Form settings draft and the Languages
 *   workspace's typed cells are theirs), and a refusal says whose edit it is.
 * - A form that declares no languages is never given a guessed source language: `add` needs
 *   `sourceLocale`, which is declared first in the same commit (a French form's texts are not
 *   taken for English).
 * - The texts are the author's content. Rows are listed, never followed; a catalog's values are
 *   never returned or written.
 *
 * Guard 15's strings: `source-locale-needed` is spelled here only; the builder
 * catalogue's sentinel tool names and the renderer's write tool name never.
 */
import { effectiveDefaultLocale, languageCodeProblem, languageRenameProblem } from "../../builder/controller/language-edits.js";
import { localeDisplayName, supportedLocaleEntries, supportedLocaleOptions } from "../../core/localization/supported-locales.js";
import { isStale, readCatalogText, readTranslation, sourceHash, type TextAddress } from "../../core/localization/translations.js";
import type { FormDefinition, LocalizationConfiguration } from "../../core/schema/types.js";
import { ToolRefusal, type ToolContext, type ToolData } from "../tool-types.js";
import type { ToolBody } from "../lazy-tool.js";
import type { BuilderController } from "../../builder/controller/builder-controller.js";
import { jsonByteLength } from "../result-caps.js";
import { closestId } from "./outline.js";
import type { BuilderCallScope, BuilderToolsShared } from "./context.js";
import type { BuilderToolHost } from "./host.js";
import type { ItemRefusal, LanguagesAction, LanguagesGroup, LanguagesResult, LanguagesTextEntry, ToolFields } from "./types.js";

type Input = Record<string, unknown>;
type Ctx = ToolContext<BuilderToolHost>;
type Outside = LanguagesResult["outside"];
type Fields = ToolFields<LanguagesResult>;

/** `translate` takes at most this many entries (the schema describes it; the registrar's 512 KB is the byte bound). */
const TRANSLATE_CAP = 500;
/** A `texts` page is cut once it would pass this many bytes of JSON (the result cap is 64 KB of UTF-8, so a Cyrillic or CJK page counts what it weighs). */
const TEXTS_BUDGET = 40_000;
/** `unknown-text` offers at most this many near textIds. */
const SUGGESTION_CAP = 5;
/** The sentence a language result without a better one ends with: every result carries `next`. */
const DEFAULT_NEXT = "languages { action: 'texts', missingOnly: true } lists what is not translated yet.";
/** `texts` shows this many rows when `limit` is left out. */
const TEXTS_DEFAULT_LIMIT = 100;
/** The per-entry refusals a result lists (the rest are counted in a warning). */
const REFUSED_CAP = 50;
/** `unknown-text` looks for near textIds for this many entries only (the search is quadratic); the rest get an empty list. */
const CLOSEST_CAP = 10;
/** The warnings a translate result carries per kind. */
const WARNING_CAP = 10;
/** The bad-input problems a result lists. */
const PROBLEM_CAP = 20;

/** The folded convention's grammar for `languages`. */
const NEEDS: Record<string, readonly string[]> = {
  translate: ["translations"],
  add: ["code"],
  rename: ["code", "to"],
  relabel: ["code", "label"],
  set_default: ["code"],
  preview: ["code"]
};
const READS: Record<string, readonly string[]> = {
  texts: ["language", "missingOnly", "group", "search", "offset", "limit"],
  add: ["label", "sourceLocale"]
};

// ---- refusals (hints exact) ----

type ArgumentProblem = { key: string; expected: string };

function badInput(problems: readonly ArgumentProblem[], message: string): ToolRefusal {
  return new ToolRefusal("bad-input", message, "Fix the arguments listed in details.problems; the tool's inputSchema says what each takes.", { problems: problems.slice(0, PROBLEM_CAP).map((problem) => ({ ...problem })) });
}

function featureOff(feature: string): ToolRefusal {
  return new ToolRefusal("feature-off", `The ${feature} feature is off in this host.`, "This page does not allow that; tell the person instead of retrying.", { feature });
}

function refused(message: string): ToolRefusal {
  const text = message.length > 300 ? `${message.slice(0, 299)}…` : message;
  return new ToolRefusal("refused", text, "Read message; it names the component and the reason. Call get_form if unsure.", { message: text });
}

/** `locale-unsupported` as the renderer spells it (same details), for a code the form does not declare. */
function localeUnsupported(code: string, config: LocalizationConfiguration | undefined): ToolRefusal {
  return new ToolRefusal("locale-unsupported", `The form has no language "${code}".`, "Use one of the form's language codes; languages { action: 'add' } adds one.", {
    locale: code,
    supported: supportedLocaleOptions(config)
  });
}

function invalidLanguageCode(code: string, problem: string): ToolRefusal {
  return new ToolRefusal("invalid-language-code", problem, "Use a code such as 'fr' or 'fr-CA' that the form does not have yet; relabel changes a declared language's name.", { code, problem });
}

function sourceLocaleNeeded(code: string): ToolRefusal {
  return new ToolRefusal(
    "source-locale-needed",
    `The form declares no languages, so adding ${code} would declare its texts as ${code}; nothing was added.`,
    "Say which language the form's texts are written in now with sourceLocale (ask the person, or read the labels with get_form), so they are not taken for " + code + ".",
    { code }
  );
}

function noUi(): ToolRefusal {
  return new ToolRefusal("no-ui", "This builder has no page to show a language on.", "This builder runs without its page; nothing can be shown.", {});
}

// ---- small helpers -------------------------------------------------------------------------

/** The language list's own labels: the stored one, else the language's name. */
function storedLabel(config: LocalizationConfiguration | undefined, code: string): string {
  return supportedLocaleEntries(config).find((entry) => entry.code === code)?.label ?? "";
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** One text as the tool lists it: what the controller (or a designer) listed, with its translations read off the map. */
interface TextRow {
  id: string;
  group: LanguagesGroup;
  componentId: string;
  component: string;
  what: string;
  default: string;
  address: TextAddress;
  /** Whether "where" leads to a component of the form (a tree text, not a journey's or a layout's). */
  inForm: boolean;
  /** The map's own wording per declared language (non-empty entries only). */
  stored: Record<string, string>;
  /** The declared languages whose entry answers an older wording than the text's current one ("Source changed"). */
  stale: string[];
  /** The declared languages the site's catalog fills (its values are never read out). */
  catalog: string[];
}

/** The groups in the order the workspace's rail lists them. */
const GROUP_ORDER: readonly LanguagesGroup[] = ["fields", "options", "messages", "chrome", "journeys", "pdf"];

/** Where a text belongs, as the group filter names it. */
function groupOf(address: TextAddress): LanguagesGroup {
  if (address.kind === "chrome" || address.kind === "journeys" || address.kind === "pdf") {
    return address.kind;
  }
  const first = address.path[0];
  return first === "options" ? "options" : first === "messages" ? "messages" : "fields";
}

/**
 * A text's id for the agent: its group and its address (kind, owner, path), each segment
 * percent-escaped so a value with a slash cannot be mistaken for two. Built from where the text
 * lives (an option by its value, a header part by its id), never from its place in a list, so a
 * reorder or a delete between `texts` and `translate` cannot aim a translation at another text.
 */
function textIdOf(group: LanguagesGroup, address: TextAddress): string {
  const segments = [address.kind, ...(address.owner !== undefined ? [address.owner] : []), ...address.path];
  return `${group}|${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

/** A row's wording in `code`: the map's, else a catalog entry stands in for it (the form shows the catalog's). */
function translatedIn(row: TextRow, code: string): boolean {
  return row.stored[code] !== undefined || row.catalog.includes(code);
}

/** The text of a row in `code` as `resolvedCellText` read it: the map's own, else nothing. */
function storedText(row: TextRow, locale: string, defaultLocale: string): string {
  return locale === defaultLocale ? row.default : (row.stored[locale] ?? "");
}

/** A row's size in a page in UTF-8 bytes (the registrar's cap counts bytes), to cut a `texts` page before the result cap. */
function weigh(entry: LanguagesTextEntry): number {
  return jsonByteLength(entry);
}

/** The `languages` body over one catalogue's shared helpers. */
export function languagesBody(shared: BuilderToolsShared): ToolBody<Input, BuilderToolHost> {
  const host = shared.host;

  /** Rule 4 and 5 of the folded convention; every problem at once. */
  const grammar = (input: Input, action: LanguagesAction): string[] => {
    const check = shared.folded(input, { key: "action", action, needs: NEEDS, reads: READS, always: ["builder", "expectedRevision"] });
    if (check.problems.length > 0) {
      throw badInput(check.problems, `The arguments do not fit languages for action '${action}'.`);
    }
    return check.warnings;
  };

  // ---- reads ----

  /** Every text of the form as the Languages workspace lists it, and the designers it could not reach. */
  const rowsOf = (scope: BuilderCallScope): { rows: TextRow[]; notLoaded: Array<"journeys" | "pdf"> } => {
    const controller = scope.controller;
    const inputs = host.ui?.languageInputs?.();
    const map = controller.translations();
    const catalog = inputs?.catalog;
    const declared = supportedLocaleEntries(controller.localization()).map((entry) => entry.code);
    const defaultLocale = effectiveDefaultLocale(controller.localization());
    const rows: TextRow[] = [];
    const seen = new Set<string>();
    // The tree's texts (the header and footer's, the options' and the messages' among them), then the journeys' and the layouts' the shell lends.
    const listed = [
      ...controller.translatableTexts().map((text) => ({ text, inForm: true })),
      ...(inputs?.extraTexts ?? []).map((text) => ({ text, inForm: false })),
      ...(inputs?.pdfTexts ?? []).map((text) => ({ text, inForm: false }))
    ];
    for (const { text, inForm } of listed) {
      const group = groupOf(text.address);
      const id = textIdOf(group, text.address);
      if (seen.has(id)) {
        continue;
      }
      const stored: Record<string, string> = {};
      const stale: string[] = [];
      const filledByCatalog: string[] = [];
      for (const code of declared) {
        if (code === defaultLocale) {
          continue;
        }
        const entry = readTranslation(map, code, text.address);
        if (entry !== undefined && entry.text !== "") {
          stored[code] = entry.text;
          if (isStale(entry, text.default)) {
            stale.push(code);
          }
        }
        if (catalog !== undefined && readCatalogText(catalog, code, text.address) !== undefined) {
          filledByCatalog.push(code);
        }
      }
      // A text with no wording at all has nothing to translate: it is not listed.
      if (text.default.trim() === "" && Object.keys(stored).length === 0) {
        continue;
      }
      seen.add(id);
      const what = group === "options" ? `Option ${text.label}` : group === "chrome" ? `Header or footer ${text.label}` : text.label;
      rows.push({ id, group, componentId: text.componentId, component: text.componentLabel, what, default: text.default, address: text.address, inForm, stored, stale, catalog: filledByCatalog });
    }
    // The workspace's rail order (fields, options, messages, header and footer, journeys, PDF), the tree's order within each.
    rows.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
    return { rows, notLoaded: inputs?.notLoaded ?? [] };
  };

  /** Whether the journeys' and the PDF layouts' texts are among the rows, absent, or out of reach. */
  const outsideOf = (rows: readonly TextRow[], notLoaded: readonly ("journeys" | "pdf")[]): Outside => {
    let definition: FormDefinition | undefined;
    try {
      definition = host.definition();
    } catch {
      definition = undefined;
    }
    const state = (side: "journeys" | "pdf", has: boolean): Outside["journeys"] =>
      notLoaded.includes(side) ? "not-loaded" : has || rows.some((row) => row.group === side) ? "included" : "none";
    return {
      journeys: state("journeys", (definition?.journey?.journeys?.length ?? 0) > 0),
      pdf: state("pdf", (definition?.pdf?.layouts?.length ?? 0) > 0)
    };
  };

  /** How many texts each declared language says (the default language's is its source). */
  const languagesOf = (config: LocalizationConfiguration | undefined, rows: readonly TextRow[]): LanguagesResult["languages"] => {
    const defaultLocale = effectiveDefaultLocale(config);
    const options = supportedLocaleOptions(config);
    return options.map((entry) => {
      const isDefault = entry.code === defaultLocale;
      const translated = isDefault ? rows.filter((row) => row.default.trim().length > 0).length : rows.filter((row) => translatedIn(row, entry.code)).length;
      return { code: entry.code, label: entry.label, isDefault, translated, total: rows.length };
    });
  };

  /** The fields every result carries: the languages as they are committed now. */
  const baseOf = (scope: BuilderCallScope, action: LanguagesAction, changed: boolean, known?: ReturnType<typeof rowsOf>): Fields => {
    const controller = scope.controller;
    const config = controller.localization();
    const { rows, notLoaded } = known ?? rowsOf(scope);
    const result: Fields = {
      action,
      changed,
      declared: supportedLocaleEntries(config).length > 0,
      defaultLanguage: effectiveDefaultLocale(config),
      previewLanguage: controller.currentLocale(),
      languages: languagesOf(config, rows),
      outside: outsideOf(rows, notLoaded)
    };
    const since = controller.localeChangesSinceSave();
    if (since.removed.length > 0 || since.renamed.length > 0 || action === "add" || action === "rename" || action === "relabel" || action === "set_default") {
      result.changedSinceSave = { removed: [...since.removed], renamed: since.renamed.map((entry) => ({ ...entry })) };
    }
    return result;
  };

  const list = (scope: BuilderCallScope): Fields => {
    const result = baseOf(scope, "list", false);
    result.next = result.declared
      ? ["languages { action: 'texts', missingOnly: true } lists what is not translated yet."]
      : ["languages { action: 'add', code, sourceLocale } declares the form's language and a new one."];
    return result;
  };

  const texts = (scope: BuilderCallScope, input: Input): Fields => {
    const controller = scope.controller;
    const config = controller.localization();
    const defaultLocale = effectiveDefaultLocale(config);
    const declared = supportedLocaleEntries(config).map((entry) => entry.code);
    const language = typeof input.language === "string" && input.language !== "" ? input.language : undefined;
    if (language !== undefined && !declared.includes(language)) {
      throw localeUnsupported(language, config);
    }
    const known = rowsOf(scope);
    // The search reads the component, what the text is, its source and every wording; "missing"
    // is judged per language, because the default language has no translation cell of its own
    // (its text is the row's source, and a row with none is not listed at all).
    const needle = typeof input.search === "string" ? input.search.trim().toLowerCase() : "";
    const group = typeof input.group === "string" && input.group !== "" && input.group !== "all" ? input.group : undefined;
    const filtered = known.rows.filter(
      (row) =>
        (group === undefined || row.group === group) &&
        (needle === "" || [row.component, row.what, row.default, ...Object.values(row.stored)].some((text) => text.toLowerCase().includes(needle)))
    );
    const asked = language !== undefined ? [language] : declared;
    const matching =
      input.missingOnly === true
        ? filtered.filter((row) => asked.some((code) => (code === defaultLocale ? row.default.trim().length === 0 : !translatedIn(row, code))))
        : filtered;
    const offset = typeof input.offset === "number" ? Math.max(0, Math.trunc(input.offset)) : 0;
    const limit = typeof input.limit === "number" ? Math.max(1, Math.min(TEXTS_DEFAULT_LIMIT * 5, Math.trunc(input.limit))) : TEXTS_DEFAULT_LIMIT;
    const page: LanguagesTextEntry[] = [];
    let weight = 0;
    let at = offset;
    for (; at < matching.length && page.length < limit; at += 1) {
      const row = matching[at] as TextRow;
      const stale = language !== undefined ? row.stale.filter((code) => code === language) : row.stale;
      const entry: LanguagesTextEntry = {
        textId: row.id,
        group: row.group,
        componentId: row.componentId,
        component: row.component,
        what: row.what,
        source: row.default,
        translations: language !== undefined ? (Object.hasOwn(row.stored, language) ? { [language]: row.stored[language] as string } : {}) : { ...row.stored },
        ...(stale.length > 0 ? { stale } : {}),
        ...(row.catalog.length > 0 ? { catalog: [...row.catalog] } : {}),
        writable: true
      };
      const size = weigh(entry);
      if (page.length > 0 && weight + size > TEXTS_BUDGET) {
        break;
      }
      weight += size;
      page.push(entry);
    }
    const result = baseOf(scope, "texts", false, known);
    result.texts = page;
    result.textCount = matching.length;
    if (at < matching.length) {
      result.truncated = true;
      result.nextOffset = at;
      result.next = [`Call again with offset: ${at}.`];
    } else {
      result.next = ["Write translations with languages { action: 'translate' } by textId and language."];
    }
    return result;
  };

  // ---- writes ----

  /** The write guards every changing action shares: the feature, then the person's state. */
  const guardWrite = (scope: BuilderCallScope, features: readonly ("languages" | "translations")[] = ["languages"]): void => {
    if (!features.some((feature) => host.featureOn(feature))) {
      throw featureOff(features[0] as string);
    }
    shared.yieldToPerson(scope, "languages");
  };

  /**
   * Runs a language-list change through the controller's actions: one history step that moves the
   * languages and the map together (a removal prunes, Make default swaps, a rename moves entries,
   * the designers' strings follow). A refusal leaves nothing behind.
   */
  const runLanguages = (scope: BuilderCallScope, run: (actions: BuilderController["localizationActions"]) => boolean, failure: string): number => {
    let ran = false;
    let steps = 0;
    try {
      steps = shared.write(scope, () => {
        ran = run(scope.controller.localizationActions);
      }).steps;
    } catch (error) {
      throw refused(error instanceof Error ? error.message : failure);
    }
    if (!ran) {
      throw refused(`${failure}; nothing was changed.`);
    }
    return steps;
  };

  /** What a language-list write shows the person and says back. */
  const finish = (scope: BuilderCallScope, action: LanguagesAction, steps: number, extra: Partial<Fields>): Fields => {
    const shown = shared.show(scope, { ids: [], announce: scope.words.text("agent.did.language"), undoSteps: steps });
    return {
      ...baseOf(scope, action, true),
      ...extra,
      ...shared.payload(scope, steps, shown),
      next: extra.next ?? [DEFAULT_NEXT]
    };
  };

  /** A write that found nothing to change: `changed: false`, no step, no notice. */
  const unchanged = (scope: BuilderCallScope, action: LanguagesAction, extra: Partial<Fields> = {}): Fields => ({
    ...baseOf(scope, action, false),
    ...extra,
    next: extra.next ?? [DEFAULT_NEXT]
  });

  const add = (scope: BuilderCallScope, input: Input): Fields => {
    guardWrite(scope);
    const controller = scope.controller;
    const committed = controller.localization();
    const entries = supportedLocaleEntries(committed);
    const code = trimmed(input.code);
    const label = typeof input.label === "string" ? input.label.trim() : undefined;
    const warnings: string[] = [];
    // A code the form declares already, under the same label, is a no-op, judged before
    // the grammar check (which refuses every declared code).
    const present = entries.find((entry) => entry.code.toLowerCase() === code.toLowerCase());
    if (present !== undefined) {
      const sameLabel = label === undefined || label === "" || label === (present.label ?? "") || label === (present.label ?? localeDisplayName(present.code));
      if (present.code === code && sameLabel) {
        return unchanged(scope, "add");
      }
      throw invalidLanguageCode(
        code,
        present.code === code
          ? `"${code}" is already one of the form's languages under another name; relabel changes the name.`
          : `"${code}" is already one of the form's languages as "${present.code}"; use that code.`
      );
    }
    const problem = languageCodeProblem(code, committed);
    if (problem !== undefined) {
      throw invalidLanguageCode(code, problem);
    }
    const added: string[] = [];
    const note: string[] = [];
    let sourceLocale: string | undefined;
    if (entries.length === 0) {
      const source = trimmed(input.sourceLocale);
      if (source === "") {
        throw sourceLocaleNeeded(code);
      }
      const sourceProblem = languageCodeProblem(source, undefined);
      if (sourceProblem !== undefined) {
        throw invalidLanguageCode(source, sourceProblem);
      }
      if (source.toLowerCase() === code.toLowerCase()) {
        // The one language the texts are written in: declared alone (with its label when given).
        added.push(code);
      } else {
        // The source first, so it stays the default and the texts already written stay its own.
        sourceLocale = source;
        added.push(source, code);
        const name = localeDisplayName(source);
        note.push(`The form declared no languages: ${name} (${source}), the language its texts are written in, was declared first.`);
      }
    } else {
      added.push(code);
      if (typeof input.sourceLocale === "string") {
        warnings.push("ignored argument for action 'add': sourceLocale (the form already declares its languages)");
      }
    }
    const steps = runLanguages(scope, (actions) => actions.addLocale(code, label ?? "", sourceLocale !== undefined ? { sourceLocale } : undefined), "The builder did not add the language");
    const result = finish(scope, "add", steps, {
      added,
      ...(note.length > 0 ? { note } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      next: [`languages { action: 'texts', language: '${code}', missingOnly: true } lists what to translate.`, "Write them with languages { action: 'translate' }."]
    });
    return result;
  };

  const rename = (scope: BuilderCallScope, input: Input): Fields => {
    guardWrite(scope);
    const controller = scope.controller;
    const committed = controller.localization();
    const code = trimmed(input.code);
    const to = trimmed(input.to);
    if (!supportedLocaleEntries(committed).some((entry) => entry.code === code)) {
      throw localeUnsupported(code, committed);
    }
    if (to === code) {
      return unchanged(scope, "rename");
    }
    const problem = languageRenameProblem(code, to, committed);
    if (problem !== undefined) {
      throw invalidLanguageCode(to, problem);
    }
    // The designers that are not on the page keep their texts under the old code (the shell lends
    // outside documents only from loaded modes), as `set_default` says for the old source wording.
    // The translations of the journeys and the layouts are the map's, so they move with the rest; a
    // layout's own document language is its block's, so an unloaded PDF side keeps the old code.
    const warnings = rowsOf(scope).notLoaded.filter((side) => side === "pdf").map(() => `outside-not-renamed: the PDF layouts are not loaded, so their document language keeps the code ${code}.`);
    const steps = runLanguages(scope, (actions) => actions.renameLocale(code, to), "The builder did not rename the language");
    return finish(
      scope,
      "rename",
      steps,
      { ...(warnings.length > 0 ? { warnings } : {}), next: [`The texts written in ${code} now belong to ${to}; languages { action: 'texts', language: '${to}' } lists them.`] }
    );
  };

  const relabel = (scope: BuilderCallScope, input: Input): Fields => {
    guardWrite(scope);
    const committed = scope.controller.localization();
    const code = trimmed(input.code);
    const label = trimmed(input.label);
    if (!supportedLocaleEntries(committed).some((entry) => entry.code === code)) {
      throw localeUnsupported(code, committed);
    }
    if (storedLabel(committed, code) === label) {
      return unchanged(scope, "relabel");
    }
    return finish(scope, "relabel", runLanguages(scope, (actions) => actions.relabelLocale(code, label), "The builder did not relabel the language"), {});
  };

  const setDefault = (scope: BuilderCallScope, input: Input): Fields => {
    guardWrite(scope);
    const committed = scope.controller.localization();
    const code = trimmed(input.code);
    if (!supportedLocaleEntries(committed).some((entry) => entry.code === code)) {
      throw localeUnsupported(code, committed);
    }
    // Judged on the default the form reads (a form that declares languages and no
    // `defaultLocale` reads the first as its default, as `list` reports it).
    if (effectiveDefaultLocale(committed) === code) {
      return unchanged(scope, "set_default");
    }
    // Counted before the write: the texts whose wording becomes the source ones.
    const known = rowsOf(scope);
    const promotedTexts = known.rows.filter((row) => row.stored[code] !== undefined).length;
    const warnings = known.notLoaded.map((side) => `outside-not-swapped: the ${side === "journeys" ? "journeys" : "PDF layouts"} are not loaded, so their texts keep the old source wording.`);
    const steps = runLanguages(scope, (actions) => actions.makeDefaultLocale(code), "The builder did not change the default language");
    return finish(
      scope,
      "set_default",
      steps,
      {
        promotedTexts,
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(promotedTexts > 0 ? { next: [`Tell the person ${promotedTexts} texts now read in ${code} as their source wording.`] } : {})
      }
    );
  };

  const preview = (scope: BuilderCallScope, input: Input): Fields => {
    const controller = scope.controller;
    const config = controller.localization();
    const code = trimmed(input.code);
    if (!supportedLocaleEntries(config).some((entry) => entry.code === code)) {
      throw localeUnsupported(code, config);
    }
    const ui = host.ui;
    if (ui?.setPreviewLocale === undefined) {
      throw noUi();
    }
    // No step and no revision: the canvas shows another language; the form is as it was.
    ui.setPreviewLocale(code);
    const result = baseOf(scope, "preview", false);
    result.next = [`The person sees the form in ${code}; preview the default language again when you are done.`];
    return result;
  };

  const translate = (scope: BuilderCallScope, input: Input): Fields => {
    const entries = Array.isArray(input.translations) ? (input.translations as unknown[]) : [];
    const problems: ArgumentProblem[] = [];
    if (entries.length > TRANSLATE_CAP) {
      problems.push({ key: "translations", expected: `at most ${TRANSLATE_CAP} entries per call` });
    }
    entries.slice(0, TRANSLATE_CAP).forEach((entry, index) => {
      const item = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      for (const key of ["textId", "language", "text"]) {
        if (typeof item[key] !== "string") {
          problems.push({ key: `translations[${index}].${key}`, expected: "required for action 'translate'" });
        }
      }
    });
    if (problems.length > 0) {
      throw badInput(problems, "The arguments do not fit languages for action 'translate'.");
    }
    guardWrite(scope, ["languages", "translations"]);
    const controller = scope.controller;
    const config = controller.localization();
    const declared = supportedLocaleEntries(config).map((entry) => entry.code);
    const defaultLocale = effectiveDefaultLocale(config);
    const known = rowsOf(scope);
    const byId = new Map(known.rows.map((row) => [row.id, row]));
    const pending: Array<{ locale: string; address: TextAddress; text: string; row: TextRow; /** The wording the translation answers, when it is not the current default: the entry is written stale. */ answers?: string }> = [];
    const writtenKeys = new Set<string>();
    const written: Array<{ textId: string; language: string }> = [];
    const refusals: Array<ItemRefusal & { textId: string; language: string }> = [];
    const warnings: string[] = [];
    let unchangedCount = 0;
    let suggestionsLooked = 0;
    // Near ids by edit distance, nearest first (outline.ts ranks one at a time, so the nearest is
    // taken out and asked again); the search is quadratic, so only the first entries get one.
    const suggest = (textId: string): string[] => {
      if (suggestionsLooked >= CLOSEST_CAP) {
        return [];
      }
      suggestionsLooked += 1;
      const rest = [...byId.keys()];
      const found: string[] = [];
      while (found.length < SUGGESTION_CAP) {
        const next = closestId(rest, textId);
        if (next === undefined) {
          break;
        }
        found.push(next);
        rest.splice(rest.indexOf(next), 1);
      }
      return found;
    };
    const warn = (text: string): void => {
      if (warnings.length < WARNING_CAP) {
        warnings.push(text);
      }
    };
    const refuse = (textId: string, language: string, code: string, message: string, hint: string, details?: Record<string, unknown>): void => {
      refusals.push({ textId, language, code, message, hint, ...(details !== undefined ? { details } : {}) });
    };
    for (const raw of entries as Array<{ textId: string; language: string; text: string; source?: unknown }>) {
      const { textId, language } = raw;
      const row = byId.get(textId);
      if (row === undefined) {
        const side = textId.startsWith("journeys|") ? "journeys" : textId.startsWith("pdf|") ? "pdf" : undefined;
        if (side !== undefined && known.notLoaded.includes(side)) {
          // The side's own state passes through: "off" and "hidden" never load, so they are
          // not told to retry; anything else that is not "failed" (or ready) is still loading.
          const reported = side === "journeys" ? host.ui?.journeys?.().state : host.ui?.pdfLayouts?.().state;
          const state = reported === "failed" || reported === "off" || reported === "hidden" ? reported : "loading";
          const never = state === "off" || state === "hidden";
          const noun = side === "journeys" ? "journeys" : "PDF layouts";
          refuse(
            textId,
            language,
            "chunk-unavailable",
            never ? `This page does not show the ${noun}, so their texts cannot be written.` : `The ${side === "journeys" ? "journey" : "PDF layout"} designer is not loaded, so its texts cannot be written yet.`,
            never
              ? `This page does not show the ${noun}; tell the person.`
              : state === "failed"
                ? "Try once more; if it fails again the host removed that file: tell the person."
                : "That part of the builder is still loading; call again in a moment.",
            { what: side, state }
          );
          continue;
        }
        refuse(textId, language, "unknown-text", `No text has the id "${textId}".`, "Use a textId from languages { action: 'texts' }; ids change after renames and edits.", { textId, suggestions: suggest(textId) });
        continue;
      }
      if (!declared.includes(language)) {
        refuse(textId, language, "locale-unsupported", `The form has no language "${language}".`, "Use one of the form's language codes; languages { action: 'add' } adds one.", { locale: language, supported: supportedLocaleOptions(config) });
        continue;
      }
      if (language === defaultLocale) {
        // The default language's wording is the text itself: it is edited as the property, never as a translation.
        refuse(textId, language, "default-language", `${language} is the form's default language: its wording is the text itself.`, "Change the source text with set_properties; translations are for the other languages.", { language, source: row.default });
        continue;
      }
      const text = raw.text.trim();
      // A `source` that is not the text's current wording says the translation answers an older one (the text changed since `texts`): it is kept, flagged stale.
      const answers = typeof raw.source === "string" && raw.source !== row.default && text !== "" ? raw.source : undefined;
      // The same wording on a stale entry is a confirmation ("this still reads right"), and is written: it makes the entry current.
      if (answers === undefined && storedText(row, language, defaultLocale).trim() === text && !row.stale.includes(language)) {
        unchangedCount += 1;
        continue;
      }
      if (row.catalog.includes(language)) {
        warn(`${textId}: the site's catalog fills ${language}, so the form shows the catalog's wording instead of what was written`);
      }
      pending.push({ locale: language, address: row.address, text, row, ...(answers !== undefined ? { answers } : {}) });
      const key = `${textId}\u0000${language}`;
      if (!writtenKeys.has(key)) {
        writtenKeys.add(key);
        written.push({ textId, language });
      }
    }
    const listed = refusals.slice(0, REFUSED_CAP);
    if (refusals.length > REFUSED_CAP) {
      warnings.push(`${refusals.length - REFUSED_CAP} more entries were refused and are not listed`);
    }
    if (pending.length === 0) {
      if (refusals.length > 0) {
        throw new ToolRefusal("nothing-written", "Every translation was refused; nothing was written.", "See each refusal's hint.", { refused: listed });
      }
      return unchanged(scope, "translate", {
        written: [],
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(unchangedCount > 0 ? { note: ["Every text already says that; nothing was changed."] } : {})
      });
    }
    // Catalog values are never written. One `setTranslations`: the form's texts and the designers'
    // in one entry, as the workspace's own Apply writes them.
    let steps = 0;
    try {
      // An entry that answers an older wording carries that wording's fingerprint, so it is stored flagged stale.
      steps = shared.write(scope, () =>
        controller.setTranslations(pending.map(({ locale, address, text, answers }) => ({ locale, address, text, ...(answers !== undefined ? { source: sourceHash(answers) } : {}) })))
      ).steps;
    } catch (error) {
      throw refused(error instanceof Error ? error.message : "The builder did not write the translations.");
    }
    if (steps === 0) {
      return unchanged(scope, "translate", { written: [], ...(listed.length > 0 ? { refused: listed } : {}), ...(warnings.length > 0 ? { warnings } : {}), note: ["The builder found nothing to change; nothing was written."] });
    }
    const rootId = controller.rootId();
    const ids = [...new Set(written.map(({ textId }) => byId.get(textId)).filter((row): row is TextRow => row !== undefined && row.inForm && row.componentId !== rootId).map((row) => row.componentId))];
    const shown = shared.show(scope, { ids, announce: scope.words.plural("agent.did.translate", written.length, { count: written.length }), undoSteps: steps });
    const payload = shared.payload(scope, steps, shown);
    return {
      ...baseOf(scope, "translate", true),
      written,
      ...(listed.length > 0 ? { refused: listed } : {}),
      ...payload,
      ...(warnings.length > 0 ? { warnings } : {}),
      next: ["languages { action: 'preview', code } shows the person the form in that language."]
    };
  };

  return {
    run(input: Input, ctx: Ctx): ToolData {
      const action = input.action as LanguagesAction;
      const warnings = grammar(input, action);
      const scope = shared.scope(ctx);
      let result: Fields;
      switch (action) {
        case "list":
          result = list(scope);
          break;
        case "texts":
          result = texts(scope, input);
          break;
        case "translate":
          result = translate(scope, input);
          break;
        case "add":
          result = add(scope, input);
          break;
        case "rename":
          result = rename(scope, input);
          break;
        case "relabel":
          result = relabel(scope, input);
          break;
        case "set_default":
          result = setDefault(scope, input);
          break;
        default:
          result = preview(scope, input);
      }
      const own = result.warnings ?? [];
      const all = [...warnings, ...own];
      return { ...result, ...(all.length > 0 ? { warnings: all } : {}) } as unknown as ToolData;
    }
  };
}
