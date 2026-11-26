import type { LocalizedText, ThemeAssets, ThemeSource } from "../../core/schema/contracts.js";
import { VersionedThemeRegistry } from "../../registry/versioned-theme-registry.js";

/*
 * A leaf module with no side effects: the renderer bundle registers the dark builder theme
 * (studio-dark-theme.ts) through the web components' theme registry, so this must not pull in
 * any of the builder's own code.
 */

/**
 * A theme for the builder shell itself: the studio look's `--db-*` tokens, applied as custom
 * properties on the builder's wrapper and its panels (`<datum-form-builder theme>`). It says
 * nothing about the form the canvas previews, which draws under its own form look.
 */
export interface BuilderThemeDefinition {
  id: string;
  version: string;
  target: "builder";
  /**
   * The id of a registered builder theme this one builds on. The registry resolves it at
   * registration (the base must already be registered) and stores the merged definition: this
   * theme's `tokens` over the base's, and its other fields where set, else the base's.
   */
  extends?: string;
  /** How a picker names the theme; the id stands in when absent. */
  label?: LocalizedText;
  /** Studio token name (`db-surface`, with or without the `--`) → value. */
  tokens: Record<string, string>;
  /** Stylesheets or fonts the shell's look needs the page to load. */
  assets?: ThemeAssets;
  /** The design system the look was read from. */
  source?: ThemeSource;
}

/** A builder theme that `extends` another, merged over its base: its tokens over the base's, its other fields where set. */
export function mergeBuilderThemeOverBase(variant: BuilderThemeDefinition, base: BuilderThemeDefinition): BuilderThemeDefinition {
  return { ...base, ...variant, tokens: { ...base.tokens, ...variant.tokens } };
}

/**
 * The builder themes a host has, by id and version. A second registration of the same id and
 * version is an error; `resolve` without a version answers the latest; a theme that `extends`
 * another is merged over its base, which must already be registered.
 */
export class BuilderThemeRegistry extends VersionedThemeRegistry<"builder", BuilderThemeDefinition> {
  public constructor() {
    super("builder", "builder theme", mergeBuilderThemeOverBase);
  }
}
