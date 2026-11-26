package com.argusvane.datum.forms;

import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import com.argusvane.datum.core.DatumEventPublisher;
import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.core.canonical.CanonicalJson;
import com.argusvane.datum.core.contracts.DatumJson;
import com.argusvane.datum.core.contracts.InspectAnswer;
import com.argusvane.datum.core.contracts.InspectCheckAnswer;
import com.argusvane.datum.sandbox.protocol.DefinitionDepth;
import com.argusvane.datum.sandbox.protocol.RuleModule;
import com.argusvane.datum.sandbox.protocol.SandboxException;
import com.argusvane.datum.sandbox.protocol.Sandbox;
import com.argusvane.datum.forms.snapshot.DefinitionSnapshotStore;
import com.argusvane.datum.forms.snapshot.SnapshotNotRecordedException;
import java.time.Clock;
import java.time.Duration;
import java.security.Principal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * What the packages do with a definition besides storing it: serve the current one with its hash, serve the
 * public copy, resolve an old version by hash, and ask the kernel whether a definition may be saved.
 *
 * <p>The hash of a definition is the SHA-256 of its canonical JSON ({@link CanonicalJson#digest}), the same
 * digest the engine and every host take (sandbox ABI 2.9.0, the shared {@code canonical.json}), so a definition has
 * one name wherever it is drawn.
 *
 * <p>The sandbox is looked up lazily: a definition with no {@code server-secret} rule is its own public copy
 * and needs no run, so a host whose runtime is down still serves those.
 *
 * <p>A public copy on its way to a filler passes the application's {@link DefinitionCustomizer}s first:
 * {@link #publicCopyFor}.
 */
public final class DefinitionService {

    private static final Logger LOG = LoggerFactory.getLogger(DefinitionService.class);

    /** How long a definition the kernel could not check in time is refused without a run; {@code datum.forms.too-costly-memory}. */
    static final Duration TOO_COSTLY_MEMORY = Duration.ofSeconds(300);

    private final FormDefinitionRepository repository;
    private final DefinitionSnapshotStore snapshots;
    private final Supplier<? extends Sandbox> sandbox;
    private final DatumEventPublisher events;
    private final SingleFlight<ObjectNode> publicCopies;
    private final Cache<String, Boolean> recorded;
    private final SingleFlight<DefinitionVerdict> verdicts;
    /** The refusals of definitions too costly to check, forgotten after the configured memory on the injected clock. */
    private final Cache<String, SandboxException> costly;
    private final Clock clock;
    private final List<DefinitionCustomizer> customizers;
    /** The public copies of customized definitions, by stored hash and the customizers' keys. */
    private final SingleFlight<Variant> variants;
    private final AtomicBoolean variantKeyWarned = new AtomicBoolean();

    /** A customized definition's public copy and the hash of the customized definition it was made of. */
    private record Variant(String customizedSha256, ObjectNode publicCopy) {
    }

    /** A builder over the defaults: a 256-copy cache, the system clock, five minutes of memory, no customizers. */
    public static Builder builder() {
        return new Builder();
    }

    /**
     * Builds a {@link DefinitionService}: the repository, the snapshot store, the sandbox and the publisher are required; the
     * rest has a default. One construction style for the service, so a seam added later is one more method here and not
     * another positional constructor.
     */
    public static final class Builder {

        /** The default size of the public-copy cache. */
        public static final int DEFAULT_PUBLIC_CACHE_SIZE = FormsSettings.DEFAULT_PUBLIC_COPY_CACHE_SIZE;

        private FormDefinitionRepository repository;
        private DefinitionSnapshotStore snapshots;
        private Supplier<? extends Sandbox> sandbox;
        private DatumEventPublisher events;
        private int publicCacheSize = DEFAULT_PUBLIC_CACHE_SIZE;
        private Clock clock = Clock.systemUTC();
        private Duration tooCostlyMemory = TOO_COSTLY_MEMORY;
        private List<DefinitionCustomizer> customizers = List.of();

        private Builder() {
        }

        /** Where the forms' current definitions come from. */
        public Builder repository(FormDefinitionRepository value) { this.repository = value; return this; }

        /** Where every definition a form has had is kept. */
        public Builder snapshots(DefinitionSnapshotStore value) { this.snapshots = value; return this; }

        /** The sandbox service, or a supplier that throws {@link ProgramUnavailableException} when the runtime is not configured. */
        public Builder sandbox(Supplier<? extends Sandbox> value) { this.sandbox = value; return this; }

        /** Where {@link FormDefinitionSavedEvent} goes; published as given. */
        public Builder events(DatumEventPublisher value) { this.events = value; return this; }

        /** How many public copies are kept, by definition hash. */
        public Builder publicCacheSize(int value) { this.publicCacheSize = value; return this; }

        /** The clock the too-costly memory runs on. */
        public Builder clock(Clock value) { this.clock = value; return this; }

        /** How long a refusal of a too-costly definition is remembered ({@code datum.forms.too-costly-memory}). */
        public Builder tooCostlyMemory(Duration value) { this.tooCostlyMemory = value; return this; }

        /** The application's definition customizers, in the framework's order. */
        public Builder customizers(List<DefinitionCustomizer> value) { this.customizers = value; return this; }

        /** @throws NullPointerException for a missing repository, snapshot store, sandbox or publisher */
        public DefinitionService build() {
            return new DefinitionService(this);
        }
    }

    private DefinitionService(Builder builder) {
        List<DefinitionCustomizer> customizers = builder.customizers;
        int publicCacheSize = builder.publicCacheSize;
        Clock clock = builder.clock;
        Duration tooCostlyMemory = builder.tooCostlyMemory;
        FormDefinitionRepository repository = builder.repository;
        DefinitionSnapshotStore snapshots = builder.snapshots;
        Supplier<? extends Sandbox> sandbox = builder.sandbox;
        DatumEventPublisher events = builder.events;
        this.customizers = List.copyOf(Objects.requireNonNull(customizers, "customizers"));
        this.variants = new SingleFlight<>(publicCacheSize);
        this.clock = Objects.requireNonNull(clock, "clock");
        this.verdicts = new SingleFlight<>(Math.max(publicCacheSize, 64));
        // Caffeine's admission policy may drop a fresh refusal when more than the cap of costly definitions cycle within the
        // five minutes (the next save of that one then runs a guest again). Accepted: the extra cost is bounded and needs
        // build rights, and the memory is a courtesy against repeat runs, not a limit.
        this.costly = Caffeine.newBuilder().maximumSize(Math.max(publicCacheSize, 64)).expireAfterWrite(Objects.requireNonNull(tooCostlyMemory, "tooCostlyMemory"))
            .ticker(() -> Duration.between(Instant.EPOCH, clock.instant()).toNanos()).build();
        this.repository = Objects.requireNonNull(repository, "repository");
        this.snapshots = Objects.requireNonNull(snapshots, "snapshots");
        this.sandbox = Objects.requireNonNull(sandbox, "sandbox");
        // As given: the host's default publisher is guarded (a listener's failure is logged, never the save's);
        // an application's own publisher owns its failures, and one that throws reaches the caller after the save.
        this.events = Objects.requireNonNull(events, "events");
        this.publicCopies = new SingleFlight<>(publicCacheSize);
        this.recorded = Caffeine.newBuilder().maximumSize(Math.max(publicCacheSize, 256)).build();
    }

    /** The definition's hash: SHA-256 of its canonical JSON. */
    public static String hash(JsonNode definition) {
        return CanonicalJson.digest(definition);
    }

    /**
     * The form's current definition and hash. The definition is snapshotted the first time its hash is seen
     * (a resource repository never "saves", yet a submission must still resolve its version later).
     *
     * @throws FormNotFoundException when no form has the key
     */
    public CurrentDefinition current(String key) {
        CurrentDefinition current = repository.current(key);
        remember(key, current);
        return current;
    }

    /**
     * The current definition as a filler may see it: no server-secret rule. The hash is the full definition's,
     * the version a submission names, not the public copy's.
     *
     * @throws FormNotFoundException when no form has the key
     * @throws ProgramUnavailableException when a copy had to be made and the kernel could not make it
     *     (a definition with secret rules is then not served at all, never served whole)
     */
    public CurrentDefinition currentPublic(String key) {
        return currentPublic(key, null, null);
    }

    /**
     * {@link #currentPublic(String)} as served to someone: the customizers adjust it first ({@link #publicCopyFor}).
     *
     * @param principal who it is served to, or null
     * @param locale the request's locale, or null
     */
    public CurrentDefinition currentPublic(String key, Principal principal, Locale locale) {
        CurrentDefinition current = current(key);
        return new CurrentDefinition(publicCopyFor(current.definition(), new DefinitionRequest(key, current.sha256(), true, principal, locale)),
            current.sha256());
    }

    /** Whether any {@link DefinitionCustomizer} adjusts the public copies (the routes then never use the shareable snapshot header). */
    public boolean customizesPublicCopies() {
        return !customizers.isEmpty();
    }

    /**
     * The public copy of a stored definition as it is served to a filler: the customizers in their order over
     * a copy of it, then the kernel's public copy of what they left (so no server-secret rule reaches a filler, whoever
     * added it). With no customizer this is {@link #publicCopy(ObjectNode)} of the stored definition, cached by its hash.
     *
     * <p>With customizers the copy is cached by the stored hash and each customizer's {@link DefinitionCustomizer#cacheKey}
     * (asked before it customizes), and not at all when one declares none. A cached copy is used only when the customized
     * definition it was made of is the one this request's customizers left (its hash), so a key that does not name all the
     * adjustment depends on serves a fresh copy, never another request's.
     *
     * @param definition the stored definition (not changed)
     * @param request who it is served to, and which
     * @throws com.argusvane.datum.core.hooks.HookRefusedException when a customizer refuses
     * @throws IllegalStateException when a customizer changed the form's {@code id} or {@code version}
     * @throws ProgramUnavailableException when a copy had to be made and the kernel could not make it
     */
    public ObjectNode publicCopyFor(ObjectNode definition, DefinitionRequest request) {
        Objects.requireNonNull(definition, "definition");
        Objects.requireNonNull(request, "request");
        if (customizers.isEmpty()) {
            // With no hook: the kernel's copy, cached by the hash of the definition itself.
            return publicCopy(definition);
        }
        List<String> keys = new ArrayList<>();
        boolean cacheable = true;
        for (DefinitionCustomizer customizer : customizers) {
            Optional<String> key = customizer.cacheKey(request);
            if (key == null || key.isEmpty()) {
                cacheable = false;
            } else {
                keys.add(key.get());
            }
        }
        DefinitionDraft draft = new DefinitionDraft(request, definition.deepCopy());
        for (DefinitionCustomizer customizer : customizers) {
            customizer.customize(draft);
        }
        ObjectNode customized = draft.definition();
        requireSameIdentity(definition, customized, request.formKey());
        if (!cacheable) {
            return makePublicCopy(customized);
        }
        String customizedSha256 = hash(customized);
        // Each key length-prefixed, so no key can end where another begins.
        StringBuilder cacheKey = new StringBuilder(request.sha256());
        for (String key : keys) {
            cacheKey.append('|').append(key.length()).append(':').append(key);
        }
        Variant variant = variants.get(cacheKey.toString(), () -> new Variant(customizedSha256, makePublicCopy(customized)));
        if (variant.customizedSha256().equals(customizedSha256)) {
            return variant.publicCopy().deepCopy();
        }
        if (variantKeyWarned.compareAndSet(false, true)) {
            LOG.warn("Form {}: the definition customizers made two different definitions under the same cache keys {}; the public copy is "
                + "made fresh for such requests. A DefinitionCustomizer's cacheKey must name everything its adjustment depends on.",
                request.formKey(), keys);
        }
        return makePublicCopy(customized);
    }

    /** The form's identity, which a submission names, is not a customizer's to change. */
    private static void requireSameIdentity(ObjectNode stored, ObjectNode customized, String key) {
        for (String member : List.of("id", "version")) {
            if (!Objects.equals(stored.get(member), customized.get(member))) {
                throw new IllegalStateException("A DefinitionCustomizer changed the " + member + " of form " + key
                    + ": the id and version are what a submission names, so they are never customized.");
            }
        }
    }

    /** The public copy of any definition, cached by its hash. */
    public ObjectNode publicCopy(ObjectNode definition) {
        return publicCopy(definition, hash(definition));
    }

    private ObjectNode publicCopy(ObjectNode definition, String sha256) {
        return publicCopies.get(sha256, () -> makePublicCopy(definition)).deepCopy();
    }

    private ObjectNode makePublicCopy(ObjectNode definition) {
        DefinitionDepth.assertShallow(definition);
        if (!CanonicalJson.serialize(definition).contains("server-secret")) {
            // A definition with no secret rule is its own public copy and costs no run (the public op only removes them).
            return definition.deepCopy();
        }
        try {
            return sandbox.get().publicCopy(definition);
        } catch (SandboxException e) {
            if (e.reason() == SandboxException.Reason.BUSY) {
                // Every sandbox slot was taken: the busy answer (503 server.busy with Retry-After) that any run gets, not an outage.
                throw e;
            }
            throw new ProgramUnavailableException("The public copy of the form could not be made because the server runtime is not available ("
                + e.reason() + ").", e);
        }
    }

    /**
     * A version of a form by hash: the stored snapshot, else the current definition when its hash matches.
     *
     * @throws FormNotFoundException when the hash is unknown
     */
    public ObjectNode snapshot(String key, String sha256) {
        return snapshots.find(key, sha256)
            .or(() -> repository.find(key).filter(definition -> hash(definition).equals(sha256)))
            .orElseThrow(() -> new FormNotFoundException(key, sha256));
    }

    /** {@link #snapshot} as a filler may see it. */
    public ObjectNode publicSnapshot(String key, String sha256) {
        return publicSnapshot(key, sha256, null, null);
    }

    /** {@link #publicSnapshot(String, String)} as served to someone: the customizers adjust it first ({@link #publicCopyFor}). */
    public ObjectNode publicSnapshot(String key, String sha256, Principal principal, Locale locale) {
        return publicCopyFor(snapshot(key, sha256), new DefinitionRequest(key, sha256, false, principal, locale));
    }

    /**
     * Asks the kernel whether a definition may be saved (the {@code check} op), after the depth check.
     *
     * @param types the component types this host can draw, so an unknown type is reported (send the
     *     manifest's list; an empty list only when the host has none)
     * @param rules the rule modules of the extensions the form uses
     * @return the verdict, with its warnings, when the definition may be saved
     * @throws DefinitionRefusedException (422) when the kernel refuses it
     * @throws com.argusvane.datum.core.DefinitionTooDeepException (422) before any guest starts
     * @throws SandboxException {@code definition.tooCostly} (422), or {@code server.busy} (503) when every sandbox slot stayed taken
     * @throws ProgramUnavailableException (503) when the check could not run: a save is never waved through
     */
    public DefinitionVerdict check(ObjectNode definition, List<String> types, List<RuleModule> rules) {
        DefinitionDepth.assertShallow(definition);
        // The sandbox documents that its verdict cache is the caller's: the same
        // definition, types and rules get the same answer, and one that ran out of budget is refused again
        // without a run for five minutes, so a looping save cannot hold a guest per request.
        String cacheKey = hash(definition) + "|" + types + "|" + rules;
        SandboxException remembered = costly.getIfPresent(cacheKey);
        if (remembered != null) {
            throw remembered;
        }
        DefinitionVerdict verdict = verdicts.get(cacheKey, () -> run(definition, types, rules, cacheKey));
        if (verdict.refused()) {
            throw new DefinitionRefusedException(verdict.refusals());
        }
        return verdict;
    }

    private DefinitionVerdict run(ObjectNode definition, List<String> types, List<RuleModule> rules, String cacheKey) {
        ObjectNode answer;
        try {
            answer = sandbox.get().check(definition, types, rules);
        } catch (SandboxException e) {
            if ("definition.tooCostly".equals(e.typedCode())) {
                costly.put(cacheKey, e);
            }
            throw e;
        }
        InspectAnswer typed;
        try {
            typed = DatumJson.mapper().convertValue(answer, InspectAnswer.class);
        } catch (RuntimeException e) {
            // Fail closed with the typed 503, and without the mapper's message: it can quote the answer.
            LOG.warn("The sandbox answered a check request with a body that is not a check answer.", e);
            throw new ProgramUnavailableException("The sandbox answered the check request with something that is not a check answer.");
        }
        if (!(typed instanceof InspectCheckAnswer checkAnswer)) {
            throw new ProgramUnavailableException("The sandbox answered the check request with something that is not a check answer.");
        }
        return DefinitionVerdict.of(checkAnswer);
    }

    /**
     * Records that a definition was stored: snapshots it and publishes {@link FormDefinitionSavedEvent}. The
     * save endpoint calls it after {@link FormDefinitionRepository#save}.
     *
     * <p>A snapshot store that fails is a {@link SnapshotNotRecordedException} with the store's failure as its cause, and
     * no event is published (the version is not recorded). It is told apart here, where it fails, so a caller never has to
     * guess the cause from a cache that reads also fill. The event comes after: through the host's guarded
     * default publisher a listener's failure is logged and never reaches the caller; an application's own
     * publisher is used as given, so its failure reaches the caller as thrown, after the snapshot was recorded.
     *
     * @param previousSha256 the hash that was current before, or null for a first version
     * @return the new hash
     * @throws SnapshotNotRecordedException when the snapshot store fails
     */
    public String saved(String key, ObjectNode definition, String previousSha256) {
        String sha256 = hash(definition);
        try {
            snapshots.record(key, sha256, definition);
        } catch (RuntimeException e) {
            throw new SnapshotNotRecordedException(key, sha256, e);
        }
        recorded.put(key + ":" + sha256, Boolean.TRUE);
        events.publish(new FormDefinitionSavedEvent(key, sha256, previousSha256));
        return sha256;
    }

    private void remember(String key, CurrentDefinition current) {
        String id = key + ":" + current.sha256();
        if (recorded.getIfPresent(id) == null) {
            try {
                snapshots.record(key, current.sha256(), current.definition());
                recorded.put(id, Boolean.TRUE);
            } catch (RuntimeException e) {
                // A read must not fail because the snapshot table cannot be written (a read-only database
                // user, a lost race); the current hash still resolves from the repository.
                LOG.warn("The snapshot of form {} at {} could not be recorded; it is tried again on the next read.", key, current.sha256(), e);
            }
        }
    }
}
