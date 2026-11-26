import { describe, expect, it } from "vitest";

import type { FormPlugin } from "../form-engine/core/schema/contracts.js";
import { PLUGIN_CONTRIBUTION_KINDS, parsePluginManifest } from "../form-engine/plugins/manifest/load-plugin-manifest.js";

// Every member of a plugin that is a contribution; the rest say what the plugin is and where it installs.
type ContributionField = Exclude<keyof FormPlugin, "id" | "version" | "engineRange" | "environments" | "dependencies" | "initialize">;

describe("parsePluginManifest", () => {
  it("parses a complete manifest from a JSON string", () => {
    const manifest = parsePluginManifest(
      JSON.stringify({
        id: "acme",
        version: "1.4.0",
        engineRange: "^0.1.0",
        environments: ["browser", "server"],
        contributions: ["components", "hooks", "submissionHandlers"],
        dependencies: [{ id: "acme-core", versionRange: ">=1.0.0 <2.0.0" }]
      })
    );
    expect(manifest).toEqual({
      id: "acme",
      version: "1.4.0",
      engineRange: "^0.1.0",
      environments: ["browser", "server"],
      contributions: ["components", "hooks", "submissionHandlers"],
      dependencies: [{ id: "acme-core", versionRange: ">=1.0.0 <2.0.0" }]
    });
  });

  it("accepts a minimal manifest", () => {
    expect(parsePluginManifest({ id: "min", version: "0.1.0" })).toEqual({
      id: "min",
      version: "0.1.0"
    });
  });

  it("can declare every contribution a plugin can make", () => {
    // The record fails to compile when FormPlugin gains or loses a contribution, and the list must match it.
    const contributions: Record<ContributionField, true> = {
      components: true,
      validators: true,
      wasmPlugin: true,
      formulaFunctions: true,
      pdfRenditions: true,
      builderThemes: true,
      pdfThemes: true,
      dataSourceProviders: true,
      dataSources: true,
      hooks: true,
      submissionHandlers: true
    };
    expect([...PLUGIN_CONTRIBUTION_KINDS].sort()).toEqual(Object.keys(contributions).sort());
    expect(
      parsePluginManifest({ id: "feel-extras", version: "1.0.0", contributions: ["formulaFunctions"] }).contributions
    ).toEqual(["formulaFunctions"]);
  });

  it("accepts the PDF rendition contribution kind", () => {
    expect(
      parsePluginManifest({ id: "pdf-extras", version: "1.0.0", contributions: ["pdfRenditions"] })
        .contributions
    ).toEqual(["pdfRenditions"]);
  });

  it.each([
    [{ version: "1.0.0" }, /'id' is required/],
    [{ id: "x", version: "1.0" }, /major\.minor\.patch/],
    [{ id: "x", version: "1.0.0", environments: ["desktop"] }, /environments/],
    [{ id: "x", version: "1.0.0", contributions: ["nonsense"] }, /unknown kind/],
    [{ id: "x", version: "1.0.0", dependencies: [{}] }, /dependency needs an 'id'/]
  ])("rejects invalid manifest %#", (input, pattern) => {
    expect(() => parsePluginManifest(input as Record<string, unknown>)).toThrow(pattern);
  });
});
