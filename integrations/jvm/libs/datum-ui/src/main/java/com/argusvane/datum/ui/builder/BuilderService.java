package com.argusvane.datum.ui.builder;

import com.argusvane.datum.core.DatumConfigurationException;
import com.argusvane.datum.core.DefinitionTooDeepException;
import com.argusvane.datum.core.contracts.DefinitionProblem;
import com.argusvane.datum.core.hooks.HookFindings;
import com.argusvane.datum.core.hooks.HookProblem;
import com.argusvane.datum.core.hooks.HookRefusedException;
import com.argusvane.datum.sandbox.protocol.DefinitionDepth;
import com.argusvane.datum.sandbox.protocol.JsonSize;
import com.argusvane.datum.sandbox.protocol.SandboxException;
import com.argusvane.datum.forms.CurrentDefinition;
import com.argusvane.datum.forms.DefinitionRefusedException;
import com.argusvane.datum.forms.DefinitionService;
import com.argusvane.datum.forms.DefinitionVerdict;
import com.argusvane.datum.forms.FormDefinitionRepository;
import com.argusvane.datum.forms.FormKeys;
import com.argusvane.datum.forms.FormNotFoundException;
import com.argusvane.datum.forms.FormOutdatedException;
import com.argusvane.datum.forms.FormStoreReadOnlyException;
import com.argusvane.datum.forms.SavedForm;
import com.argusvane.datum.forms.snapshot.SnapshotNotRecordedException;
import com.argusvane.datum.forms.translation.StoredCatalog;
import com.argusvane.datum.forms.translation.TranslationCatalog;
import com.argusvane.datum.forms.translation.TranslationCatalogStore;
import com.argusvane.datum.ui.UiSettings;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.Principal;
import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Predicate;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The builder's writes with no transport in them: save, create and the host catalog,
 * judged by the kernel's {@code check} (sandbox ABI 2.13.0) so an unchecked or refused definition is never stored, and
 * answered as a {@link BuilderOutcome}. {@link BuilderApi} is the HTTP side over it; an
 * import job or a git sync calls it directly.
 *
 * <p>A save, in order, each refusal before anything costlier:
 * <ol>
 *   <li>{@link BuilderOutcome.NotFound}: no form has the key;</li>
 *   <li>{@link BuilderOutcome.TooLarge}: the definition takes more than {@link #maxDefinitionBytes()} as JSON text
 *       ({@link JsonSize}: the fewest bytes any text of the tree can take), in the place of the routes' 413 on the bytes,
 *       so an import cannot store a form the routes would then refuse every save of;</li>
 *   <li>{@link BuilderOutcome.Outdated}: the caller's expected hash is not the current definition's;</li>
 *   <li>{@link BuilderOutcome.Malformed}: not strict JSON (an unpaired UTF-16 surrogate in a string or a key);</li>
 *   <li>{@link BuilderOutcome.Refused} {@code definition.refused}: the host's own reading of the shape
 *       ({@link DefinitionShape}), then the id that must stay the form's ({@code definition.id.mismatch});</li>
 *   <li>{@link BuilderOutcome.Malformed}: the language changes are not valid;</li>
 *   <li>{@link BuilderOutcome.Refused}: a number JSON cannot write ({@code definition.number.nonFinite});</li>
 *   <li>the application's {@link BuilderSaveCustomizer}s, in order: {@link BuilderOutcome.Declined} for a
 *       refusal; what they leave is held to the size, strict-JSON, shape and finite-number rules again (the same outcomes)
 *       and a changed {@code id} fails the save;</li>
 *   <li>the kernel's check: {@code definition.refused} with the kernel's codes, {@code definition.tooDeep} or
 *       {@code definition.tooCostly}, and {@link BuilderOutcome.Unavailable} when the sandbox could not answer (fail
 *       closed);</li>
 *   <li>the application's {@link BuilderSaveValidator}s, every one, over the kernel's verdict:
 *       {@link BuilderOutcome.Declined} with their errors; their warnings ride along;</li>
 *   <li>the store: the hash checked again under the form's lock, the repository write ({@link BuilderOutcome.ReadOnly}
 *       for a repository that cannot save), the catalog moved for the language changes, the snapshot and
 *       {@code FormDefinitionSavedEvent} ({@link DefinitionService#saved}), all under the hash of what the repository
 *       stored, the one the read endpoint answers ({@link BuilderOutcome.Saved}).</li>
 * </ol>
 * A create has no expected hash: the size first, then the key is the definition's id ({@code definition.id.invalid} for one
 * no form may have), and {@link BuilderOutcome.Exists} after the shape when a form has it; the hooks run as for a save. A
 * catalog write (no hook runs for it): the form's
 * existence ({@link BuilderOutcome.NotFound}, before the catalog store is asked anything), the size, the expected etag
 * ({@link BuilderOutcome.CatalogOutdated}), a catalog nested past {@value #MAX_CATALOG_DEPTH} ({@link BuilderOutcome.Malformed}),
 * the catalog's problems ({@code catalog.invalid}), then under the lock the form's existence again and the write.
 *
 * <p>The routes ({@link BuilderApi}) cap the bytes themselves and take the steps after the size, so a body they read is
 * measured once.
 *
 * <p>Who may build is never asked here: on the routes it is the application's security in front of them, for
 * another caller the code that calls the service. The principal each write takes is who saves, for the application's own
 * use (it decides nothing here).
 *
 * <p>Methods block (the kernel runs for a check).
 */
public final class BuilderService {

    private static final Logger LOG = LoggerFactory.getLogger(BuilderService.class);

    /** The deepest catalog read (deeper is not JSON to the catalog's reader). */
    public static final int MAX_CATALOG_DEPTH = 32;

    /** How many times a catalog move is tried when the catalog changes under it. */
    private static final int CATALOG_ATTEMPTS = 3;

    /** The most structure warnings worded one by one before "and N more.". */
    private static final int MAX_WORDED_WARNINGS = 10;

    private final FormDefinitionRepository repository;
    private final DefinitionService definitions;
    private final TranslationCatalogStore translations;
    private final List<String> types;
    private final Clock clock;
    private final long maxDefinitionBytes;
    private final List<BuilderSaveCustomizer> customizers;
    private final List<BuilderSaveValidator> validators;
    private final SaveLocks locks = new SaveLocks();

    /** A builder over the defaults: the default definition cap, the system clock, no types, no hooks. */
    public static Builder builder() {
        return new Builder();
    }

    /**
     * Builds a {@link BuilderService}: the repository, the definition service and the translation store are required, the rest
     * has a default. The one construction style, so a hook added later is one more method here.
     */
    public static final class Builder {

        private FormDefinitionRepository repository;
        private DefinitionService definitions;
        private TranslationCatalogStore translations;
        private List<String> types = List.of();
        private long maxDefinitionBytes = UiSettings.DEFAULT_MAX_DEFINITION_BYTES;
        private Clock clock = Clock.systemUTC();
        private List<BuilderSaveCustomizer> customizers = List.of();
        private List<BuilderSaveValidator> validators = List.of();

        private Builder() {
        }

        /** Where the forms are written. */
        public Builder repository(FormDefinitionRepository value) { this.repository = value; return this; }

        /** The definition service a save is recorded through. */
        public Builder definitions(DefinitionService value) { this.definitions = value; return this; }

        /** Where the translation catalogs are kept. */
        public Builder translations(TranslationCatalogStore value) { this.translations = value; return this; }

        /** The component types this host draws (the assets manifest's {@code knownComponentTypes}), sent to the kernel; null for none. */
        public Builder types(List<String> value) { this.types = value; return this; }

        /** {@code datum.builder.max-definition-size}, for definitions and catalogs alike. */
        public Builder maxDefinitionBytes(long value) { this.maxDefinitionBytes = value; return this; }

        /** The clock the service reads. */
        public Builder clock(Clock value) { this.clock = value; return this; }

        /** Hooks that adjust or refuse a definition before the kernel checks it, in the framework's order. */
        public Builder customizers(List<BuilderSaveCustomizer> value) { this.customizers = value; return this; }

        /** Hooks that judge a definition the kernel accepted, before it is stored. */
        public Builder validators(List<BuilderSaveValidator> value) { this.validators = value; return this; }

        /**
         * @throws NullPointerException for a missing repository, definition service or translation store
         * @throws com.argusvane.datum.core.DatumConfigurationException for a definition cap below one byte
         */
        public BuilderService build() {
            return new BuilderService(this);
        }
    }

    private BuilderService(Builder builder) {
        List<BuilderSaveCustomizer> customizers = builder.customizers;
        List<BuilderSaveValidator> validators = builder.validators;
        long maxDefinitionBytes = builder.maxDefinitionBytes;
        FormDefinitionRepository repository = builder.repository;
        DefinitionService definitions = builder.definitions;
        TranslationCatalogStore translations = builder.translations;
        List<String> types = builder.types;
        Clock clock = builder.clock;
        this.customizers = List.copyOf(Objects.requireNonNull(customizers, "customizers"));
        this.validators = List.copyOf(Objects.requireNonNull(validators, "validators"));
        if (maxDefinitionBytes < 1) {
            throw new DatumConfigurationException("datum.builder.max-definition-size", "datum.builder.max-definition-size must be at least one byte.");
        }
        this.maxDefinitionBytes = maxDefinitionBytes;
        this.repository = Objects.requireNonNull(repository, "repository");
        this.definitions = Objects.requireNonNull(definitions, "definitions");
        this.translations = Objects.requireNonNull(translations, "translations");
        this.types = types == null ? List.of() : types.stream().sorted().distinct().toList();
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    /** The size cap a definition or a catalog handed to this service is held to, in bytes of its JSON text. */
    public long maxDefinitionBytes() {
        return maxDefinitionBytes;
    }

    // ------------------------------------------------------------------ the writes

    /** {@link #save(String, JsonNode, String, LocaleChanges, Principal)} with no language change. */
    public BuilderOutcome save(String key, JsonNode definition, String expectedSha256, Principal principal) {
        return save(key, definition, expectedSha256, LocaleChanges.none(), principal);
    }

    /**
     * Saves a definition of an existing form.
     *
     * @param expectedSha256 the hash of the definition this one builds on, or null to save as sent
     * @param changes the languages the author removed or renamed since that definition, which the catalog moves with
     * @param principal who saves, or null
     */
    public BuilderOutcome save(String key, JsonNode definition, String expectedSha256, LocaleChanges changes, Principal principal) {
        Objects.requireNonNull(definition, "definition");
        Objects.requireNonNull(changes, "changes");
        // The route's order: 404, then the 413 (on the bytes there, on the tree here), then the precondition.
        Optional<CurrentDefinition> current = FormKeys.isValid(key) ? currentOf(key) : Optional.empty();
        if (current.isEmpty()) {
            return new BuilderOutcome.NotFound(key);
        }
        if (JsonSize.exceeds(definition, maxDefinitionBytes)) {
            return new BuilderOutcome.TooLarge(maxDefinitionBytes);
        }
        Predicate<String> precondition = expected(expectedSha256);
        BuilderOutcome outdated = outdated(current.get(), precondition);
        return outdated != null ? outdated : saveAdmitted(key, definition, precondition, () -> Optional.of(changes), principal);
    }

    /** {@link #create(JsonNode, LocaleChanges, Principal)} with no language change. */
    public BuilderOutcome create(JsonNode definition, Principal principal) {
        return create(definition, LocaleChanges.none(), principal);
    }

    /** Creates a form under its definition's id. */
    public BuilderOutcome create(JsonNode definition, LocaleChanges changes, Principal principal) {
        Objects.requireNonNull(definition, "definition");
        Objects.requireNonNull(changes, "changes");
        if (JsonSize.exceeds(definition, maxDefinitionBytes)) {
            return new BuilderOutcome.TooLarge(maxDefinitionBytes);
        }
        return createAdmitted(definition, () -> Optional.of(changes), principal);
    }

    /**
     * Replaces a form's host catalog, from {@code {catalog: {...}}} or the bare catalog, stored normalized.
     *
     * @param expectedEtag the etag of the catalog this one builds on, or null to replace whatever is there
     */
    public BuilderOutcome saveTranslations(String key, JsonNode catalog, String expectedEtag, Principal principal) {
        Objects.requireNonNull(catalog, "catalog");
        // The route's order: 404 before anything (the catalog store is never asked about a key no form has), then the
        // size, then the etag. Checked again under the lock before the write.
        if (!FormKeys.isValid(key) || repository.find(key).isEmpty()) {
            return new BuilderOutcome.NotFound(key);
        }
        if (JsonSize.exceeds(catalog, maxDefinitionBytes)) {
            return new BuilderOutcome.TooLarge(maxDefinitionBytes);
        }
        String expected = null;
        if (expectedEtag != null) {
            StoredCatalog stored = translations.read(key);
            if (!same(expectedEtag, stored.etag())) {
                return new BuilderOutcome.CatalogOutdated(stored.etag());
            }
            expected = stored.etag();
        }
        return translationsAdmitted(key, catalog, expected, principal);
    }

    // ------------------------------------------------------------------ the steps the routes share

    /**
     * The checks a save makes before it reads the definition: existence, then the precondition. The route makes them
     * before it reads the body, with the request's If-Match as the precondition.
     *
     * @return the refusal, or null to go on
     */
    BuilderOutcome precondition(String key, Predicate<String> holds) {
        Optional<CurrentDefinition> current = FormKeys.isValid(key) ? currentOf(key) : Optional.empty();
        if (current.isEmpty()) {
            return new BuilderOutcome.NotFound(key);
        }
        return outdated(current.get(), holds);
    }

    /** {@link BuilderOutcome.Outdated} when the precondition does not hold of the current definition, else null. */
    private static BuilderOutcome outdated(CurrentDefinition current, Predicate<String> holds) {
        if (!holds.test(current.sha256())) {
            return new BuilderOutcome.Outdated(current.sha256(), versionOf(current.definition()));
        }
        return null;
    }

    /**
     * A save after {@link #precondition}: the route hands the language changes as it reads them from its header (empty
     * when they are not valid), so the header is judged in its place, after the shape.
     */
    BuilderOutcome saveAdmitted(String key, JsonNode decoded, Predicate<String> precondition, Supplier<Optional<LocaleChanges>> changes,
                                Principal principal) {
        Objects.requireNonNull(decoded, "definition");
        if (holdsUnpairedSurrogate(decoded)) {
            return new BuilderOutcome.Malformed("The definition is not JSON.");
        }
        List<DefinitionShape.Finding> found = new ArrayList<>(DefinitionShape.problemList(decoded));
        if (found.isEmpty() && !key.equals(decoded.path("id").stringValue(null))) {
            found.add(new DefinitionShape.Finding("definition.id.mismatch", "definition",
                "The form id must stay \"" + key + "\": it keys every submission. Change it back in the Identity section.", null));
        }
        if (!found.isEmpty()) {
            return refused(found);
        }
        ObjectNode definition = (ObjectNode) decoded;
        Optional<LocaleChanges> read = changes.get();
        if (read.isEmpty()) {
            return invalidChanges();
        }
        if (DefinitionShape.hasNonFiniteNumber(definition)) {
            return nonFinite();
        }
        return hooksAndStore(key, definition, read.get(), precondition, false, principal);
    }

    /** A create, the route's language changes handed as {@link #saveAdmitted} takes them. */
    BuilderOutcome createAdmitted(JsonNode decoded, Supplier<Optional<LocaleChanges>> changes, Principal principal) {
        Objects.requireNonNull(decoded, "definition");
        if (holdsUnpairedSurrogate(decoded)) {
            return new BuilderOutcome.Malformed("The definition is not JSON.");
        }
        List<DefinitionShape.Finding> found = new ArrayList<>(DefinitionShape.problemList(decoded));
        String key = decoded.path("id").stringValue(null);
        if (found.isEmpty() && (key == null || !FormKeys.isValid(key))) {
            found.add(new DefinitionShape.Finding("definition.id.invalid", "definition", "The form id \""
                + DefinitionShape.codePoints(String.valueOf(key), 64)
                + "\" may hold only letters, digits, \"_\", \".\" and \"-\", at most 128: it is the form's address.", null));
        }
        if (!found.isEmpty()) {
            return refused(found);
        }
        Optional<CurrentDefinition> existing = currentOf(key);
        if (existing.isPresent()) {
            return new BuilderOutcome.Exists(key, existing.get().sha256());
        }
        ObjectNode definition = (ObjectNode) decoded;
        Optional<LocaleChanges> read = changes.get();
        if (read.isEmpty()) {
            return invalidChanges();
        }
        if (DefinitionShape.hasNonFiniteNumber(definition)) {
            return nonFinite();
        }
        return hooksAndStore(key, definition, read.get(), sha -> true, true, principal);
    }

    /** A catalog write after the precondition on its etag: {@code expected} is the etag that held, or null. */
    BuilderOutcome translationsAdmitted(String key, JsonNode decoded, String expected, Principal principal) {
        Objects.requireNonNull(decoded, "catalog");
        if (DefinitionDepth.jsonDepth(decoded) > MAX_CATALOG_DEPTH || holdsUnpairedSurrogate(decoded)) {
            return new BuilderOutcome.Malformed("The catalog is not JSON.");
        }
        JsonNode catalog = decoded.isObject() && decoded.has("catalog") ? decoded.get("catalog") : decoded;
        List<TranslationCatalog.Problem> problems = TranslationCatalog.problems(catalog);
        if (!problems.isEmpty()) {
            List<DefinitionShape.Finding> list = new ArrayList<>();
            for (TranslationCatalog.Problem problem : problems) {
                // The finding's "where" is the JSON path of the offence inside the catalog.
                list.add(new DefinitionShape.Finding("catalog.invalid", problem.path(), problem.message(), null));
            }
            return new BuilderOutcome.Refused("catalog.invalid", list, null);
        }
        ObjectNode clean = TranslationCatalog.normalize(catalog);
        String etag;
        ReentrantLock lock = locks.of(key);
        lock.lock();
        try {
            if (!FormKeys.isValid(key) || repository.find(key).isEmpty()) {
                return new BuilderOutcome.NotFound(key);
            }
            etag = translations.write(key, clean, expected);
        } catch (FormOutdatedException e) {
            return new BuilderOutcome.CatalogOutdated(e.currentSha256());
        } finally {
            lock.unlock();
        }
        return new BuilderOutcome.CatalogSaved(key, etag, clean, now());
    }

    // ------------------------------------------------------------------ the hooks

    /**
     * The customizers, the host's rules again over what they left, the kernel's check, the validators, then the store. With
     * no hook this is the kernel's check and the store.
     */
    private BuilderOutcome hooksAndStore(String key, ObjectNode sent, LocaleChanges changes, Predicate<String> precondition, boolean creating,
                                         Principal principal) {
        ObjectNode definition = sent;
        if (!customizers.isEmpty()) {
            BuilderSaveDraft draft = new BuilderSaveDraft(key, creating, principal, sent.deepCopy());
            try {
                for (BuilderSaveCustomizer customizer : customizers) {
                    customizer.customize(draft);
                }
            } catch (HookRefusedException refused) {
                return new BuilderOutcome.Declined(refused);
            }
            definition = draft.definition();
            BuilderOutcome again = heldAgain(key, definition);
            if (again != null) {
                return again;
            }
        }
        Checked checked = check(definition);
        if (checked.refusal() != null) {
            return checked.refusal();
        }
        List<String> hookWarnings = new ArrayList<>();
        if (!validators.isEmpty()) {
            List<HookProblem> errors = new ArrayList<>();
            List<HookProblem> warnings = new ArrayList<>();
            try {
                for (BuilderSaveValidator validator : validators) {
                    HookFindings found = validator.validate(new BuilderSaveCandidate(key, creating, principal, definition.deepCopy(), checked.verdict()));
                    if (found == null) {
                        throw new IllegalStateException("A BuilderSaveValidator answered null; answer HookFindings.NONE to let the save go on.");
                    }
                    errors.addAll(found.errors());
                    warnings.addAll(found.warnings());
                }
            } catch (HookRefusedException refused) {
                return new BuilderOutcome.Declined(refused);
            }
            if (!errors.isEmpty()) {
                return new BuilderOutcome.Declined(HookRefusedException.invalid(errors));
            }
            warnings.forEach(warning -> hookWarnings.add(warning.message() != null ? warning.message() : warning.code()));
        }
        return store(key, definition, checked.verdict(), changes, precondition, creating, hookWarnings);
    }

    /**
     * What the customizers left, held to the host's rules the author's definition passed: the form's id unchanged (else
     * the save fails: the id is the form's key), then the size, strict JSON, the shape and finite numbers, with the same
     * outcomes as for the author's own definition.
     *
     * @return the refusal, or null to go on
     */
    private BuilderOutcome heldAgain(String key, ObjectNode definition) {
        if (!key.equals(definition.path("id").stringValue(null))) {
            throw new IllegalStateException("A BuilderSaveCustomizer changed the id of form " + key
                + ": the id is the form's key and what every submission names, so it is never customized.");
        }
        if (JsonSize.exceeds(definition, maxDefinitionBytes)) {
            return new BuilderOutcome.TooLarge(maxDefinitionBytes);
        }
        if (holdsUnpairedSurrogate(definition)) {
            return new BuilderOutcome.Malformed("The definition is not JSON.");
        }
        List<DefinitionShape.Finding> found = DefinitionShape.problemList(definition);
        if (!found.isEmpty()) {
            return refused(found);
        }
        return DefinitionShape.hasNonFiniteNumber(definition) ? nonFinite() : null;
    }

    // ------------------------------------------------------------------ the save itself

    private BuilderOutcome store(String key, ObjectNode definition, DefinitionVerdict verdict, LocaleChanges changes,
                                 Predicate<String> precondition, boolean creating, List<String> hookWarnings) {
        List<String> warnings = new ArrayList<>();
        String previous;
        String sha256;
        ObjectNode catalog;
        Set<String> removed;
        String version;
        ReentrantLock lock = locks.of(key);
        lock.lock();
        try {
            // Checked again right before the write: the kernel ran outside the lock, and another save may have landed
            // meanwhile.
            Optional<CurrentDefinition> now = currentOf(key);
            if (creating && now.isPresent()) {
                return new BuilderOutcome.Exists(key, now.get().sha256());
            }
            if (!creating && now.isEmpty()) {
                return new BuilderOutcome.NotFound(key);
            }
            if (now.isPresent() && !precondition.test(now.get().sha256())) {
                return new BuilderOutcome.Outdated(now.get().sha256(), versionOf(now.get().definition()));
            }
            previous = now.map(CurrentDefinition::sha256).orElse(null);
            JsonNode before = now.map(CurrentDefinition::definition).orElse(null);
            SavedForm saved;
            try {
                // The hash the lock just checked, handed on so a database repository can refuse the write across
                // instances (FormDefinitionRepository#save(definition, expectedSha256)).
                saved = repository.save(definition.deepCopy(), previous);
            } catch (FormOutdatedException raced) {
                return new BuilderOutcome.Outdated(raced.currentSha256(), now.map(c -> versionOf(c.definition())).orElse(null));
            } catch (FormStoreReadOnlyException readOnly) {
                return new BuilderOutcome.ReadOnly(readOnly);
            }
            CurrentDefinition stored = storedAs(key, definition, saved, warnings);
            // The locales whose entries this save drops: the changes' removals, and every locale the definition no longer
            // declares, less the ones a rename moved (their texts live on under the new code).
            removed = new LinkedHashSet<>(TranslationCatalog.removedLocales(before, stored.definition()));
            changes.renamed().forEach(move -> removed.remove(move.from()));
            removed.addAll(changes.removed());
            CatalogMove move = moveCatalog(key, before, stored.definition(), changes, warnings);
            catalog = move.catalog();
            if (!move.moved()) {
                // The client must not drop locales the server kept: it hears of the removal only when the
                // catalog really lost them.
                removed.clear();
            }
            sha256 = recordSave(key, stored, previous, warnings);
            version = versionOf(stored.definition());
        } finally {
            lock.unlock();
        }
        List<String> answered = new ArrayList<>(wordedWarnings(definition, verdict));
        answered.addAll(hookWarnings);
        answered.addAll(warnings);
        return new BuilderOutcome.Saved(key, sha256, version, removed, catalog, answered, verdict.structureWarnings(), creating, now());
    }

    /**
     * What the repository holds after the save, as the read endpoint will answer it. Normally the definition the kernel
     * checked, under its own hash. A repository that stores something else (it drops a member, rewrites a number) answers
     * another hash in its {@link SavedForm}: the definition is then read back, so the ETag, the snapshot and the saved
     * event name what {@code GET .../definition?public=false} serves, and a WARN says the repository changed what it was
     * given.
     */
    private CurrentDefinition storedAs(String key, ObjectNode definition, SavedForm saved, List<String> warnings) {
        String checked = DefinitionService.hash(definition);
        if (saved != null && checked.equals(saved.sha256())) {
            return new CurrentDefinition(definition, checked);
        }
        try {
            CurrentDefinition reread = repository.current(key);
            LOG.warn("The repository stored form {} under hash {}, not the hash {} of the definition it was given: it changes what it "
                + "stores. The answer, the snapshot and the saved event name what it stored.", key, reread.sha256(), checked);
            return reread;
        } catch (RuntimeException e) {
            LOG.warn("Form {} was saved, but the repository answered another hash and the stored definition could not be read back.", key, e);
            warnings.add("The form was saved, but the server could not read it back; reload the form before the next change.");
            return new CurrentDefinition(definition, checked);
        }
    }

    /** The catalog after a save, and whether it now matches the save (false when the move was given up). */
    private record CatalogMove(ObjectNode catalog, boolean moved) {
    }

    /**
     * Moves the catalog with the save: the changes first, then the entries of every locale the definition no longer
     * declares ({@code TranslationCatalog.afterSave}), a rename having moved its entries out of the way already. Written
     * with the etag read, so a catalog save racing this one is not overwritten: the move is read and applied again, up to
     * three times. The definition is stored by then; a catalog that cannot be moved leaves a warning, never a failed save.
     */
    private CatalogMove moveCatalog(String key, JsonNode before, JsonNode after, LocaleChanges changes, List<String> warnings) {
        for (int attempt = 1; attempt <= CATALOG_ATTEMPTS; attempt++) {
            StoredCatalog stored;
            try {
                stored = translations.read(key);
            } catch (RuntimeException e) {
                LOG.warn("The translations of form {} could not be read after its definition was saved.", key, e);
                warnings.add("The form was saved, but its translations could not be read; check the host's translations.");
                return new CatalogMove(TranslationCatalog.empty(), false);
            }
            ObjectNode current = TranslationCatalog.normalize(stored.catalog());
            ObjectNode next = changes.isEmpty() ? current : changes.applyTo(current);
            next = TranslationCatalog.afterSave(next, before, after);
            if (next.equals(current)) {
                return new CatalogMove(current, true);
            }
            try {
                translations.write(key, next, stored.etag());
                return new CatalogMove(next, true);
            } catch (FormOutdatedException raced) {
                LOG.debug("The catalog of form {} changed while a save moved it; trying again.", key);
            } catch (RuntimeException e) {
                LOG.warn("The translations of form {} could not be moved with its saved definition.", key, e);
                warnings.add("The form was saved, but its translations could not be moved to the new languages; check the host's translations.");
                return new CatalogMove(current, false);
            }
        }
        LOG.warn("The translations of form {} kept changing while a save moved them; they were left as they were.", key);
        warnings.add("The form was saved, but its translations changed at the same time and were not moved; check the host's translations.");
        try {
            return new CatalogMove(TranslationCatalog.normalize(translations.read(key).catalog()), false);
        } catch (RuntimeException e) {
            // The definition is stored: a catalog that cannot be read now must not turn the save into a failure.
            LOG.warn("The translations of form {} could not be read after a save gave up moving them.", key, e);
            return new CatalogMove(TranslationCatalog.empty(), false);
        }
    }

    /**
     * The snapshot and the saved event. The definition is stored by now, so a snapshot table that cannot be written must
     * not answer as if the save failed: it is logged, said in the answer, and the snapshot is tried again on the next read
     * ({@link DefinitionService#current}). Only the store's own failure is this warning: {@link DefinitionService#saved}
     * names it {@link SnapshotNotRecordedException} where it fails (a cache asked afterwards could not
     * tell a revert to an earlier hash from a recorded one). The saved event is not the snapshot: through the host's guarded
     * default publisher a listener that throws is logged there and is no save warning, and an application's
     * own publisher that throws once the snapshot is recorded owns that failure, which reaches the caller as thrown,
     * never as this warning, whose words would name the wrong cause.
     */
    private String recordSave(String key, CurrentDefinition stored, String previous, List<String> warnings) {
        try {
            definitions.saved(key, stored.definition(), previous);
        } catch (SnapshotNotRecordedException e) {
            LOG.warn("Form {} was saved, but recording its snapshot failed.", key, e);
            warnings.add("The form was saved, but the server could not record this version; it is recorded again on the next read.");
        }
        // The hash the read endpoint answers for what is stored, so the next If-Match matches.
        return stored.sha256();
    }

    // ------------------------------------------------------------------ the kernel's check

    /** The kernel's verdict, or the refusal for each way it can fail. */
    private record Checked(DefinitionVerdict verdict, BuilderOutcome refusal) {
    }

    private Checked check(ObjectNode definition) {
        try {
            return new Checked(definitions.check(definition, types, List.of()), null);
        } catch (DefinitionRefusedException refused) {
            List<DefinitionShape.Finding> findings = new ArrayList<>();
            for (DefinitionRefusedException.Refusal refusal : refused.errors()) {
                // A formula problem is worded "where: message", a structure problem through describe().
                String words = refusal.kind() == DefinitionRefusedException.Kind.FORMULA
                    ? refusal.where() + ": " + (refusal.message() != null && !refusal.message().isEmpty() ? refusal.message() : refusal.code())
                    : DefinitionShape.describe(refusal.code(), refusal.where(), refusal.limit(), refusal.message());
                findings.add(new DefinitionShape.Finding(refusal.code(), refusal.where(), words, refusal.limit()));
            }
            return new Checked(null, refused(findings));
        } catch (DefinitionTooDeepException deep) {
            return new Checked(null, typed("definition.tooDeep", deep.getMessage(), deep));
        } catch (SandboxException e) {
            if ("definition.tooCostly".equals(e.typedCode())) {
                // The definition's size or shape is the cause, so the author is told, not the runtime: a retry would burn
                // the same budget.
                return new Checked(null, typed("definition.tooCostly",
                    "The definition is too large or too complex to check within the time the server allows, so it was not saved. "
                        + "Split it into smaller forms or remove components, options or long paths.", e));
            }
            if (e.reason() == SandboxException.Reason.BUSY) {
                // Every sandbox slot was taken: the busy answer every run gets (503 server.busy, Retry-After), not an outage.
                return new Checked(null, new BuilderOutcome.Unavailable("server.busy",
                    "The server is busy checking other forms, so the form was not saved. Try again in a moment.", e));
            }
            return new Checked(null, unavailable(e));
        } catch (RuntimeException e) {
            // Fail closed: a check that gave no verdict never lets a definition through.
            return new Checked(null, unavailable(e));
        }
    }

    private static BuilderOutcome unavailable(RuntimeException cause) {
        return new BuilderOutcome.Unavailable("server.unavailable",
            "The form could not be checked because the server runtime is not available, so it was not saved. "
                + "Try again, or ask the site administrator.", cause);
    }

    /**
     * The warnings a stored definition rides back with: the unknown types in one sentence, then up to ten of the kernel's
     * other structure warnings in words ("and N more." after them).
     */
    private List<String> wordedWarnings(ObjectNode definition, DefinitionVerdict verdict) {
        List<String> out = new ArrayList<>();
        if (!types.isEmpty()) {
            List<String> unknown = DefinitionShape.unknownTypes(definition, types);
            if (!unknown.isEmpty()) {
                out.add("The form uses " + String.join(", ", unknown)
                    + ", which no component this site serves draws: the form shows a note in their place.");
            }
        }
        List<DefinitionProblem> others = verdict.structureWarnings().stream()
            .filter(warning -> !"component.type.unknown".equals(warning.code()))
            .toList();
        others.stream().limit(MAX_WORDED_WARNINGS)
            .forEach(warning -> out.add(DefinitionShape.describe(warning.code(), warning.where(), warning.limit(), warning.message())));
        if (others.size() > MAX_WORDED_WARNINGS) {
            out.add("and " + (others.size() - MAX_WORDED_WARNINGS) + " more.");
        }
        return out;
    }

    // ------------------------------------------------------------------ helpers

    private static BuilderOutcome refused(List<DefinitionShape.Finding> findings) {
        return new BuilderOutcome.Refused("definition.refused", findings, null);
    }

    private static BuilderOutcome typed(String code, String message, Throwable cause) {
        return new BuilderOutcome.Refused(code, List.of(new DefinitionShape.Finding(code, "definition", message, null)), cause);
    }

    private static BuilderOutcome invalidChanges() {
        return new BuilderOutcome.Malformed("The language changes are not valid.");
    }

    private static BuilderOutcome nonFinite() {
        return refused(List.of(new DefinitionShape.Finding("definition.number.nonFinite", "definition",
            "The definition holds a number that JSON cannot write.", null)));
    }

    /** The precondition an expected hash makes: none for null, else that exact hash (compared in constant time). */
    private static Predicate<String> expected(String expectedSha256) {
        return expectedSha256 == null ? sha -> true : sha -> same(expectedSha256, sha);
    }

    private static boolean same(String a, String b) {
        return b != null && MessageDigest.isEqual(a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
    }

    private Optional<CurrentDefinition> currentOf(String key) {
        try {
            return Optional.of(repository.current(key));
        } catch (FormNotFoundException e) {
            return Optional.empty();
        }
    }

    private static String versionOf(JsonNode definition) {
        JsonNode version = definition == null ? null : definition.get("version");
        return version != null && version.isString() ? version.stringValue() : "";
    }

    private Instant now() {
        return Instant.now(clock).truncatedTo(ChronoUnit.SECONDS);
    }

    /**
     * Whether a parsed value holds what strict JSON refuses but Jackson reads: an unpaired UTF-16 surrogate in a string or a
     * key. The route's reader refuses such a body before it is parsed here; a caller handing a tree meets it here, before
     * the kernel's request could not be written for it. Iterative.
     */
    static boolean holdsUnpairedSurrogate(JsonNode value) {
        Deque<JsonNode> stack = new ArrayDeque<>();
        stack.push(value);
        while (!stack.isEmpty()) {
            JsonNode node = stack.pop();
            if (node.isString() && unpaired(node.stringValue())) {
                return true;
            }
            if (node.isObject()) {
                for (Map.Entry<String, JsonNode> entry : node.properties()) {
                    if (unpaired(entry.getKey())) {
                        return true;
                    }
                    stack.push(entry.getValue());
                }
            } else if (node.isArray()) {
                for (JsonNode child : node.values()) {
                    stack.push(child);
                }
            }
        }
        return false;
    }

    private static boolean unpaired(String text) {
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (Character.isHighSurrogate(c)) {
                if (i + 1 < text.length() && Character.isLowSurrogate(text.charAt(i + 1))) {
                    i++;
                    continue;
                }
                return true;
            }
            if (Character.isLowSurrogate(c)) {
                return true;
            }
        }
        return false;
    }
}
