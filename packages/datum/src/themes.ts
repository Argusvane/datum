import {
  BuilderThemeRegistry,
  DATUM_DARK_BUILDER_THEME,
  DEFAULT_PDF_THEME,
  PLAIN_PDF_THEME,
  PdfThemeRegistry,
  pdfThemeLookup,
  resolveLocalizedText,
  type BuilderThemeDefinition,
  type FormPlugin,
  type PdfThemeDefinition,
  type PdfThemeLookup
} from "@argusvane/datum-engine";

import { plugins as sharedPlugins } from "./plugins.js";

/**
 * The builder-shell and PDF themes a page can name by id on `<datum-form-builder theme>` and
 * `<datum-form pdf-theme>` / `<datum-form-builder pdf-theme>`: two registries the host fills.
 * The bundles carry the engine's own and nothing else:
 *
 *     import { builderThemes, pdfThemes } from "@argusvane/datum";
 *     builderThemes.register(acmeBuilderTheme);
 *     pdfThemes.register(acmePdfTheme);
 *
 * The form itself is drawn by a design-system binding (`bindings.register`), not by a theme. The
 * registries are one object per page, shared across the bundles through a global, so a host
 * registers once wherever it loads them from. A theme object is accepted everywhere an id is,
 * for a host that builds a theme of its own. A theme a plugin carries arrives here through the
 * page's plugin registry too (`plugins.register`), so a plugin that carries themes
 * and components is registered once.
 */

/** A PDF theme as `<datum-form pdf-theme>` names it: a registered id, or a `"pdf"`-target object. */
export type PdfThemeInput = string | PdfThemeDefinition | null | undefined;

/** A builder-shell theme as `<datum-form-builder theme>` names it: a registered id, or a theme object. */
export type BuilderThemeInput = string | BuilderThemeDefinition | null | undefined;

/** Any theme the combined registry holds, by the registry its target names. */
export type RegisteredTheme = BuilderThemeDefinition | PdfThemeDefinition;

export const DEFAULT_PDF_THEME_ID = "default";
export const DEFAULT_BUILDER_THEME_ID = "default";

export type PdfThemeChoice = { id: string; label: string; theme: PdfThemeDefinition };

type ThemePlugin = Pick<FormPlugin, "builderThemes" | "pdfThemes">;

/** What `builderThemes.register` takes: a builder theme, a plugin (its `builderThemes`), or a list of either. */
export type BuilderThemeRegistration =
  | BuilderThemeDefinition
  | Pick<FormPlugin, "builderThemes">
  | ReadonlyArray<BuilderThemeDefinition | Pick<FormPlugin, "builderThemes">>;

/** What `pdfThemes.register` takes: a PDF theme, a plugin (its `pdfThemes`), or a list of either. */
export type PdfThemeRegistration = PdfThemeDefinition | Pick<FormPlugin, "pdfThemes"> | ReadonlyArray<PdfThemeDefinition | Pick<FormPlugin, "pdfThemes">>;

export interface RegisterThemesOptions {
  /**
   * Where the page serves the themes' assets (`assets.stylesheets` and `assets.fonts`, relative
   * hrefs): the URL of the directory the host copied the package's `fonts/` into.
   */
  assetsBase?: string | undefined;
  /** Further ids that name a registered theme: `{ dark: "acme-dark" }`. */
  aliases?: Readonly<Record<string, string>> | undefined;
}

/** The page's builder-shell themes (`themes.builder`, exported as `builderThemes`). */
export interface DatumBuilderThemeRegistry {
  /** The engine registry underneath. */
  readonly engine: BuilderThemeRegistry;
  /** Registers builder themes; one already registered (same id and version) is skipped, never an error. */
  register(input: BuilderThemeRegistration, options?: RegisterThemesOptions): DatumBuilderThemeRegistry;
  /** Every registered builder theme, the latest version of each id, in registration order. */
  list(): BuilderThemeDefinition[];
  /** Called after every theme registration, of any kind; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

/** The page's PDF themes (`themes.pdf`, exported as `pdfThemes`). */
export interface DatumPdfThemeRegistry {
  /** The engine registry underneath. */
  readonly engine: PdfThemeRegistry;
  /** Registers PDF themes; one already registered (same id and version) is skipped, never an error. */
  register(input: PdfThemeRegistration, options?: RegisterThemesOptions): DatumPdfThemeRegistry;
  /** Every registered PDF theme, the latest version of each id, in registration order. */
  list(): PdfThemeDefinition[];
  /** Called after every theme registration, of any kind; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

export interface DatumThemeRegistry {
  /** The builder-shell themes. */
  readonly builder: DatumBuilderThemeRegistry;
  /** The PDF themes. */
  readonly pdf: DatumPdfThemeRegistry;
  pdfThemes(): PdfThemeDefinition[];
  builderThemes(): BuilderThemeDefinition[];
  /** The PDF theme picker's entries: the engine's default answers to `"default"`, the rest to their ids. */
  pdfOptions(): PdfThemeChoice[];
  /** A PDF theme by id or alias, or a theme object passed through; empty means the engine's default. Unknown ids throw. */
  resolvePdf(input: PdfThemeInput): PdfThemeDefinition;
  /** A builder-shell theme by id or alias; empty or `"default"` is `undefined` (the shell's built-in look). Unknown ids throw. */
  resolveBuilder(input: BuilderThemeInput): BuilderThemeDefinition | undefined;
  /** The lookup a layout's `theme` id resolves through: a registered PDF theme. */
  readonly pdfLookup: PdfThemeLookup;
  /** The base a theme's relative asset hrefs resolve against, when its registration gave one. */
  assetsBase(theme: RegisteredTheme | undefined): string | undefined;
  /** Called after every registration; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

function isPluginWith(input: unknown, slot: string): boolean {
  return !!input && typeof input === "object" && slot in input && Array.isArray((input as Record<string, unknown>)[slot]);
}

function isTheme(input: unknown): input is RegisteredTheme {
  // By what every theme has (an id, a version, a target), not by its tokens: a PDF theme will have none.
  const theme = input as { id?: unknown; version?: unknown; target?: unknown } | null | undefined;
  return !!theme && typeof theme === "object" && typeof theme.id === "string" && typeof theme.version === "string" && typeof theme.target === "string";
}

/** How a picker names a theme: its label in English, else its id. */
function themeLabel(theme: RegisteredTheme): string {
  const label = resolveLocalizedText(theme.label, "en");
  return label && label.trim().length > 0 ? label : theme.id;
}

export function createThemeRegistry(): DatumThemeRegistry {
  const builderEngine = new BuilderThemeRegistry();
  const pdfEngine = new PdfThemeRegistry();
  const bases = new Map<string, string>();
  const aliases = new Map<string, string>();
  const listeners = new Set<() => void>();

  const remember = (theme: RegisteredTheme, assetsBase: string | undefined): void => {
    // A base named for a theme already registered still lands: a page that loads a bundle
    // and then says where it serves the fonts is heard.
    if (assetsBase) {
      bases.set(`${theme.id}:${theme.target}`, assetsBase);
    }
  };
  const addBuilder = (theme: BuilderThemeDefinition, assetsBase: string | undefined): void => {
    remember(theme, assetsBase);
    if (!builderEngine.has(theme.id, theme.version)) {
      builderEngine.register(theme);
    }
  };
  const addPdf = (theme: PdfThemeDefinition, assetsBase: string | undefined): void => {
    remember(theme, assetsBase);
    if (!pdfEngine.has(theme.id, theme.version)) {
      pdfEngine.register(theme);
    }
  };
  const finish = (options: RegisterThemesOptions): void => {
    for (const [alias, id] of Object.entries(options.aliases ?? {})) {
      aliases.set(alias, id);
    }
    for (const listener of listeners) {
      listener();
    }
  };
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  // The builder and PDF registries: each takes its own themes, or a plugin's slot of them, alone.
  const sub = <Theme extends RegisteredTheme, Engine extends { list(): Theme[] }>(
    engine: Engine,
    slot: "builderThemes" | "pdfThemes",
    addOne: (theme: Theme, assetsBase: string | undefined) => void
  ) => {
    const view = {
      engine,
      register(input: unknown, options: RegisterThemesOptions = {}) {
        const items: unknown[] = Array.isArray(input) ? input : [input];
        // Refused before any is taken up, so a list with one wrong entry registers nothing.
        for (const item of items) {
          if (!isPluginWith(item, slot) && !isTheme(item)) {
            throw new Error(`${slot}.register takes a theme (an id, a version and a target) or a plugin with a ${slot} list`);
          }
        }
        for (const item of items) {
          if (isPluginWith(item, slot)) {
            for (const theme of ((item as ThemePlugin)[slot] ?? []) as unknown as Theme[]) {
              addOne(theme, options.assetsBase);
            }
          } else {
            addOne(item as Theme, options.assetsBase);
          }
        }
        finish(options);
        return view;
      },
      list: () => engine.list(),
      subscribe
    };
    return view;
  };
  const builder = sub(builderEngine, "builderThemes", addBuilder) as DatumBuilderThemeRegistry;
  const pdf = sub(pdfEngine, "pdfThemes", addPdf) as DatumPdfThemeRegistry;

  const pdfLookup = pdfThemeLookup(pdfEngine)!;

  const registry: DatumThemeRegistry = {
    builder,
    pdf,
    pdfThemes: () => pdfEngine.list(),
    builderThemes: () => builderEngine.list(),
    pdfOptions: () =>
      pdfEngine.list().map((theme) => ({ id: theme.id === DEFAULT_PDF_THEME.id ? DEFAULT_PDF_THEME_ID : theme.id, label: themeLabel(theme), theme })),
    resolvePdf(input) {
      if (input && typeof input === "object") {
        return input;
      }
      const id = (input ?? "").trim();
      if (id === "" || id === DEFAULT_PDF_THEME_ID || id === DEFAULT_PDF_THEME.id) {
        return pdfEngine.has(DEFAULT_PDF_THEME.id) ? pdfEngine.resolve(DEFAULT_PDF_THEME.id) : DEFAULT_PDF_THEME;
      }
      const found = pdfLookup(id) ?? (aliases.has(id) ? pdfLookup(aliases.get(id)!) : undefined);
      if (found) {
        return found;
      }
      throw new Error(
        `Unknown PDF theme "${id}": register its package (pdfThemes.register(...)) or use one of ${registry
          .pdfOptions()
          .map((entry) => `"${entry.id}"`)
          .join(", ")}, or pass a theme object`
      );
    },
    resolveBuilder(input) {
      if (input && typeof input === "object") {
        return input;
      }
      const id = (input ?? "").trim();
      if (id === "" || id === DEFAULT_BUILDER_THEME_ID) {
        return undefined;
      }
      for (const candidate of [id, aliases.get(id)]) {
        if (candidate && builderEngine.has(candidate)) {
          return builderEngine.resolve(candidate);
        }
      }
      throw new Error(
        `Unknown builder theme "${id}": register it (builderThemes.register(...)), use "${DEFAULT_BUILDER_THEME_ID}" for the built-in look${[
          ...builderEngine.list().map((theme) => `, "${theme.id}"`)
        ].join("")}, or pass a theme object`
      );
    },
    pdfLookup: (id) => pdfLookup(id === DEFAULT_PDF_THEME_ID ? DEFAULT_PDF_THEME.id : id),
    assetsBase(theme) {
      return theme ? bases.get(`${theme.id}:${theme.target}`) : undefined;
    },
    subscribe
  };

  // The engine's own themes are always there: the engine's PDF theme and the plain record it
  // drew before. The builder has one built-in look and its dark
  // palette as a builder theme, so a page can name it (theme="datum-dark") as the ⋮ menu's
  // switch does.
  builder.register(DATUM_DARK_BUILDER_THEME);
  pdf.register([DEFAULT_PDF_THEME, PLAIN_PDF_THEME]);
  return registry;
}

const SHARED = Symbol.for("datum.web-components.themes");

/**
 * The page's theme registry, one per page however many bundles are loaded: `datum-form.js` and
 * `datum-builder.js` reach the same object through a global.
 */
export const themes: DatumThemeRegistry = ((globalThis as Record<symbol, unknown>)[SHARED] as DatumThemeRegistry | undefined) ?? createThemeRegistry();
(globalThis as Record<symbol, unknown>)[SHARED] = themes;

/**
 * The page's builder-shell themes (the shared registry's `builder`):
 *
 *     import { builderThemes } from "@argusvane/datum";
 *     builderThemes.register(acmeBuilderTheme);
 *
 * and `<datum-form-builder theme="acme">` finds it.
 */
export const builderThemes: DatumBuilderThemeRegistry = themes.builder;

/**
 * The page's PDF themes (the shared registry's `pdf`): `pdfThemes.register(acmePdfTheme)`, and a
 * layout's `theme`, `<datum-form pdf-theme>` and the builder's PDF theme picker find it.
 */
export const pdfThemes: DatumPdfThemeRegistry = themes.pdf;

// The themes the page's plugins carry: those registered before this module
// loaded, and every one registered after, under the options they came with. The plugin
// registry never imports this module, so a bundle that only registers a plugin
// (a component library's) carries no theme code; this side does the forwarding.
let forwardedRegistrations = 0;
function forwardPluginThemes(): void {
  const registrations = sharedPlugins.registrations();
  while (forwardedRegistrations < registrations.length) {
    // Counted before it is tried: a plugin whose themes cannot be taken up is reported once
    // and does not hold back the plugins registered after it.
    const { plugin, options } = registrations[forwardedRegistrations]!;
    forwardedRegistrations += 1;
    try {
      if ((plugin.builderThemes?.length ?? 0) > 0) {
        builderThemes.register(plugin, options);
      }
      if ((plugin.pdfThemes?.length ?? 0) > 0) {
        pdfThemes.register(plugin, options);
      }
    } catch (error) {
      console.error(`[datum] The themes of plugin "${plugin.id}" were not registered: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
forwardPluginThemes();
sharedPlugins.subscribe(forwardPluginThemes);

// --- The catalogue as lists, for the pages and hosts that read it that way -----------------
// Live views over the shared registry, refreshed on every registration. Prefer the
// registry's own methods (`themes.pdfOptions()`) in new code.

export const PDF_THEMES: PdfThemeDefinition[] = [];
export const PDF_THEME_OPTIONS: PdfThemeChoice[] = [];
export const BUILDER_THEMES: BuilderThemeDefinition[] = [];

function refreshLists(): void {
  PDF_THEMES.splice(0, PDF_THEMES.length, ...themes.pdfThemes());
  PDF_THEME_OPTIONS.splice(0, PDF_THEME_OPTIONS.length, ...themes.pdfOptions());
  BUILDER_THEMES.splice(0, BUILDER_THEMES.length, ...themes.builderThemes());
}
refreshLists();
themes.subscribe(refreshLists);

/** A PDF theme by id, or a theme object passed through (`themes.resolvePdf`). */
export function resolvePdfThemeInput(input: PdfThemeInput): PdfThemeDefinition {
  return themes.resolvePdf(input);
}

/** A builder-shell theme by id, or a theme object passed through (`themes.resolveBuilder`). */
export function resolveBuilderTheme(input: BuilderThemeInput): BuilderThemeDefinition | undefined {
  return themes.resolveBuilder(input);
}
