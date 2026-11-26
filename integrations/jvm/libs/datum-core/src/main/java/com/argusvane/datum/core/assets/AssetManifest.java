package com.argusvane.datum.core.assets;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;
import tools.jackson.databind.JsonNode;

/**
 * The generated assets' manifest ({@code META-INF/datum/manifest.json}): the file the shared asset build
 * ({@code integrations/shared/assets-lib.mjs}, {@code manifestFor}) writes for every host.
 *
 * <p>Written by {@code integrations/jvm/scripts/build-assets.mjs} into every module that ships assets, and
 * identical across them: the engine version the bundles were built from, the programs' ABIs, the component
 * types a form may use with no extension, the built-in bindings (with the PDF theme each suggests), the builder
 * shell's themes and form tokens, the features a build left out,
 * and the first-party extensions. The leading {@code "//"} comment key is ignored.
 *
 * @param buildId          the id the loader appends to asset URLs; {@code "dev"} when no manifest was found
 * @param source           the commit the assets were built from, when the build recorded one
 * @param engineVersion    the engine version the bundles were built from; {@code "0.0.0"} when absent
 * @param sandboxAbi       the sandbox program's ABI, or {@code null}
 * @param pdfAbi           the PDF program's ABI, or {@code null} when it is not built
 * @param knownComponentTypes component types a form may use with no extension
 * @param builtinBindings  the design-system bindings the bundles always carry, each with the PDF theme a server host prints
 *                         under (the binding id to PDF theme map hosts read)
 * @param builderThemes    the builder shell's own themes
 * @param formTokens       the Datum binding's form tokens
 * @param omittedFeatures  the features whose files this build left out
 * @param extensions       first-party extension manifests, as written
 */
@JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public record AssetManifest(
    String buildId,
    String source,
    String engineVersion,
    String sandboxAbi,
    String pdfAbi,
    List<String> knownComponentTypes,
    List<Binding> builtinBindings,
    List<ShellTheme> builderThemes,
    List<FormToken> formTokens,
    List<String> omittedFeatures,
    List<JsonNode> extensions) {

    public AssetManifest {
        buildId = buildId == null ? "dev" : buildId;
        engineVersion = engineVersion == null ? "0.0.0" : engineVersion;
        knownComponentTypes = knownComponentTypes == null ? List.of() : List.copyOf(knownComponentTypes);
        builtinBindings = builtinBindings == null ? List.of() : List.copyOf(builtinBindings);
        builderThemes = builderThemes == null ? List.of() : List.copyOf(builderThemes);
        formTokens = formTokens == null ? List.of() : List.copyOf(formTokens);
        omittedFeatures = omittedFeatures == null ? List.of() : List.copyOf(omittedFeatures);
        extensions = extensions == null ? List.of() : List.copyOf(extensions);
    }

    /**
     * What a classpath without any manifest reads as: build id {@code dev} and engine version {@code 0.0.0}, so a
     * classpath without generated assets still describes itself, as a development build.
     */
    public static AssetManifest absent() {
        return new AssetManifest(null, null, null, null, null, null, null, null, null, null, null);
    }

    /**
     * Checks manifests already read (a name for messages to the bytes of each {@code META-INF/datum/manifest.json})
     * against each other: the library call for the build-id agreement across asset jars, made by
     * Spring at start (a Quarkus binding would make it at build).
     *
     * @return the agreed manifest, or {@link #absent()} when there is none
     * @throws AssetManifestException when one is unreadable or has no buildId, or two disagree
     */
    public static AssetManifest verifyAgreement(java.util.Map<String, byte[]> manifests) {
        return AssetManifestLoader.verifyAgreement(manifests);
    }

    /** Whether this is a manifest that was read, not {@link #absent()}'s stand-in. */
    public boolean isBuilt() {
        return !(buildId.equals("dev") && source == null && sandboxAbi == null && pdfAbi == null);
    }

    /**
     * A design-system binding a form can be drawn by: its id, its label and, when it suggests one, the id of the PDF
     * theme a server host prints under (the host rung of the PDF ladder; {@code null} suggests none).
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Binding(String id, String label, String pdfTheme) {
    }

    /** A theme of the builder's own shell. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record ShellTheme(String id, String label) {
    }

    /** One Datum form token: name, group, tier, fallback, what it styles. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record FormToken(String name, String group, String tier, String fallback, String what) {
    }
}
