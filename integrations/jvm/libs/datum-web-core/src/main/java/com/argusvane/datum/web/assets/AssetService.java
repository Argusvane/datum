package com.argusvane.datum.web.assets;

import com.argusvane.datum.core.assets.AssetManifest;
import com.argusvane.datum.core.assets.HostBindings;
import com.argusvane.datum.web.WebSettings;
import com.argusvane.datum.web.monitoring.DatumCapabilities;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * The Datum half of the asset handler: the gate that decides which file a request may name, and the small documents
 * ({@code host.json}, the glue script). The serving itself (finding the file, its media type, conditional and range
 * requests, the cache headers) is the web framework's own resource handler (framework-first: Spring's
 * {@code ResourceHandlerRegistry} on MVC and WebFlux), which asks {@link #gate} before it resolves anything.
 *
 * <p>Files live as {@code META-INF/datum/assets/<path>} on the class path, so the form files of {@code datum-ui} and
 * the PDF files of {@code datum-pdf} appear as one directory (a path present in two jars is served from the first).
 * The gate answers "not found" when the build id is not the manifest's, the path is not a plain relative ASCII path,
 * the file belongs to an omitted feature, or a {@link WithheldAssets} bean names it, the last two compared
 * case-folded.
 *
 * <p>Framework-free: it reads {@link WebSettings} and answers strings, so every web binding gates
 * with the same rule.
 */
public final class AssetService {

    /** Where the asset-carrying jars put their files. */
    public static final String LOCATION = "META-INF/datum/assets/";

    /** {@link #LOCATION} as the Spring resource location the bindings' resource handlers serve from. */
    public static final String RESOURCE_LOCATION = "classpath:/" + LOCATION;

    /** The glue script, shipped with this module. */
    public static final String GLUE_RESOURCE = "META-INF/datum/web/datum-host.js";

    private static final Logger LOG = LoggerFactory.getLogger("datum.web.assets");

    private final DatumAssets assets;
    private final WebSettings settings;
    private final List<WithheldAssets> withheld;
    private final ClassLoader loader;
    private final JsonMapper json;
    private final AtomicReference<Set<String>> omitted = new AtomicReference<>();
    private final DatumCapabilities capabilities;
    private final HostBindings bindings;
    private volatile byte[] glue;

    /**
     * @param capabilities where the capabilities' endpoint paths are read for {@code host.json}, or null
     * @param bindings     which design-system binding each form route is drawn by, published in {@code host.json} for the
     *                     page glue, or null for a host that configures none
     */
    public AssetService(DatumAssets assets, WebSettings settings, List<WithheldAssets> withheld,
                        ClassLoader loader, JsonMapper json, DatumCapabilities capabilities, HostBindings bindings) {
        this.capabilities = capabilities;
        this.bindings = bindings;
        this.assets = assets;
        this.settings = settings;
        this.withheld = withheld == null ? List.of() : List.copyOf(withheld);
        this.loader = loader;
        this.json = json;
        if (assets.enabled()) {
            // Read once at start, on the starting thread: the gate then does no I/O on a request (a reactive stack asks it on the event loop).
            omittedFiles();
        }
    }

    /** The beans' view of where things are. */
    public DatumAssets assets() {
        return assets;
    }

    /**
     * The assets path without the context path: router-function predicates and {@code pathWithinApplication()}
     * both exclude it, so routing must use this and only URLs handed to the browser carry the context.
     */
    public String routePath() {
        return settings.assets().path();
    }

    /** {@code GET {assets}/host.json}: JSON, never stored by a cache (it names the current build). */
    public AssetReply hostJsonReply() {
        return new AssetReply(200, Map.of("Content-Type", "application/json", "Cache-Control", "no-store"), hostJson());
    }

    /** {@code GET {assets}/datum-host.js}: the glue, revalidated on every use (its URL carries no build id). */
    public AssetReply glueReply() {
        return new AssetReply(200, Map.of("Content-Type", "text/javascript;charset=UTF-8", "Cache-Control", "no-cache"), glue());
    }

    /**
     * The one answer to a versioned-file request that names nothing it may serve: a bare 404 that no cache keeps (a later
     * deploy may put a file at that URL). Both web bindings write exactly this for a refusal by the gate and for a file
     * the gate passes but the class path lacks, so the wire is the same on MVC and WebFlux.
     */
    public AssetReply notFoundReply() {
        return new AssetReply(404, Map.of("Cache-Control", "no-store"), new byte[0]);
    }

    /**
     * The gate of the versioned files, asked by the web framework's resource handler before it resolves a path.
     *
     * <p>It reads exactly the string the handler would resolve (the path within the handler's mapping, for example
     * {@code a9c057bb6c6f/datum-form.js}) and answers the part after the build id, or empty (the handler answers 404). The
     * rule is strict because anything it lets through is looked up by the framework: the build id must be the
     * manifest's; the rest must be plain ASCII {@code a/b/c.ext} segments with no dot segment, empty segment, percent
     * sign (which also closes {@code %2e} and {@code %2f}), semicolon (the framework drops path parameters such as
     * {@code x.js;v=1}, which would otherwise name a withheld file under another spelling), backslash or colon; and the file
     * must be neither a file of an omitted feature nor withheld by a {@link WithheldAssets} bean, both compared lower-cased
     * as well, because an exploded class path on a case-insensitive file system resolves {@code DATUM-BUILDER.JS} to
     * {@code datum-builder.js}.
     *
     * @param withinAssets the path below the assets path: {@code <buildId>/<file>}
     * @return the cleaned file path below the build id, or empty
     */
    public Optional<String> gate(String withinAssets) {
        if (!assets.enabled() || withinAssets == null) {
            return Optional.empty();
        }
        int slash = withinAssets.indexOf('/');
        if (slash <= 0 || !assets.buildId().equals(withinAssets.substring(0, slash))) {
            return Optional.empty();
        }
        Optional<String> path = AssetPaths.clean(withinAssets.substring(slash + 1));
        if (path.isEmpty()) {
            return Optional.empty();
        }
        String file = path.get();
        String folded = file.toLowerCase(Locale.ROOT);
        if (omittedFiles().contains(folded)) {
            return Optional.empty();
        }
        for (WithheldAssets guard : withheld) {
            if (guard.withheld(file) || guard.withheld(folded)) {
                return Optional.empty();
            }
        }
        return path;
    }

    /** The max-age of the immutable answers ({@code datum.web.assets.cache-period}). */
    public java.time.Duration cachePeriod() {
        return settings.assets().cachePeriod();
    }

    /**
     * {@code host.json}: {@code {buildId, assetsBase, apiBase, csrf{headerName, cookieName, metaName}, bindings?, paths?}};
     * {@code bindings} is {@code {default, routes, catalog}}: the binding a form route is drawn by (the host's
     * configuration) and the catalog's ids with the PDF theme each suggests;
     * {@code paths} names the endpoint bases of the capabilities that registered one (webauthn, tsa).
     */
    public byte[] hostJson() {
        WebSettings.Csrf csrf = settings.csrf();
        Map<String, Object> csrfNames = new LinkedHashMap<>();
        csrfNames.put("headerName", csrf.headerName());
        csrfNames.put("cookieName", csrf.cookieName());
        csrfNames.put("metaName", csrf.metaName());
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("buildId", assets.buildId());
        body.put("assetsBase", assets.assetsBase());
        body.put("apiBase", assets.apiBase());
        body.put("csrf", csrfNames);
        if (bindings != null) {
            body.put("bindings", bindings.describe());
        }
        Map<String, String> endpoints = capabilities == null ? Map.of() : capabilities.endpoints();
        if (!endpoints.isEmpty()) {
            // The context path is what apiBase carries beyond the configured api path.
            String api = settings.api().path();
            String apiBase = assets.apiBase();
            String context = apiBase.endsWith(api) ? apiBase.substring(0, apiBase.length() - api.length()) : "";
            Map<String, Object> paths = new LinkedHashMap<>();
            endpoints.forEach((name, path) -> paths.put(name, context + path));
            body.put("paths", paths);
        }
        return json.writeValueAsBytes(body);
    }

    /** The page glue script (UTF-8 bytes), read once from this module's resources. */
    public byte[] glue() {
        byte[] cached = glue;
        if (cached == null) {
            try (InputStream in = AssetService.class.getClassLoader().getResourceAsStream(GLUE_RESOURCE)) {
                if (in == null) {
                    throw new IllegalStateException("The Datum glue script " + GLUE_RESOURCE + " is missing from the jar.");
                }
                cached = in.readAllBytes();
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            }
            glue = cached;
        }
        return cached;
    }

    /**
     * The files whose feature is left out: the manifest's {@code omittedFeatures} plus
     * {@code datum.web.assets.omit-features}, resolved through {@code feature-files.json} (aliases followed).
     */
    Set<String> omittedFiles() {
        Set<String> cached = omitted.get();
        if (cached == null) {
            cached = Set.copyOf(readOmitted());
            omitted.compareAndSet(null, cached);
        }
        return cached;
    }

    private Set<String> readOmitted() {
        Set<String> tokens = new HashSet<>(settings.assets().omitFeatures());
        AssetManifest manifest = assets.manifest();
        if (manifest != null) {
            tokens.addAll(manifest.omittedFeatures());
        }
        Set<String> files = new HashSet<>();
        if (tokens.isEmpty()) {
            return files;
        }
        JsonNode features = null;
        try (InputStream in = loader.getResourceAsStream(LOCATION + "feature-files.json")) {
            if (in != null) {
                features = json.readTree(in).get("features");
            }
        } catch (IOException | RuntimeException e) {
            LOG.warn("feature-files.json could not be read; omitted features cannot be resolved to files.", e);
        }
        for (String token : tokens) {
            JsonNode feature = features == null ? null : features.get(token);
            if (feature != null && feature.hasNonNull("aliasOf")) {
                feature = features.get(feature.get("aliasOf").asString());
            }
            if (feature == null) {
                LOG.warn("datum.web.assets.omit-features names {}, which feature-files.json does not list; nothing is withheld for it.", token);
                continue;
            }
            JsonNode listed = feature.get("files");
            if (listed != null && listed.isArray()) {
                listed.forEach(file -> files.add(file.asString().toLowerCase(Locale.ROOT)));
            }
        }
        return files;
    }
}
