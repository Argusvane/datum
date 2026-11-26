import { parseVersionRange } from "../../registry/version-range.js";

export type PluginEnvironment = "browser" | "server" | "wasm";

export const PLUGIN_CONTRIBUTION_KINDS = [
  "components",
  "validators",
  "wasmPlugin",
  "formulaFunctions",
  "pdfRenditions",
  "builderThemes",
  "pdfThemes",
  "dataSourceProviders",
  "dataSources",
  "hooks",
  "submissionHandlers"
] as const;

export type PluginContributionKind = (typeof PLUGIN_CONTRIBUTION_KINDS)[number];

export interface PluginManifestDependency {
  id: string;
  versionRange?: string;
}

/**
 * In-repo plugin manifest. Describes a plugin's identity, engine/environment
 * compatibility, declared contributions, and dependencies. It does NOT carry code or a
 * package archive — the loader only reads and validates the descriptor.
 */
export interface PluginManifest {
  id: string;
  version: string;
  engineRange?: string;
  environments?: PluginEnvironment[];
  contributions?: PluginContributionKind[];
  dependencies?: PluginManifestDependency[];
  /** Reserved for a future signed-package pipeline; ignored today. */
  signature?: unknown;
}

const SEMVER = /^\d+\.\d+\.\d+$/;
const ENVIRONMENTS: readonly PluginEnvironment[] = ["browser", "server", "wasm"];

export function parsePluginManifest(input: string | Record<string, unknown>): PluginManifest {
  const raw: Record<string, unknown> =
    typeof input === "string" ? (JSON.parse(input) as Record<string, unknown>) : input;

  const id = raw.id;
  const version = raw.version;
  if (typeof id !== "string" || id.trim() === "") {
    throw new Error("Plugin manifest: 'id' is required");
  }
  if (typeof version !== "string" || !SEMVER.test(version)) {
    throw new Error("Plugin manifest: 'version' must be 'major.minor.patch'");
  }

  const manifest: PluginManifest = { id, version };

  if (raw.engineRange !== undefined) {
    if (typeof raw.engineRange !== "string") {
      throw new Error("Plugin manifest: 'engineRange' must be a string");
    }
    parseVersionRange(raw.engineRange); // throws on malformed spec
    manifest.engineRange = raw.engineRange;
  }

  if (raw.environments !== undefined) {
    if (
      !Array.isArray(raw.environments) ||
      !raw.environments.every((env): env is PluginEnvironment =>
        ENVIRONMENTS.includes(env as PluginEnvironment)
      )
    ) {
      throw new Error(`Plugin manifest: 'environments' must be a subset of ${ENVIRONMENTS.join(", ")}`);
    }
    manifest.environments = raw.environments as PluginEnvironment[];
  }

  if (raw.contributions !== undefined) {
    if (
      !Array.isArray(raw.contributions) ||
      !raw.contributions.every((kind): kind is PluginContributionKind =>
        (PLUGIN_CONTRIBUTION_KINDS as readonly string[]).includes(kind as string)
      )
    ) {
      throw new Error("Plugin manifest: 'contributions' contains an unknown kind");
    }
    manifest.contributions = raw.contributions as PluginContributionKind[];
  }

  if (raw.dependencies !== undefined) {
    if (!Array.isArray(raw.dependencies)) {
      throw new Error("Plugin manifest: 'dependencies' must be an array");
    }
    manifest.dependencies = raw.dependencies.map((dep) => {
      const entry = dep as Record<string, unknown>;
      if (typeof entry.id !== "string") {
        throw new Error("Plugin manifest: each dependency needs an 'id'");
      }
      if (entry.versionRange !== undefined) {
        if (typeof entry.versionRange !== "string") {
          throw new Error("Plugin manifest: dependency 'versionRange' must be a string");
        }
        parseVersionRange(entry.versionRange);
        return { id: entry.id, versionRange: entry.versionRange };
      }
      return { id: entry.id };
    });
  }

  if (raw.signature !== undefined) {
    manifest.signature = raw.signature;
  }

  return manifest;
}
