import type { SubmissionVersionContext } from "./canonical-submission.js";

export interface EnvelopeCompletenessInput {
  /** Component types present in the form definition. */
  componentTypes: string[];
  /** Installed plugin id -> version. */
  pluginVersions: Record<string, string>;
  /** Whether server manifests are required (mode.serverValidation). */
  requireServer: boolean;
}

export interface EnvelopeCompletenessResult {
  complete: boolean;
  missing: string[];
}

/**
 * Verifies the submission version context carries every manifest needed for downstream
 * compatibility evaluation: client runtime/renderer/schema versions, a component-version
 * entry for every component type in the form, a plugin-version entry for every installed
 * plugin, and (when server validation ran) server runtime + validator versions.
 */
export function assertEnvelopeComplete(
  versionContext: SubmissionVersionContext,
  input: EnvelopeCompletenessInput
): EnvelopeCompletenessResult {
  const missing: string[] = [];

  if (!versionContext.client.runtimeVersion) missing.push("client.runtimeVersion");
  if (!versionContext.client.rendererVersion) missing.push("client.rendererVersion");
  if (!versionContext.client.schemaVersion) missing.push("client.schemaVersion");

  const components = versionContext.client.components ?? {};
  for (const type of input.componentTypes) {
    if (!components[type]) {
      missing.push(`client.components.${type}`);
    }
  }

  const plugins = versionContext.client.plugins ?? {};
  for (const pluginId of Object.keys(input.pluginVersions)) {
    if (!plugins[pluginId]) {
      missing.push(`client.plugins.${pluginId}`);
    }
  }

  if (input.requireServer) {
    if (!versionContext.server?.runtimeVersion) missing.push("server.runtimeVersion");
    if (!versionContext.server?.validatorVersion) missing.push("server.validatorVersion");
  }

  return { complete: missing.length === 0, missing };
}
