package com.argusvane.datum.forms.web;

import com.argusvane.datum.core.contracts.OptionItem;
import com.argusvane.datum.forms.CurrentDefinition;
import com.argusvane.datum.forms.DataSourceNotFoundException;
import com.argusvane.datum.forms.DefinitionRequest;
import com.argusvane.datum.forms.DefinitionService;
import com.argusvane.datum.forms.FormDefinitionRepository;
import com.argusvane.datum.forms.FormKeys;
import com.argusvane.datum.forms.FormsSettings;
import com.argusvane.datum.forms.FormNotFoundException;
import com.argusvane.datum.forms.datasource.DataSourceOptions;
import com.argusvane.datum.forms.translation.StoredCatalog;
import com.argusvane.datum.forms.translation.TranslationCatalog;
import com.argusvane.datum.forms.translation.TranslationCatalogStore;
import com.argusvane.datum.web.error.BadRequestException;
import com.argusvane.datum.web.EntityTags;
import com.argusvane.datum.web.json.DatumJsonMapper;
import java.security.Principal;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * The three read endpoints of the forms module, written once for both web stacks.
 *
 * <p>Every method is blocking (the kernel may run for a public copy, a data source may take its timeout), so the
 * WebFlux adapter calls them on the elastic scheduler, never on the event loop. Failures are Datum exceptions;
 * the adapters' exception handlers turn them into the {@code errors} body ({@code ErrorMapper}).
 *
 * <p>Order inside an endpoint: parameters that can only be wrong by the caller's doing (400), then existence (404).
 * Keys and ids that do not look like the ones the repository accepts are a 404 without reaching a repository or
 * provider.
 *
 * <p>Who may call which endpoint is the application's security, in front of these methods (framework-first):
 * on Spring, the binding's {@code DatumRequestMatchers} name the routes
 * (the public copy and the translations, the author's copy, the data sources) and the application's
 * filter chain decides, so a refused caller never reaches a repository and learns nothing about which forms exist.
 * The facade keeps the principal only where its own work needs it: the data-source provider's call.
 *
 * <p>The author's copy ({@code public=false}) has a gate of its own besides: it is served only while the host serves the
 * builder ({@link AuthorCopy}), so a host that only shows forms never answers with a server-secret rule, even when its
 * chain forgot {@code builderReads()} or it has no chain at all.
 */
public final class FormsApi {

    /** The same shape the resource repository insists on for a key. */
    private static final Pattern SHA256 = Pattern.compile("^[0-9a-f]{64}$");

    private static final String JSON_TYPE = "application/json";

    private final DefinitionService definitions;
    private final FormDefinitionRepository repository;
    private final TranslationCatalogStore translations;
    private final DataSourceOptions dataSources;
    private final DatumJsonMapper json;
    private final String definitionCacheControl;
    private final String snapshotCacheControl;
    private final AuthorCopy authorCopy;

    /**
     * With the default cache headers: {@code no-store} for every definition answer (the snapshot header follows the definition
     * one); the author's copy is withheld.
     */
    public FormsApi(DefinitionService definitions, FormDefinitionRepository repository, TranslationCatalogStore translations,
                    DataSourceOptions dataSources, DatumJsonMapper json) {
        this(definitions, repository, translations, dataSources, json, FormsSettings.DEFAULT_DEFINITION_CACHE_CONTROL,
            FormsSettings.DEFAULT_DEFINITION_CACHE_CONTROL);
    }

    /**
     * The author's copy withheld ({@link AuthorCopy#WITHHELD}): a facade that is not told the builder is on never serves it.
     *
     * @param definitionCacheControl {@code datum.forms.cache.definition}: the current definition, and any full (non-public) copy
     * @param snapshotCacheControl   {@code datum.forms.cache.snapshot}: the public copy of a version asked by hash (the hash names
     *                               the bytes, so a shared cache may keep them)
     */
    public FormsApi(DefinitionService definitions, FormDefinitionRepository repository, TranslationCatalogStore translations,
                    DataSourceOptions dataSources, DatumJsonMapper json, String definitionCacheControl, String snapshotCacheControl) {
        this(definitions, repository, translations, dataSources, json, definitionCacheControl, snapshotCacheControl, AuthorCopy.WITHHELD);
    }

    /**
     * @param authorCopy whether {@code public=false} is answered with the stored definition ({@link AuthorCopy#SERVED} only
     *                   where the host serves the builder) or with a 404
     */
    public FormsApi(DefinitionService definitions, FormDefinitionRepository repository, TranslationCatalogStore translations,
                    DataSourceOptions dataSources, DatumJsonMapper json, String definitionCacheControl, String snapshotCacheControl,
                    AuthorCopy authorCopy) {
        this.authorCopy = java.util.Objects.requireNonNull(authorCopy, "authorCopy");
        this.definitionCacheControl = definitionCacheControl;
        this.snapshotCacheControl = snapshotCacheControl;
        this.definitions = definitions;
        this.repository = repository;
        this.translations = translations;
        this.dataSources = dataSources;
        this.json = json;
    }

    /**
     * {@code GET /forms/{key}/definition[?public=true|false][&sha256=]}.
     *
     * @param publicParam null or {@code true}: the public copy (no server-secret rule); {@code false}: the full
     *     definition, for someone who may build (the application's security admits it: {@code DatumRequestMatchers}
     *     puts this request among the builder's reads, never the public reads), and only while the builder is on
     *     ({@link AuthorCopy}): otherwise 404 with no body, as for a route the host does not serve
     * @param sha256 a version to serve instead of the current one (404 when no snapshot has it)
     * @param ifNoneMatch the request's {@code If-None-Match}, or null
     */
    public FormsReply definition(String catalogKey, String publicParam, String sha256, String ifNoneMatch) {
        return definition(catalogKey, publicParam, sha256, ifNoneMatch, null, null);
    }

    /**
     * {@link #definition(String, String, String, String)} for someone: the public copy passes the application's
     * {@code DefinitionCustomizer}s on its way out; the author's copy never does.
     *
     * @param principal who asks (the request's principal), or null
     * @param locale the request's locale as the web framework resolved it, or null
     */
    public FormsReply definition(String catalogKey, String publicParam, String sha256, String ifNoneMatch, Principal principal, Locale locale) {
        // The submissions contract (packages/submissions, and the security suite's SEC-02) names a form's page by
        // its catalog key "id@version". A form key never holds an "@" (FormKeys), so the suffix is unambiguous: the
        // form is the part before it, and the page is served only while that version is the current one.
        String key = catalogKey;
        String catalogVersion = null;
        int at = catalogKey.lastIndexOf('@');
        if (at > 0 && at < catalogKey.length() - 1) {
            key = catalogKey.substring(0, at);
            catalogVersion = catalogKey.substring(at + 1);
        }
        boolean publicCopy = switch (publicParam == null ? "true" : publicParam) {
            case "true" -> true;
            case "false" -> false;
            default -> throw new BadRequestException("bad_request", "The public parameter is true or false.");
        };
        if (!publicCopy && !authorCopy.served()) {
            // The author's copy is the builder's read: with the builder off the request answers as a route this host does
            // not serve, before the key is looked at or a repository asked, so it tells nothing about which forms exist. It
            // carries the definition answers' Cache-Control (no-store by default), so no cache keeps it for when the builder is on.
            return new FormsReply(404, Map.of("Cache-Control", definitionCacheControl), null);
        }
        if (!FormKeys.isValid(key) || (sha256 != null && !SHA256.matcher(sha256).matches())) {
            throw sha256 == null ? new FormNotFoundException(key) : new FormNotFoundException(key, sha256);
        }
        ObjectNode definition;
        String storedSha256;
        if (sha256 != null) {
            definition = definitions.snapshot(key, sha256);
            storedSha256 = sha256;
        } else {
            CurrentDefinition current = definitions.current(key);
            definition = current.definition();
            storedSha256 = current.sha256();
        }
        if (catalogVersion != null) {
            JsonNode version = definition.path("version");
            if (!version.isString() || !version.stringValue().equals(catalogVersion)) {
                throw new FormNotFoundException(key);
            }
        }
        // The tag names the representation: the hash of the bytes served. A public copy the kernel changed (an
        // upgraded runtime) therefore gets a new tag and no client keeps a stale one with a 304, and the tag of
        // the full definition (what a builder's If-Match names) is never valid for the public copy of a form
        // that has secret rules. A form without them is its own public copy and the two tags coincide. The
        // public copy is cached per hash in DefinitionService, so computing it before the 304 costs one run at most. The
        // customizers adjust the public copy before the kernel strips it, and the tag is of what they left.
        ObjectNode served = publicCopy
            ? definitions.publicCopyFor(definition, new DefinitionRequest(key, storedSha256, sha256 == null, principal, locale))
            : definition;
        String etag = DefinitionService.hash(served);
        // A public copy asked by hash gets the snapshot header (unset: the definition header, no-store). The application opts in
        // to a cacheable one only when its read routes are open: a shared cache may then keep the answer, and the kernel can
        // change the public copy's bytes under the same hash (an upgrade), so "immutable" is the application's call, not ours.
        // The current definition changes with every save and a full copy is for the author only: both keep the definition header.
        // With customizers the copy can differ per principal or locale: never the shareable header.
        String cacheControl = publicCopy && sha256 != null && !definitions.customizesPublicCopies() ? snapshotCacheControl : definitionCacheControl;
        if (EntityTags.matchesAny(ifNoneMatch, etag)) {
            return notModified(etag, cacheControl);
        }
        return ok(served, etag, cacheControl);
    }

    /** {@code GET /forms/{key}/translations}: {@code {catalog: {locale: {kind: {owner: tree}}}}} with the catalog's ETag. */
    public FormsReply translations(String key, String ifNoneMatch) {
        if (!FormKeys.isValid(key) || repository.find(key).isEmpty()) {
            throw new FormNotFoundException(key);
        }
        StoredCatalog stored = translations.read(key);
        if (EntityTags.matchesAny(ifNoneMatch, stored.etag())) {
            return notModified(stored.etag(), "no-cache");
        }
        ObjectNode body = JsonNodeFactory.instance.objectNode();
        body.set("catalog", TranslationCatalog.toJson(stored.catalog()));
        return ok(body, stored.etag(), "no-cache");
    }

    /**
     * {@code GET /data-sources/{id}?locale=&form=}: {@code {items: [...]}} as the provider returns them.
     *
     * @param locale a locale code, anything else reads as "" (the application's default)
     * @param principal who is asking, or null: the provider's call takes it (its own work, not an access decision)
     */
    public FormsReply dataSource(String id, String locale, Principal principal) {
        if (!FormKeys.isValid(id)) {
            throw new DataSourceNotFoundException(id);
        }
        String code = locale != null && TranslationCatalog.isLocale(locale) ? locale : "";
        java.util.List<OptionItem> items = dataSources.items(id, code, principal);
        ObjectNode body = JsonNodeFactory.instance.objectNode();
        ArrayNode list = body.putArray("items");
        for (OptionItem item : items) {
            list.add(com.argusvane.datum.core.contracts.DatumJson.mapper().valueToTree(item));
        }
        return new FormsReply(200, Map.of("Cache-Control", "private, no-cache"), bytes(body));
    }

    // ------------------------------------------------------------------ helpers

    private FormsReply ok(JsonNode body, String hash, String cacheControl) {
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("ETag", EntityTags.of(hash));
        headers.put("Cache-Control", cacheControl);
        return new FormsReply(200, headers, bytes(body));
    }

    private static FormsReply notModified(String hash, String cacheControl) {
        return new FormsReply(304, Map.of("ETag", EntityTags.of(hash), "Cache-Control", cacheControl), null);
    }

    private byte[] bytes(JsonNode body) {
        return json.mapper().writeValueAsBytes(body);
    }

    /** The media type every body is written with. */
    public static String contentType() {
        return JSON_TYPE;
    }
}
