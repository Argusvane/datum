package com.argusvane.datum.ui.builder;

import com.argusvane.datum.core.DatumConfigurationException;
import com.argusvane.datum.core.hooks.HookProblem;
import com.argusvane.datum.core.hooks.HookRefusedException;
import com.argusvane.datum.sandbox.protocol.StrictJson;
import com.argusvane.datum.forms.DefinitionService;
import com.argusvane.datum.forms.FormDefinitionRepository;
import com.argusvane.datum.forms.FormKeys;
import com.argusvane.datum.forms.FormNotFoundException;
import com.argusvane.datum.forms.FormStoreReadOnlyException;
import com.argusvane.datum.forms.translation.StoredCatalog;
import com.argusvane.datum.forms.translation.TranslationCatalog;
import com.argusvane.datum.forms.translation.TranslationCatalogStore;
import com.argusvane.datum.forms.web.FormsReply;
import com.argusvane.datum.web.EntityTags;
import com.argusvane.datum.web.error.BadRequestException;
import com.argusvane.datum.web.json.DatumJsonMapper;
import com.argusvane.datum.web.json.JsonBodies;
import java.security.Principal;
import java.time.Clock;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.function.Predicate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * The builder's write endpoints, decided once for every web stack: the MVC controller and
 * the WebFlux handlers only move bytes in and out. The writes themselves are the transport-neutral
 * {@link BuilderService} (the kernel's {@code check} as the judge: an unchecked or refused definition
 * is never stored); this class keeps what is HTTP: the body cap, the {@code If-Match} precondition, the JSON reading, the
 * {@code X-Datum-Locale-Changes} header, and the outcome as the status, the {@code ETag}, the removed-locales header, the
 * {@code Location} of a create and the body.
 *
 * <p>Who may write is the application's security, in front of the route (framework-first): on Spring the binding's {@code DatumRequestMatchers.builderWrites()} names these routes and the
 * application's filter chain refuses (401 or 403) before any of this runs, so a caller who may not build learns
 * nothing about which forms exist.
 *
 * <p>Every write is two calls. {@code admit*} runs before the body is read: for an existing form, existence (404),
 * so nobody's body is read for nothing. The adapter then reads the body with the
 * {@link #maxDefinitionBytes()} cap on the raw stream (415 for a body that is not JSON, 413 over the cap) and
 * hands the bytes to the write itself, which keeps this order:
 *
 * <ol>
 *   <li>413 the body is over {@code datum.builder.max-definition-size} (checked again on the bytes);
 *   <li>409 {@code form.outdated}: {@code If-Match} names a hash that is not the current definition's;
 *   <li>400 {@code bad_document}: not strict JSON (an unpaired surrogate escape included);
 *   <li>422 {@code definition.refused}: the host's own reading of the shape ({@link DefinitionShape}), then the
 *       id that must stay the form's ({@code definition.id.mismatch});
 *   <li>400 {@code bad_document}: the {@code X-Datum-Locale-Changes} header is not valid;
 *   <li>422 {@code definition.refused}: a number JSON cannot write ({@code definition.number.nonFinite});
 *   <li>the application's {@code BuilderSaveCustomizer}s: a refusal answers 422 {@code definition.refused}
 *       with its problems as findings, or 403 / 409 with the errors body by its kind;
 *   <li>the kernel's check: 422 {@code definition.refused} with the kernel's codes, 422
 *       {@code definition.tooDeep} or {@code definition.tooCostly}, and 503 {@code server.unavailable} when the
 *       sandbox could not answer (fail closed);
 *   <li>the application's {@code BuilderSaveValidator}s: their errors answer 422 {@code definition.refused},
 *       their warnings ride in the 200's {@code warnings};
 *   <li>the save: the hash checked again under the form's lock, the repository write (501 {@code forms.readOnly}), the
 *       catalog moved for the language changes, the snapshot and {@code FormDefinitionSavedEvent}
 *       ({@link DefinitionService#saved}), all under the hash of what the repository stored, the one the read endpoint
 *       answers.
 * </ol>
 * The first two and the JSON reading are this class's, before the service; the header is read here and judged by the
 * service in its place (after the shape); the rest are the service's steps, mapped: {@code Saved} 200 (201 with
 * {@code Location} for a create), {@code Outdated} 409 with the current {@code ETag}, {@code Refused} 422 with
 * {@code errors} and {@code kernel}, {@code ReadOnly} 501, {@code Exists} 409 {@code form.exists} with the existing
 * {@code ETag}, {@code NotFound} 404, {@code Malformed} 400, {@code TooLarge} 413, {@code Unavailable} 503,
 * {@code Declined} 422 / 403 / 409 by the hook refusal's kind.
 *
 * <p>Wire choices, all stated where they are made: a create endpoint ({@code POST /forms}, the key from the body's id);
 * the 413 code is the web module's {@code bad_document}; a refusal's sentences are written by {@link DefinitionShape#describe}
 * for every kernel finding; the catalog also loses the entries of every locale the save removed from the definition (the
 * forms module's {@code afterSave} rule) besides the header's; the hash is re-checked under a lock right before the
 * write; a catalog save takes {@code If-Match}.
 *
 * <p>Methods block (the kernel runs for a check), so the WebFlux adapter calls them on the elastic scheduler.
 */
public final class BuilderApi {

    /** The deepest catalog read: {@link BuilderService#MAX_CATALOG_DEPTH}. */
    static final int MAX_CATALOG_DEPTH = BuilderService.MAX_CATALOG_DEPTH;

    /** The most kernel warnings an answer lists. */
    private static final int MAX_KERNEL_WARNINGS = 50;

    /** The header listing the locales a save removed, whose catalog entries went with them. */
    public static final String REMOVED_LOCALES_HEADER = "X-Datum-Removed-Locales";

    private final BuilderService service;
    private final FormDefinitionRepository repository;
    private final TranslationCatalogStore translations;
    private final long maxBytes;
    private final DatumJsonMapper json;
    private final String apiBase;

    /**
     * @param types the component types this host draws (the assets manifest's {@code knownComponentTypes}), sent
     *     to the kernel so an unknown type is a warning; empty only when the host has no manifest
     * @param maxDefinitionBytes {@code datum.builder.max-definition-size}, for definitions and catalogs alike
     * @param apiBase the API base as a browser sees it (context path included), for the {@code Location} of a create
     */
    public BuilderApi(FormDefinitionRepository repository, DefinitionService definitions, TranslationCatalogStore translations,
                      List<String> types, long maxDefinitionBytes, String apiBase, Clock clock) {
        this(BuilderService.builder().repository(repository).definitions(definitions).translations(translations).types(types)
            .maxDefinitionBytes(maxDefinitionBytes).clock(clock).build(), repository, translations, maxDefinitionBytes, apiBase);
    }

    /**
     * Over a service the application shares with its other callers (the binding's bean).
     *
     * @param repository the repository the service writes, read here for the admission's existence check
     * @param translations the catalog store the service writes, read here for a catalog save's {@code If-Match}
     */
    public BuilderApi(BuilderService service, FormDefinitionRepository repository, TranslationCatalogStore translations,
                      long maxDefinitionBytes, String apiBase) {
        this.service = Objects.requireNonNull(service, "service");
        this.repository = Objects.requireNonNull(repository, "repository");
        this.translations = Objects.requireNonNull(translations, "translations");
        if (maxDefinitionBytes < 1) {
            throw new DatumConfigurationException("datum.builder.max-definition-size", "datum.builder.max-definition-size must be at least one byte.");
        }
        this.maxBytes = maxDefinitionBytes;
        // A mapper of its own: the web module's is capped at datum.web.api.max-body-size, and a definition may be
        // allowed more (or less) than an ordinary request body.
        this.json = DatumJsonMapper.create(maxDefinitionBytes);
        this.apiBase = apiBase == null ? "" : apiBase;
    }

    /** The service this facade hands every write to. */
    public BuilderService service() {
        return service;
    }

    /** The cap the adapters read a body with: {@code datum.builder.max-definition-size}. */
    public long maxDefinitionBytes() {
        return maxBytes;
    }

    // ------------------------------------------------------------------ admission (before the body)

    /** {@code POST /forms}: nothing to check before the body (its id is the key). */
    public Admission admitCreate() {
        return new Admission(Admission.Operation.CREATE, null);
    }

    /** {@code PUT /forms/{key}}: 404 for a form that does not exist. */
    public Admission admitUpdate(String key) {
        requireExisting(key);
        return new Admission(Admission.Operation.UPDATE, key);
    }

    /** {@code PUT /forms/{key}/translations}: 404 for a form that does not exist. */
    public Admission admitTranslations(String key) {
        requireExisting(key);
        return new Admission(Admission.Operation.TRANSLATIONS, key);
    }

    // ------------------------------------------------------------------ writes

    /** {@link #update(Admission, byte[], String, String, Principal)} for nobody in particular. */
    public FormsReply update(Admission admission, byte[] body, String ifMatch, String localeChanges) {
        return update(admission, body, ifMatch, localeChanges, null);
    }

    /**
     * {@code PUT /forms/{key}}: saves a definition from the builder.
     *
     * <p>A request that says which definition it builds on ({@code If-Match}: the hash the page loaded, quoted,
     * weak or bare) is refused with 409 when the form has moved on since; one that says nothing (or {@code *}) is
     * saved as sent.
     *
     * @param localeChanges the {@code X-Datum-Locale-Changes} header, or null
     * @param principal who saves (the request's principal), or null
     */
    public FormsReply update(Admission admission, byte[] body, String ifMatch, String localeChanges, Principal principal) {
        expect(admission, Admission.Operation.UPDATE);
        String key = admission.key();
        requireWithinCap(body);
        // The If-Match as the header says it, here and again under the save's lock: a list, weak or bare tags, *.
        Predicate<String> precondition = sha -> EntityTags.preconditionHolds(ifMatch, sha);
        BuilderOutcome refused = service.precondition(key, precondition);
        if (refused != null) {
            throw refusal(refused);
        }
        JsonNode decoded = decode(body, "The definition is not JSON.");
        return reply(service.saveAdmitted(key, decoded, precondition, () -> LocaleChanges.read(localeChanges), principal));
    }

    /** {@link #create(Admission, byte[], String, Principal)} for nobody in particular. */
    public FormsReply create(Admission admission, byte[] body, String localeChanges) {
        return create(admission, body, localeChanges, null);
    }

    /**
     * {@code POST /forms}: creates a form under its definition's id. The same checks as a save, with the id taken
     * from the body (a key the forms module accepts) and 409
     * {@code form.exists} when a form already has it. Answers 201 with the definition's URL.
     */
    public FormsReply create(Admission admission, byte[] body, String localeChanges, Principal principal) {
        expect(admission, Admission.Operation.CREATE);
        requireWithinCap(body);
        JsonNode decoded = decode(body, "The definition is not JSON.");
        return reply(service.createAdmitted(decoded, () -> LocaleChanges.read(localeChanges), principal));
    }

    /** {@link #translations(Admission, byte[], String, Principal)} for nobody in particular. */
    public FormsReply translations(Admission admission, byte[] body, String ifMatch) {
        return translations(admission, body, ifMatch, null);
    }

    /**
     * {@code PUT /forms/{key}/translations}: replaces the form's host catalog, from {@code {catalog: {...}}} or the
     * bare catalog. Order: 413, 409 ({@code If-Match} names a catalog etag that is not current), 400 not JSON (deeper
     * than 32 included), 422 {@code catalog.invalid}. The catalog is stored normalized and answered with its new etag.
     */
    public FormsReply translations(Admission admission, byte[] body, String ifMatch, Principal principal) {
        expect(admission, Admission.Operation.TRANSLATIONS);
        String key = admission.key();
        requireWithinCap(body);
        // The hash the caller's precondition matched, handed to the store so it refuses the write across instances.
        String expected = null;
        if (!EntityTags.parse(ifMatch).isEmpty()) {
            StoredCatalog stored = translations.read(key);
            if (!EntityTags.preconditionHolds(ifMatch, stored.etag())) {
                throw BuilderOutdatedException.catalog(stored.etag());
            }
            expected = stored.etag();
        }
        JsonNode decoded = decode(body, "The catalog is not JSON.");
        return reply(service.translationsAdmitted(key, decoded, expected, principal));
    }

    // ------------------------------------------------------------------ the outcome on the wire

    /** A 2xx outcome as its reply; any other as the refusal's exception for the error mapper. */
    private FormsReply reply(BuilderOutcome outcome) {
        // Java 17: no pattern switch, so one instanceof per record of the sealed interface.
        if (outcome instanceof BuilderOutcome.Saved saved) {
            ObjectNode answer = JsonNodeFactory.instance.objectNode();
            answer.put("key", saved.key());
            answer.put("version", saved.version());
            answer.put("sha256", saved.sha256());
            answer.put("savedAt", saved.savedAt().toString());
            answer.set("catalog", TranslationCatalog.toJson(saved.catalog()));
            ArrayNode warningList = answer.putArray("warnings");
            saved.warnings().forEach(warningList::add);
            ArrayNode kernelWarnings = answer.putArray("kernelWarnings");
            saved.kernelWarnings().stream().limit(MAX_KERNEL_WARNINGS).forEach(warning -> {
                ObjectNode entry = kernelWarnings.addObject();
                entry.put("code", warning.code());
                entry.put("where", warning.where() == null ? "" : warning.where());
                if (warning.limit() != null) {
                    entry.put("limit", warning.limit());
                }
            });
            Map<String, String> headers = new LinkedHashMap<>();
            headers.put("ETag", EntityTags.of(saved.sha256()));
            headers.put("Cache-Control", "no-store");
            if (!saved.removedLocales().isEmpty()) {
                headers.put(REMOVED_LOCALES_HEADER, String.join(", ", saved.removedLocales()));
            }
            if (saved.created()) {
                headers.put("Location", apiBase + "/forms/" + saved.key() + "/definition?public=false");
            }
            return new FormsReply(saved.created() ? 201 : 200, headers, bytes(answer));
        }
        if (outcome instanceof BuilderOutcome.CatalogSaved saved) {
            ObjectNode answer = JsonNodeFactory.instance.objectNode();
            answer.set("catalog", TranslationCatalog.toJson(saved.catalog()));
            answer.put("entries", TranslationCatalog.leafCount(saved.catalog()));
            answer.put("savedAt", saved.savedAt().toString());
            Map<String, String> headers = new LinkedHashMap<>();
            headers.put("ETag", EntityTags.of(saved.etag()));
            headers.put("Cache-Control", "no-store");
            return new FormsReply(200, headers, bytes(answer));
        }
        throw refusal(outcome);
    }

    /** The exception the error mapper answers a refusal with: code for code what the service's outcome says. */
    private static RuntimeException refusal(BuilderOutcome outcome) {
        if (outcome instanceof BuilderOutcome.Outdated outdated) {
            return BuilderOutdatedException.definition(outdated.currentSha256(), outdated.currentVersion());
        }
        if (outcome instanceof BuilderOutcome.CatalogOutdated outdated) {
            return BuilderOutdatedException.catalog(outdated.currentEtag());
        }
        if (outcome instanceof BuilderOutcome.Refused refused) {
            return switch (refused.code()) {
                case "definition.refused" -> BuilderRefusedException.refused(refused.errors());
                case "catalog.invalid" -> BuilderRefusedException.catalog(refused.errors());
                // A too-deep definition is listed under kernel too (the kernel's own code); a too-costly one is not.
                case "definition.tooDeep" -> BuilderRefusedException.typed(refused.code(), 422, refused.errors().get(0).message(), true, refused.cause());
                default -> BuilderRefusedException.typed(refused.code(), 422, refused.errors().get(0).message(), false, refused.cause());
            };
        }
        if (outcome instanceof BuilderOutcome.ReadOnly readOnly) {
            return readOnly.cause() != null ? readOnly.cause() : new FormStoreReadOnlyException();
        }
        if (outcome instanceof BuilderOutcome.Exists exists) {
            return BuilderRefusedException.typed("form.exists", 409,
                "A form with the id \"" + exists.key() + "\" exists already: open it to change it, or give this one another id.",
                Map.of("ETag", EntityTags.of(exists.currentSha256())), null);
        }
        if (outcome instanceof BuilderOutcome.NotFound notFound) {
            return new FormNotFoundException(notFound.key());
        }
        if (outcome instanceof BuilderOutcome.Malformed malformed) {
            return new BadRequestException(malformed.reason());
        }
        if (outcome instanceof BuilderOutcome.TooLarge tooLarge) {
            // Not reached from these routes, which cap the bytes and take the steps after the size; mapped as their 413.
            return JsonBodies.tooLarge(tooLarge.maxBytes());
        }
        if (outcome instanceof BuilderOutcome.Unavailable unavailable) {
            return BuilderRefusedException.typed(unavailable.code(), 503, unavailable.reason(), false, unavailable.cause());
        }
        if (outcome instanceof BuilderOutcome.Declined declined) {
            // An application hook's refusal. The content kind is the builder's own 422 definition.refused, each
            // problem a finding under the author's boxes (its field is the where); a forbidden or conflicting save is the
            // hook's refusal as it is, which the error mapper answers 403 or 409 with the errors body.
            HookRefusedException refusal = declined.refusal();
            if (refusal.kind() != HookRefusedException.Kind.INVALID) {
                return refusal;
            }
            List<DefinitionShape.Finding> findings = new java.util.ArrayList<>();
            for (HookProblem problem : refusal.problems()) {
                findings.add(new DefinitionShape.Finding(problem.code(), problem.field() == null ? "definition" : problem.field(),
                    problem.message() != null ? problem.message() : problem.code(), null));
            }
            return BuilderRefusedException.refused(findings);
        }
        return new IllegalStateException("An outcome the builder's routes do not answer: " + outcome.getClass().getName());
    }

    // ------------------------------------------------------------------ helpers

    private void requireWithinCap(byte[] body) {
        if (body.length > maxBytes) {
            throw JsonBodies.tooLarge(maxBytes);
        }
    }

    /**
     * The body as JSON, refused 400 for what is not strict JSON: the web module's reading (UTF-8, one value, the
     * nesting, number and string caps), then the refusals Jackson does not make ({@link StrictJson}: an unpaired
     * UTF-16 surrogate escape in a string or key, a byte order mark). Without the second, a lone surrogate reached
     * the sandbox request, could not be written there and answered 503 as if the server were down.
     */
    private JsonNode decode(byte[] body, String notJson) {
        JsonNode node;
        try {
            node = JsonBodies.parse(json, body);
        } catch (BadRequestException e) {
            throw new BadRequestException(notJson, e);
        }
        try {
            StrictJson.decode(body);
        } catch (StrictJson.NotJsonException e) {
            throw new BadRequestException(notJson, e);
        }
        return node;
    }

    /**
     * One request header from all its lines, joined with commas as Spring MVC joins a repeated header for a
     * {@code String} parameter, so both stacks read a repeated {@code If-Match} or {@code X-Datum-Locale-Changes}
     * alike; null when the request has none.
     */
    public static String header(List<String> values) {
        return values == null || values.isEmpty() ? null : String.join(",", values);
    }

    private void requireExisting(String key) {
        if (!FormKeys.isValid(key) || repository.find(key).isEmpty()) {
            throw new FormNotFoundException(key);
        }
    }

    private static void expect(Admission admission, Admission.Operation operation) {
        if (admission == null || admission.operation() != operation) {
            throw new IllegalArgumentException("This write needs an admission for " + operation + ".");
        }
    }

    private byte[] bytes(JsonNode body) {
        return json.mapper().writeValueAsBytes(body);
    }
}
