import { compareVersions } from "./versioning.js";

/** What a theme kept in a {@link VersionedThemeRegistry} has: an id, a version, a target, and perhaps a base. */
export interface VersionedTheme<Target extends string> {
  id: string;
  version: string;
  target: Target;
  extends?: string;
}

/**
 * Themes of one target by id and version: the shared body of the builder and PDF theme
 * registries. A second registration of the same id and version is an error; `resolve` without
 * a version answers the latest. A theme that `extends` another is merged over its base at
 * registration (the base must already be registered), so a stored theme never names one.
 */
export class VersionedThemeRegistry<Target extends string, Theme extends VersionedTheme<Target>> {
  private readonly definitions = new Map<string, Theme[]>();

  public constructor(
    private readonly target: Target,
    /** How errors name the kind: `"builder theme"`, `"PDF theme"`. */
    private readonly noun: string,
    private readonly merge: (variant: Theme, base: Theme) => Theme
  ) {}

  public register(definition: Theme): void {
    const { id, version } = definition;
    if (definition.target !== this.target) {
      throw new Error(`Theme ${id} has target "${String(definition.target)}"; the ${this.noun} registry takes "${this.target}" themes only`);
    }
    const list = this.definitions.get(id) ?? [];
    if (list.some((entry) => entry.version === version)) {
      throw new Error(`The ${this.noun} ${id}@${version} is already registered`);
    }
    let stored = definition;
    const baseId = definition.extends?.trim();
    if (baseId) {
      if (baseId === id) {
        throw new Error(`The ${this.noun} ${id} cannot extend itself`);
      }
      if (!this.has(baseId)) {
        throw new Error(`The ${this.noun} ${id} extends "${baseId}", which is not registered; register the base first`);
      }
      stored = this.merge(definition, this.resolve(baseId));
      delete stored.extends;
    }
    list.push(stored);
    list.sort((a, b) => compareVersions(a.version, b.version));
    this.definitions.set(id, list);
  }

  /** The theme registered under `id` (that `version`, else the latest); throws when there is none. */
  public resolve(id: string, version?: string): Theme {
    const list = this.definitions.get(id) ?? [];
    const found = version === undefined ? list[list.length - 1] : list.find((entry) => entry.version === version);
    if (!found) {
      throw new Error(`No ${this.noun} registered for id ${id}${version === undefined ? "" : ` version ${version}`}`);
    }
    return found;
  }

  /** Whether {@link resolve} would succeed for this id (and version, when given). */
  public has(id: string, version?: string): boolean {
    const list = this.definitions.get(id) ?? [];
    return version === undefined ? list.length > 0 : list.some((entry) => entry.version === version);
  }

  /** Every registered theme, the latest version of each id, in the order the ids were first registered. */
  public list(): Theme[] {
    return [...this.definitions.values()].map((list) => list[list.length - 1]!);
  }
}
