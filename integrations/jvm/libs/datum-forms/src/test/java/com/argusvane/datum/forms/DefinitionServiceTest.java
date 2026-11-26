package com.argusvane.datum.forms;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.DefinitionTooDeepException;
import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.core.canonical.CanonicalJson;
import com.argusvane.datum.forms.snapshot.InMemoryDefinitionSnapshotStore;
import com.argusvane.datum.forms.snapshot.SnapshotNotRecordedException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ObjectNode;

/** The definition service over a repository, a snapshot store and a sandbox that plays the kernel. */
class DefinitionServiceTest {

    /** A repository over a map, saving for real. */
    private static final class MapRepository implements FormDefinitionRepository {
        final Map<String, ObjectNode> forms = new TreeMap<>();

        @Override
        public Optional<ObjectNode> find(String key) {
            return Optional.ofNullable(forms.get(key)).map(ObjectNode::deepCopy);
        }

        @Override
        public SavedForm save(ObjectNode definition) {
            String key = definition.path("id").asString();
            forms.put(key, definition.deepCopy());
            return new SavedForm(key, CanonicalJson.digest(definition));
        }

        @Override
        public SavedForm save(ObjectNode definition, String expectedSha256) {
            ObjectNode existing = forms.get(definition.path("id").asString());
            String current = existing == null ? null : CanonicalJson.digest(existing);
            if (current == null ? expectedSha256 != null : !current.equals(expectedSha256)) {
                throw new FormOutdatedException(current == null ? "" : current);
            }
            return save(definition);
        }
    }

    private final FakeGuestRuntime runtime = new FakeGuestRuntime();
    private final MapRepository repository = new MapRepository();
    private final InMemoryDefinitionSnapshotStore snapshots = new InMemoryDefinitionSnapshotStore(50, message -> { });
    private final List<Object> events = new ArrayList<>();
    private DefinitionService service;

    @BeforeEach
    void setUp() {
        service = DefinitionService.builder().repository(repository).snapshots(snapshots).sandbox(runtime::service).events(events::add).publicCacheSize(8).build();
    }

    private static boolean hasSecret(ObjectNode definition) {
        return CanonicalJson.serialize(definition).contains("server-secret");
    }

    @Test
    void currentIsTheStoredDefinitionWithItsCanonicalHash() {
        ObjectNode fixture = Fixtures.endpointFixture();
        repository.save(fixture);

        CurrentDefinition current = service.current("datum-security-suite");

        assertThat(current.sha256()).isEqualTo(CanonicalJson.digest(fixture));
        assertThat(current.definition()).isEqualTo(fixture);
        assertThat(runtime.requests()).as("no run to read a definition").isEmpty();
    }

    @Test
    void currentSnapshotsTheDefinitionTheFirstTimeSoOldSubmissionsResolve() {
        ObjectNode fixture = Fixtures.endpointFixture();
        repository.save(fixture);
        String sha = service.current("datum-security-suite").sha256();

        repository.forms.get("datum-security-suite").put("version", "2");

        assertThat(service.snapshot("datum-security-suite", sha)).isEqualTo(fixture);
        assertThat(service.current("datum-security-suite").sha256()).isNotEqualTo(sha);
    }

    @Test
    void anUnknownHashIsNotFoundButTheCurrentOneResolvesWithoutASnapshot() {
        ObjectNode fixture = Fixtures.endpointFixture();
        repository.save(fixture);

        assertThat(service.snapshot("datum-security-suite", CanonicalJson.digest(fixture))).isEqualTo(fixture);
        assertThatThrownBy(() -> service.snapshot("datum-security-suite", "f".repeat(64))).isInstanceOf(FormNotFoundException.class);
    }

    @Test
    void thePublicCopyHasNoServerSecretRuleAndIsMadeOncePerHash() {
        ObjectNode fixture = Fixtures.endpointFixture();
        assertThat(hasSecret(fixture)).isTrue();
        repository.save(fixture);

        CurrentDefinition first = service.currentPublic("datum-security-suite");
        CurrentDefinition second = service.currentPublic("datum-security-suite");

        assertThat(hasSecret(first.definition())).isFalse();
        assertThat(second.definition()).isEqualTo(first.definition());
        assertThat(first.sha256()).as("the version is the full definition's").isEqualTo(CanonicalJson.digest(fixture));
        assertThat(runtime.count("public")).as("cached by sha256").isEqualTo(1);
        first.definition().put("tampered", true);
        assertThat(service.currentPublic("datum-security-suite").definition().has("tampered")).as("a copy").isFalse();
    }

    @Test
    void aDefinitionWithoutSecretsIsItsOwnPublicCopyAtNoCost() {
        ObjectNode plain = Fixtures.parse("{\"id\":\"plain\",\"root\":{\"id\":\"form\",\"type\":\"form\",\"configuration\":{},\"children\":{\"content\":[]}}}");
        repository.save(plain);

        assertThat(service.currentPublic("plain").definition()).isEqualTo(plain);
        assertThat(runtime.requests()).isEmpty();
    }

    @Test
    void aDefinitionWithSecretsIsNotServedWholeWhenTheKernelCannotMakeTheCopy() {
        repository.save(Fixtures.endpointFixture());
        runtime.on("public", body -> "{\"ok\":false,\"error\":{\"code\":\"boom\",\"message\":\"no\"}}");

        assertThatThrownBy(() -> service.currentPublic("datum-security-suite")).isInstanceOf(ProgramUnavailableException.class);
    }

    /**
     * A sandbox with every slot taken is the busy answer (503 server.busy, which carries Retry-After), for a public copy and
     * for a check alike, not the runtime's server.unavailable; nothing is cached, so the next request runs.
     */
    @Test
    void aBusySandboxIsTheBusyAnswerForAPublicCopyAndACheck() {
        repository.save(Fixtures.endpointFixture());
        com.argusvane.datum.sandbox.protocol.RunSlots slots = new com.argusvane.datum.sandbox.protocol.RunSlots(1, java.time.Duration.ZERO, "validation");
        com.argusvane.datum.sandbox.protocol.SandboxService bounded = new com.argusvane.datum.sandbox.protocol.SandboxService(
            com.argusvane.datum.sandbox.protocol.ProgramRunner.on(runtime),
            com.argusvane.datum.sandbox.protocol.Program.of(com.argusvane.datum.sandbox.protocol.Program.Kind.SANDBOX,
                "/* program */".getBytes(java.nio.charset.StandardCharsets.UTF_8)),
            new com.argusvane.datum.sandbox.protocol.RunScript("/* freeze */"), com.argusvane.datum.sandbox.protocol.ProgramLimits.defaults(),
            com.argusvane.datum.sandbox.protocol.HostOptions.defaults(), slots, new com.argusvane.datum.sandbox.protocol.AbiProbe(),
            com.argusvane.datum.sandbox.protocol.RunLog.slf4j());
        DefinitionService busy = DefinitionService.builder().repository(repository).snapshots(snapshots).sandbox(() -> bounded)
            .events(events::add).publicCacheSize(8).build();
        try (com.argusvane.datum.sandbox.protocol.RunSlots.Permit held = slots.acquire()) {
            assertThatThrownBy(() -> busy.currentPublic("datum-security-suite"))
                .isInstanceOfSatisfying(com.argusvane.datum.sandbox.protocol.SandboxException.class, e -> {
                    assertThat(e.code()).isEqualTo("server.busy");
                    assertThat(e.httpStatus()).isEqualTo(503);
                });
            assertThatThrownBy(() -> busy.check(Fixtures.endpointFixture(), List.of(), List.of()))
                .isInstanceOfSatisfying(com.argusvane.datum.sandbox.protocol.SandboxException.class,
                    e -> assertThat(e.code()).isEqualTo("server.busy"));
        }
        assertThat(runtime.requests()).as("nothing ran").isEmpty();
        assertThat(busy.currentPublic("datum-security-suite").definition().toString()).doesNotContain("server-secret");
        assertThat(busy.check(Fixtures.endpointFixture(), List.of(), List.of()).refused()).isFalse();
    }

    @Test
    void noSandboxMeansTheSecretCopyIsUnavailableButPlainFormsStillServe() {
        DefinitionService withoutRuntime = DefinitionService.builder().repository(repository).snapshots(snapshots).sandbox(() -> {
            throw new ProgramUnavailableException("The Datum sandbox runtime is not configured.");
        }).events(events::add).publicCacheSize(8).build();
        repository.save(Fixtures.endpointFixture());
        repository.save(Fixtures.parse("{\"id\":\"plain\",\"root\":{}}"));

        assertThat(withoutRuntime.currentPublic("plain").definition().path("id").asString()).isEqualTo("plain");
        assertThatThrownBy(() -> withoutRuntime.currentPublic("datum-security-suite")).isInstanceOf(ProgramUnavailableException.class);
    }

    @Test
    void checkAnswersTheWarningsOfAnAcceptedDefinition() {
        runtime.on("check", body -> "{\"ok\":true,\"op\":\"check\",\"problems\":[],\"warnings\":[{\"where\":\"a\",\"code\":\"condition.notBoolean\",\"message\":\"w\"}],"
            + "\"policy\":\"warn\",\"structure\":[],\"structureWarnings\":[{\"code\":\"component.type.unknown\",\"where\":\"x\",\"message\":\"m\"}],\"verdict\":\"warn\"}");

        DefinitionVerdict verdict = service.check(Fixtures.endpointFixture(), List.of("text", "select"), List.of());

        assertThat(verdict.refused()).isFalse();
        assertThat(verdict.structureWarnings()).hasSize(1);
        assertThat(verdict.warnings()).extracting(w -> w.code()).containsExactly("condition.notBoolean");
        assertThat(runtime.requests().get(0).body().path("types").toString()).isEqualTo("[\"select\",\"text\"]");
    }

    @Test
    void checkRefusesAStructureProblemAndAFormulaFailureWithTheKernelsCodes() {
        runtime.on("check", body -> "{\"ok\":true,\"op\":\"check\","
            + "\"problems\":[{\"where\":\"a.visibleWhen\",\"code\":\"parse\",\"message\":\"bad formula\"}],\"warnings\":[],\"policy\":\"fail\","
            + "\"structure\":[{\"code\":\"component.tooMany\",\"where\":\"root\",\"limit\":10000,\"message\":\"too many\"}],\"structureWarnings\":[],\"verdict\":\"fail\"}");

        assertThatThrownBy(() -> service.check(Fixtures.endpointFixture(), List.of(), List.of()))
            .isInstanceOfSatisfying(DefinitionRefusedException.class, e -> {
                assertThat(e.httpStatus()).isEqualTo(422);
                assertThat(e.code()).isEqualTo("definition.refused");
                assertThat(e.errors()).extracting(DefinitionRefusedException.Refusal::code).containsExactly("component.tooMany", "parse");
                assertThat(e.errors().get(0).limit()).isEqualTo(10000);
                assertThat(e.errors().get(1).where()).isEqualTo("a.visibleWhen");
            });
    }

    @Test
    void aFormulaOnlyFailureAlsoRefusesTheSave() {
        runtime.on("check", body -> "{\"ok\":true,\"op\":\"check\",\"problems\":[{\"where\":\"b\",\"code\":\"parse\",\"message\":\"m\"}],\"warnings\":[],"
            + "\"policy\":\"fail\",\"structure\":[],\"structureWarnings\":[],\"verdict\":\"fail\"}");

        assertThatThrownBy(() -> service.check(Fixtures.endpointFixture(), List.of(), List.of())).isInstanceOf(DefinitionRefusedException.class);
    }

    @Test
    void checkAnswers503WhenTheKernelGivesNoVerdictAndNeverWavesTheSaveThrough() {
        runtime.on("check", body -> "{\"ok\":false,\"error\":{\"code\":\"boom\",\"message\":\"x\"}}");

        assertThatThrownBy(() -> service.check(Fixtures.endpointFixture(), List.of(), List.of()))
            .isInstanceOfSatisfying(ProgramUnavailableException.class, e -> assertThat(e.httpStatus()).isEqualTo(503));
    }

    @Test
    void theDepthCheckComesBeforeAnyRun() {
        String nested = "[]";
        for (int i = 0; i < 40; i++) {
            nested = "[{\"id\":\"c" + i + "\",\"type\":\"container\",\"configuration\":{},\"children\":{\"default\":" + nested + "}}]";
        }
        ObjectNode deep = Fixtures.parse("{\"id\":\"deep\",\"root\":{\"id\":\"form\",\"type\":\"form\",\"configuration\":{},\"children\":{\"content\":" + nested + "}}}");
        ObjectNode tooDeep = deep;

        assertThatThrownBy(() -> service.check(tooDeep, List.of(), List.of())).isInstanceOf(DefinitionTooDeepException.class);
        assertThatThrownBy(() -> service.publicCopy(tooDeep)).isInstanceOf(DefinitionTooDeepException.class);
        assertThat(runtime.requests()).isEmpty();
    }

    @Test
    void savedSnapshotsTheDefinitionAndPublishesTheEvent() {
        ObjectNode fixture = Fixtures.endpointFixture();
        String sha = service.saved("contact", fixture, null);
        String next = service.saved("contact", Fixtures.parse("{\"id\":\"contact\",\"version\":\"2\"}"), sha);

        assertThat(snapshots.find("contact", sha)).hasValue(fixture);
        assertThat(events).containsExactly(new FormDefinitionSavedEvent("contact", sha, null), new FormDefinitionSavedEvent("contact", next, sha));
    }

    /**
     * The saved event goes through the one guard like every other, so a listener's failure (an exception or
     * a failed assertion) is logged, the caller of {@code saved} gets the hash, and the snapshot is recorded all the same.
     */
    @Test
    void aSavedListenerThatThrowsIsLoggedAndTheSaveIsRecorded() {
        for (Throwable failure : List.of(new IllegalStateException("listener failed"), new AssertionError("listener invariant"))) {
            InMemoryDefinitionSnapshotStore store = new InMemoryDefinitionSnapshotStore(50, message -> { });
            // The host's default publisher is the guarded one.
            DefinitionService throwing = DefinitionService.builder().repository(repository).snapshots(store).sandbox(runtime::service).events(com.argusvane.datum.core
                .DatumEventPublisher.guarded(event -> {
                    if (failure instanceof RuntimeException e) {
                        throw e;
                    }
                    throw (Error) failure;
                })).publicCacheSize(8).build();
            ObjectNode fixture = Fixtures.endpointFixture();

            String sha = throwing.saved("contact", fixture, null);

            assertThat(sha).isEqualTo(DefinitionService.hash(fixture));
            assertThat(store.find("contact", sha)).hasValue(fixture);
        }
    }

    /**
     * The service uses the publisher it is given as given, so an application's own
     * publisher that throws (an outbox write that failed) reaches the caller of {@code saved}, after the snapshot was
     * recorded, as itself: never a {@link SnapshotNotRecordedException}, which the builder's save takes for its warning.
     */
    @Test
    void anApplicationsOwnPublisherThatThrowsReachesTheCallerAfterTheSnapshot() {
        InMemoryDefinitionSnapshotStore store = new InMemoryDefinitionSnapshotStore(50, message -> { });
        DefinitionService outbox = DefinitionService.builder().repository(repository).snapshots(store).sandbox(runtime::service).events(event -> {
            throw new IllegalStateException("outbox down");
        }).publicCacheSize(8).build();
        ObjectNode fixture = Fixtures.endpointFixture();
        String sha = DefinitionService.hash(fixture);

        assertThatThrownBy(() -> outbox.saved("contact", fixture, null)).isExactlyInstanceOf(IllegalStateException.class)
            .hasMessage("outbox down");

        assertThat(store.find("contact", sha)).hasValue(fixture);
    }

    /**
     * A snapshot store that fails is told apart from a publisher that fails where it fails, as
     * {@link SnapshotNotRecordedException} with the store's failure as its cause, and the saved event is not published
     * (the version is not recorded). Even for a hash recorded before (by a read here), so a revert to an earlier version
     * while the table is read-only is still the store's failure.
     */
    @Test
    void aSnapshotStoreThatFailsIsSnapshotNotRecordedAndNoEventIsPublished() {
        java.util.concurrent.atomic.AtomicBoolean readOnly = new java.util.concurrent.atomic.AtomicBoolean();
        InMemoryDefinitionSnapshotStore memory = new InMemoryDefinitionSnapshotStore(50, message -> { });
        com.argusvane.datum.forms.snapshot.DefinitionSnapshotStore flaky = new com.argusvane.datum.forms.snapshot.DefinitionSnapshotStore() {
            @Override
            public void record(String key, String sha256, ObjectNode definition) {
                if (readOnly.get()) {
                    throw new IllegalStateException("snapshot table read-only");
                }
                memory.record(key, sha256, definition);
            }

            @Override
            public java.util.Optional<ObjectNode> find(String key, String sha256) {
                return memory.find(key, sha256);
            }
        };
        List<Object> published = new java.util.ArrayList<>();
        DefinitionService recorder = DefinitionService.builder().repository(repository).snapshots(flaky).sandbox(runtime::service).events(published::add).publicCacheSize(8).build();
        ObjectNode fixture = Fixtures.endpointFixture();
        String sha = recorder.saved("contact", fixture, null);
        published.clear();

        readOnly.set(true);
        assertThatThrownBy(() -> recorder.saved("contact", fixture, sha)).isInstanceOfSatisfying(SnapshotNotRecordedException.class, e -> {
            assertThat(e.getCause()).isInstanceOf(IllegalStateException.class).hasMessage("snapshot table read-only");
            assertThat(e.getMessage()).doesNotContain("read-only");
        });
        assertThat(published).as("an unrecorded version is not announced").isEmpty();
    }

    @Test
    void aMalformedKernelAnswerIsA503NotAJacksonError() {
        runtime.on("check", body -> "{\"ok\":true,\"op\":\"check\",\"problems\":\"secret-looking text\",\"warnings\":7,\"policy\":\"fail\","
            + "\"structure\":[],\"structureWarnings\":[],\"verdict\":\"ok\"}");

        assertThatThrownBy(() -> service.check(Fixtures.endpointFixture(), List.of(), List.of()))
            .isInstanceOfSatisfying(ProgramUnavailableException.class, e -> {
                assertThat(e.httpStatus()).isEqualTo(503);
                assertThat(e.getMessage()).doesNotContain("secret-looking");
            });
    }

    @Test
    void aVerdictIsRememberedSoARepeatedCheckRunsNoGuest() {
        service.check(Fixtures.endpointFixture(), List.of("text"), List.of());
        service.check(Fixtures.endpointFixture(), List.of("text"), List.of());
        assertThat(runtime.count("check")).isEqualTo(1);

        service.check(Fixtures.endpointFixture(), List.of("text", "select"), List.of());
        assertThat(runtime.count("check")).as("other types are another question").isEqualTo(2);
    }

    @Test
    void aDefinitionTooCostlyToCheckIsRefusedWithoutARunForFiveMinutes() {
        java.util.concurrent.atomic.AtomicReference<java.time.Instant> now = new java.util.concurrent.atomic.AtomicReference<>(java.time.Instant.parse("2026-10-15T12:00:00Z"));
        java.time.Clock clock = new java.time.Clock() {
            @Override
            public java.time.ZoneId getZone() {
                return java.time.ZoneOffset.UTC;
            }

            @Override
            public java.time.Clock withZone(java.time.ZoneId zone) {
                return this;
            }

            @Override
            public java.time.Instant instant() {
                return now.get();
            }
        };
        DefinitionService timed = DefinitionService.builder().repository(repository).snapshots(snapshots).sandbox(runtime::service).events(events::add).publicCacheSize(8).clock(clock).build();
        runtime.on("check", body -> {
            throw new com.argusvane.datum.sandbox.protocol.SandboxException(
                com.argusvane.datum.sandbox.protocol.SandboxException.Reason.BUDGET, "slow", "", true);
        });

        assertThatThrownBy(() -> timed.check(Fixtures.endpointFixture(), List.of(), List.of()))
            .isInstanceOfSatisfying(com.argusvane.datum.sandbox.protocol.SandboxException.class, e -> assertThat(e.code()).isEqualTo("definition.tooCostly"));
        assertThatThrownBy(() -> timed.check(Fixtures.endpointFixture(), List.of(), List.of()))
            .isInstanceOf(com.argusvane.datum.sandbox.protocol.SandboxException.class);
        assertThat(runtime.count("check")).isEqualTo(1);

        now.set(now.get().plusSeconds(301));
        runtime.on("check", body -> "{\"ok\":true,\"op\":\"check\",\"problems\":[],\"warnings\":[],\"policy\":\"fail\",\"structure\":[],\"structureWarnings\":[],\"verdict\":\"ok\"}");
        assertThat(timed.check(Fixtures.endpointFixture(), List.of(), List.of()).refused()).isFalse();
        assertThat(runtime.count("check")).isEqualTo(2);
    }

    /** {@code datum.forms.too-costly-memory}: the refusal is remembered for the configured time, not five minutes. */
    @Test
    void theTooCostlyMemoryIsTheConfiguredTime() {
        java.util.concurrent.atomic.AtomicReference<java.time.Instant> now = new java.util.concurrent.atomic.AtomicReference<>(java.time.Instant.parse("2026-10-15T12:00:00Z"));
        java.time.Clock clock = new java.time.Clock() {
            @Override
            public java.time.ZoneId getZone() {
                return java.time.ZoneOffset.UTC;
            }

            @Override
            public java.time.Clock withZone(java.time.ZoneId zone) {
                return this;
            }

            @Override
            public java.time.Instant instant() {
                return now.get();
            }
        };
        DefinitionService brief = DefinitionService.builder().repository(repository).snapshots(snapshots).sandbox(runtime::service).events(events::add).publicCacheSize(8).clock(clock)
            .tooCostlyMemory(java.time.Duration.ofSeconds(20)).build();
        runtime.on("check", body -> {
            throw new com.argusvane.datum.sandbox.protocol.SandboxException(
                com.argusvane.datum.sandbox.protocol.SandboxException.Reason.BUDGET, "slow", "", true);
        });
        assertThatThrownBy(() -> brief.check(Fixtures.endpointFixture(), List.of(), List.of()))
            .isInstanceOf(com.argusvane.datum.sandbox.protocol.SandboxException.class);
        now.set(now.get().plusSeconds(10));
        assertThatThrownBy(() -> brief.check(Fixtures.endpointFixture(), List.of(), List.of()))
            .isInstanceOf(com.argusvane.datum.sandbox.protocol.SandboxException.class);
        assertThat(runtime.count("check")).as("still remembered after 10 s of 20").isEqualTo(1);
        now.set(now.get().plusSeconds(15));
        assertThatThrownBy(() -> brief.check(Fixtures.endpointFixture(), List.of(), List.of()))
            .isInstanceOf(com.argusvane.datum.sandbox.protocol.SandboxException.class);
        assertThat(runtime.count("check")).as("forgotten after 25 s: the guest ran again").isEqualTo(2);
    }

    // ---- the builder

    @Test
    void theBuilderMakesAServiceThatReadsAndSnapshotsLikeTheDeprecatedConstructors() {
        DefinitionService built = DefinitionService.builder().repository(repository).snapshots(snapshots).sandbox(runtime::service)
            .events(events::add).build();
        ObjectNode fixture = Fixtures.endpointFixture();
        repository.save(fixture);

        assertThat(built.current("datum-security-suite").sha256()).isEqualTo(CanonicalJson.digest(fixture));
        assertThat(snapshots.find("datum-security-suite", CanonicalJson.digest(fixture))).isPresent();
        assertThat(built.customizesPublicCopies()).isFalse();
    }

    @Test
    void theBuilderNamesTheMissingPart() {
        assertThatThrownBy(() -> DefinitionService.builder().build()).isInstanceOf(NullPointerException.class).hasMessage("repository");
        assertThatThrownBy(() -> DefinitionService.builder().repository(repository).build()).hasMessage("snapshots");
        assertThatThrownBy(() -> DefinitionService.builder().repository(repository).snapshots(snapshots).build()).hasMessage("sandbox");
        assertThatThrownBy(() -> DefinitionService.builder().repository(repository).snapshots(snapshots).sandbox(runtime::service).build())
            .hasMessage("events");
    }

    @Test
    void theBuilderTakesTheCustomizersTheCacheSizeAndTheClock() {
        DefinitionCustomizer noop = draft -> { };
        DefinitionService built = DefinitionService.builder().repository(repository).snapshots(snapshots).sandbox(runtime::service)
            .events(events::add).publicCacheSize(4).clock(java.time.Clock.systemUTC()).tooCostlyMemory(java.time.Duration.ofSeconds(30))
            .customizers(List.of(noop)).build();
        assertThat(built.customizesPublicCopies()).isTrue();
        assertThatThrownBy(() -> DefinitionService.builder().repository(repository).snapshots(snapshots).sandbox(runtime::service)
            .events(events::add).customizers(null).build()).isInstanceOf(NullPointerException.class).hasMessage("customizers");
    }
}
