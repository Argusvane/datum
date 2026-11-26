package com.argusvane.datum.submissions.service;

import static com.argusvane.datum.submissions.Fixtures.envelope;
import static com.argusvane.datum.submissions.Fixtures.delivered;
import static com.argusvane.datum.submissions.Fixtures.wrapped;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.DatumException;
import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.core.RequestTooLargeException;
import com.argusvane.datum.core.canonical.CanonicalJson;
import com.argusvane.datum.core.contracts.OptionItem;
import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.sandbox.protocol.Sandbox;
import com.argusvane.datum.sandbox.protocol.SandboxService;
import com.argusvane.datum.forms.DefinitionService;
import com.argusvane.datum.forms.datasource.DataSourceOptions;
import com.argusvane.datum.forms.datasource.DataSourceProvider;
import com.argusvane.datum.forms.snapshot.InMemoryDefinitionSnapshotStore;
import com.argusvane.datum.forms.translation.InMemoryTranslationCatalogStore;
import com.argusvane.datum.forms.translation.TranslationCatalogStore;
import com.argusvane.datum.submissions.Fixtures;
import com.argusvane.datum.sandbox.runtime.TestRuntime;
import com.argusvane.datum.submissions.events.JourneyCheckedEvent;
import com.argusvane.datum.submissions.events.SubmissionRedeliveredEvent;
import com.argusvane.datum.submissions.events.SubmissionRejectedEvent;
import com.argusvane.datum.submissions.events.SubmissionThrottledEvent;
import com.argusvane.datum.submissions.events.SubmissionValidatedEvent;
import com.argusvane.datum.submissions.idempotency.InMemorySubmissionIdempotencyStore;
import com.argusvane.datum.submissions.receiver.ReceiverAnswer;
import com.argusvane.datum.submissions.receiver.SubmissionReceiver;
import com.argusvane.datum.submissions.service.SubmissionOutcome.Accepted;
import com.argusvane.datum.submissions.service.SubmissionOutcome.Checked;
import com.argusvane.datum.submissions.service.SubmissionOutcome.DryRun;
import com.argusvane.datum.submissions.service.SubmissionOutcome.KeyConflict;
import com.argusvane.datum.submissions.service.SubmissionOutcome.Malformed;
import com.argusvane.datum.submissions.service.SubmissionOutcome.NotFound;
import com.argusvane.datum.submissions.service.SubmissionOutcome.Outdated;
import com.argusvane.datum.submissions.service.SubmissionOutcome.Redelivered;
import com.argusvane.datum.submissions.service.SubmissionOutcome.Refused;
import com.argusvane.datum.submissions.service.SubmissionOutcome.Rejected;
import com.argusvane.datum.submissions.service.SubmissionOutcome.Throttled;
import com.argusvane.datum.submissions.service.SubmissionOutcome.TooLarge;
import com.argusvane.datum.submissions.service.SubmissionOutcome.Unavailable;
import com.argusvane.datum.submissions.spi.AcceptedSubmission;
import com.argusvane.datum.submissions.spi.CandidateSubmission;
import com.argusvane.datum.submissions.spi.IncomingSubmission;
import com.argusvane.datum.submissions.spi.PreCheckDecision;
import com.argusvane.datum.submissions.spi.SandboxContextContributor;
import com.argusvane.datum.submissions.spi.SignatureVerdict;
import com.argusvane.datum.submissions.spi.SubmissionContext;
import com.argusvane.datum.submissions.spi.SubmissionError;
import com.argusvane.datum.submissions.spi.SubmissionPreCheck;
import com.argusvane.datum.submissions.spi.SubmissionReceipt;
import com.argusvane.datum.submissions.spi.SubmissionRequest;
import com.argusvane.datum.submissions.spi.SubmissionSignatureCheck;
import com.argusvane.datum.submissions.spi.SubmissionMode;
import com.argusvane.datum.submissions.spi.SubmissionThrottle;
import com.argusvane.datum.submissions.spi.SubmissionValidator;
import com.argusvane.datum.submissions.spi.ThrottleDecision;
import com.argusvane.datum.submissions.spi.ThrottleKey;
import com.argusvane.datum.submissions.spi.ValidatorResult;
import com.argusvane.datum.web.json.DatumJsonMapper;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.Principal;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * The transport-neutral pipeline: a caller with no HTTP request (a queue, a batch, a sync) gets the verdict
 * the routes give for the same document, meets every check the routes run (the version, the option snapshot, the
 * signature check, the validators; the throttle and the pre-checks under its own context), shares the idempotency rule
 * with the routes across channels, and every event and the accepted submission carry its channel.
 */
class SubmissionServiceTest {

    private static final JsonNodeFactory NODES = JsonNodeFactory.instance;

    private TestRuntime runtime;
    private SandboxService sandbox;
    private Fixtures.Repository forms;
    private Throttle throttle;
    private List<Object> events;
    private List<AcceptedSubmission> handled;
    private List<SubmissionPreCheck> preChecks;
    private List<SubmissionValidator> validators;
    private List<SandboxContextContributor> contributors;
    private List<com.argusvane.datum.submissions.spi.SandboxRulesProvider> rulesProviders;
    private List<com.argusvane.datum.submissions.spi.HostOptionsCustomizer> hostCustomizers;
    private SubmissionSignatureCheck signatureCheck;
    private DataSourceProvider provider;
    private TranslationCatalogStore catalogs;
    private InMemorySubmissionIdempotencyStore idempotency;
    private AtomicInteger sandboxAsked;
    private RuntimeException sandboxDown;
    private long cap;
    private com.argusvane.datum.core.observation.DatumObservations observations;

    @BeforeEach
    void setUp() {
        runtime = new TestRuntime();
        sandbox = runtime.service();
        forms = new Fixtures.Repository(Fixtures.contact(), Fixtures.trip(), Fixtures.sourced());
        throttle = new Throttle();
        events = Collections.synchronizedList(new ArrayList<>());
        handled = new ArrayList<>();
        preChecks = new ArrayList<>();
        validators = new ArrayList<>();
        contributors = new ArrayList<>();
        rulesProviders = new ArrayList<>();
        hostCustomizers = new ArrayList<>();
        signatureCheck = null;
        provider = null;
        catalogs = null;
        idempotency = new InMemorySubmissionIdempotencyStore(100);
        sandboxAsked = new AtomicInteger();
        sandboxDown = null;
        cap = 1 << 20;
        observations = com.argusvane.datum.core.observation.DatumObservations.none();
    }

    private SubmissionService service() {
        return SubmissionService.builder()
            .sandbox(() -> {
                sandboxAsked.incrementAndGet();
                if (sandboxDown != null) {
                    throw sandboxDown;
                }
                return sandbox;
            })
            .definitions(DefinitionService.builder().repository(forms).snapshots(new InMemoryDefinitionSnapshotStore(100, message -> { })).sandbox(() -> sandbox).events(event -> { }).publicCacheSize(16).build())
            .dataSources(new DataSourceOptions(provider, Duration.ofSeconds(2), null))
            .catalogs(catalogs)
            .handler(submission -> {
                handled.add(submission);
                return new SubmissionReceipt("id-" + handled.size(), "CONTACT-" + handled.size(), null);
            })
            .throttle(throttle)
            .preChecks(preChecks)
            .validators(validators)
            .contributors(contributors)
            .rulesProviders(rulesProviders)
            .customizers(hostCustomizers)
            .signatureCheck(signatureCheck)
            .idempotency(idempotency)
            .events(events::add)
            .observations(observations)
            .maxDocumentBytes(cap)
            .build();
    }

    /** The route over the same service, with the same cap: what an HTTP caller gets. */
    private SubmissionReceiver over(SubmissionService service) {
        return SubmissionReceiver.builder().service(service).json(DatumJsonMapper.create(cap)).maxBodyBytes(cap).build();
    }

    private static SubmissionRequest http() {
        return new SubmissionRequest("application/json", Map.of("User-Agent", List.of("tests")), "203.0.113.9", null);
    }

    private static SubmissionContext bus() {
        return SubmissionContext.of(SubmissionContext.BUS).withSubmissionKey(java.util.UUID.randomUUID().toString());
    }

    private static ObjectNode contact() {
        return envelope("contact", "1", "{\"name\":\"Ada\"}");
    }

    private <T> List<T> eventsOf(Class<T> type) {
        return events.stream().filter(type::isInstance).map(type::cast).toList();
    }

    /**
     * Each call is one {@code datum.submission} observation, its mode and channel from the start, its outcome
     * and stage at the end, the form's key as a high-cardinality key once the form was found; the sandbox run it makes is
     * its child.
     */
    @Nested
    class TheObservation {

        private final com.argusvane.datum.core.observation.RecordingObservations recording =
            new com.argusvane.datum.core.observation.RecordingObservations();

        private com.argusvane.datum.core.observation.RecordingObservations.Recorded submission() {
            return recording.named(com.argusvane.datum.core.observation.DatumObservationNames.SUBMISSION).get(0);
        }

        @Test
        void anAcceptedDeliveryIsObservedWithItsChannelOutcomeAndFormAndTheSandboxRunIsItsChild() {
            observations = recording.observations();
            SandboxService protocol = runtime.service();
            Sandbox observed = com.argusvane.datum.sandbox.observation.GuestRunObservations.sandbox(observations, "jffi").decorate(protocol);
            SubmissionService service = SubmissionService.builder()
                .sandbox(() -> observed)
                .definitions(DefinitionService.builder().repository(forms).snapshots(new InMemoryDefinitionSnapshotStore(100, message -> { })).sandbox(() -> protocol).events(event -> { }).publicCacheSize(16).build())
                .dataSources(new DataSourceOptions(null, Duration.ofSeconds(2), null))
                .handler(accepted -> new SubmissionReceipt("id-1", null, null))
                .events(events::add)
                .observations(observations)
                .build();

            assertThat(service.submit(FormRef.fromDocument(), contact(), bus())).isInstanceOf(Accepted.class);

            assertThat(submission().low()).containsEntry("mode", "submit").containsEntry("channel", "bus")
                .containsEntry("outcome", "accepted").containsEntry("stage", "none").doesNotContainKey("form");
            assertThat(submission().high()).containsEntry("form", "contact");
            assertThat(recording.named(com.argusvane.datum.core.observation.DatumObservationNames.SANDBOX_RUN))
                .singleElement().satisfies(run -> {
                    assertThat(run.low("op")).isEqualTo("validate");
                    assertThat(run.parent()).isEqualTo(com.argusvane.datum.core.observation.DatumObservationNames.SUBMISSION);
                });
        }

        @Test
        void aRejectionCarriesItsStageAndAFormNoOneHasIsNeverAKey() {
            observations = recording.observations();
            runtime.outcome = context -> {
                ObjectNode outcome = TestRuntime.described(NODES.objectNode(), context);
                outcome.putArray("errors").addObject().put("componentId", "name").put("code", "required");
                return outcome;
            };
            service().submit(FormRef.fromDocument(), contact(), bus());
            assertThat(submission().low()).containsEntry("outcome", "rejected").containsEntry("stage", "sandbox");

            recording.clear();
            assertThat(service().test(FormRef.fromDocument(), com.argusvane.datum.submissions.Fixtures.envelope("no-such-form", "1", "{}"), bus()))
                .isInstanceOf(com.argusvane.datum.submissions.service.SubmissionOutcome.NotFound.class);
            assertThat(submission().low()).containsEntry("mode", "test").containsEntry("outcome", "not_found");
            assertThat(submission().high()).as("a key no form has never reaches a trace").doesNotContainKey("form");
        }

        @Test
        void anAddressRefusalIsObservedAsThrottledWithNoStageAndNoFormEvenForADryRun() {
            observations = recording.observations();
            throttle.denyAddress = Duration.ofSeconds(3);
            for (SubmissionMode mode : List.of(SubmissionMode.SUBMIT, SubmissionMode.TEST)) {
                recording.clear();
                assertThat(service().admitAddress("203.0.113.9", mode, "http")).isNotNull();
                assertThat(recording.named(com.argusvane.datum.core.observation.DatumObservationNames.SUBMISSION))
                    .as(mode.name()).singleElement().satisfies(refused -> {
                        assertThat(refused.low()).containsEntry("mode", mode.name().toLowerCase(java.util.Locale.ROOT))
                            .containsEntry("channel", "http").containsEntry("outcome", "throttled").containsEntry("stage", "none");
                        assertThat(refused.high()).doesNotContainKey("form");
                    });
            }

            recording.clear();
            throttle.denyAddress = null;
            assertThat(service().admitAddress("203.0.113.9", SubmissionMode.SUBMIT, "http")).isNull();
            assertThat(recording.named(com.argusvane.datum.core.observation.DatumObservationNames.SUBMISSION)).as("an admitted request is observed by the call that follows").isEmpty();
        }

        @Test
        void aRuntimeThatIsDownIsObservedAsUnavailable() {
            observations = recording.observations();
            sandboxDown = new com.argusvane.datum.core.ProgramUnavailableException("down");
            try {
                service().submit(FormRef.fromDocument(), contact(), bus());
            } catch (com.argusvane.datum.core.ProgramUnavailableException expected) {
                // Thrown or answered, the observation says the same.
            }
            assertThat(submission().low()).containsEntry("outcome", "unavailable").containsEntry("stage", "none");
        }
    }

    @Nested
    class TheSameVerdict {

        @Test
        void aBusDeliveryIsAcceptedAsTheRouteAcceptsItWithItsOwnChannelAndNoClientFacts() {
            SubmissionOutcome outcome = service().submit(FormRef.fromDocument(), contact(), bus());

            assertThat(outcome).isInstanceOf(Accepted.class);
            Accepted accepted = (Accepted) outcome;
            assertThat(accepted.receipt().id()).isEqualTo("id-1");
            assertThat(accepted.submission().digest()).isEqualTo(CanonicalJson.digest(contact()));
            assertThat(accepted.submission().channel()).isEqualTo("bus");
            assertThat(accepted.submission().remoteAddress()).isNull();
            assertThat(accepted.submission().userAgent()).isNull();
            assertThat(handled).hasSize(1);
            assertThat(eventsOf(SubmissionValidatedEvent.class)).singleElement()
                .satisfies(event -> assertThat(event.channel()).isEqualTo("bus"));

            // The same document on the route of a fresh host: the same digest and values, the client facts of the request.
            setUp();
            ReceiverAnswer answer = over(service()).submit(http(), delivered(contact()));
            assertThat(answer.body().path("digest").stringValue()).isEqualTo(accepted.submission().digest());
            assertThat(handled.get(0).values()).isEqualTo(accepted.submission().values());
            assertThat(handled.get(0).channel()).isEqualTo("http");
            assertThat(handled.get(0).remoteAddress()).isEqualTo("203.0.113.9");
            assertThat(handled.get(0).userAgent()).isEqualTo("tests");
        }

        @Test
        void aRefusalOfTheKernelIsTheSameRejectionOnBothChannels() {
            runtime.outcome = context -> {
                ObjectNode outcome = TestRuntime.described(NODES.objectNode(), context);
                outcome.putArray("errors").addObject().put("componentId", "name").put("code", "required");
                return outcome;
            };
            SubmissionOutcome outcome = service().submit(FormRef.fromDocument(), contact(), bus());
            assertThat(outcome).isEqualTo(new Rejected(List.of(SubmissionError.error("name", "required", null)), "sandbox"));
            assertThat(eventsOf(SubmissionRejectedEvent.class)).singleElement()
                .satisfies(event -> {
                    assertThat(event.channel()).isEqualTo("bus");
                    assertThat(event.remoteAddress()).isNull();
                });

            assertThatThrownBy(() -> over(service()).submit(http(), delivered(contact())))
                .isInstanceOf(DatumException.class)
                .satisfies(e -> assertThat(((DatumException) e).httpStatus()).isEqualTo(422));
            assertThat(eventsOf(SubmissionRejectedEvent.class)).last()
                .satisfies(event -> {
                    assertThat(event.channel()).isEqualTo("http");
                    assertThat(event.remoteAddress()).isEqualTo("203.0.113.9");
                });
            assertThat(handled).isEmpty();
        }

        @Test
        void anAttemptAcceptedOnOneChannelIsAnsweredWithItsFirstReceiptOnAnyOther() {
            SubmissionService service = service();
            ReceiverAnswer first = over(service).submit(http(), delivered(contact(), "attempt-1"));
            assertThat(first.body().path("handled").booleanValue()).isFalse();

            SubmissionOutcome again = service.submit(FormRef.fromDocument(), contact(), bus().withSubmissionKey("attempt-1"));
            assertThat(again).isEqualTo(new Redelivered(new SubmissionReceipt("id-1", "CONTACT-1", null), CanonicalJson.digest(contact())));
            assertThat(handled).as("the handler ran once for both channels").hasSize(1);
            assertThat(eventsOf(SubmissionRedeliveredEvent.class)).singleElement()
                .satisfies(event -> assertThat(event.channel()).isEqualTo("bus"));

            // And the other way round, on a fresh host.
            setUp();
            service = service();
            assertThat(service.submit(FormRef.of("contact"), contact(), SubmissionContext.of(SubmissionContext.SYNC).withSubmissionKey("attempt-2")))
                .isInstanceOf(Accepted.class);
            ReceiverAnswer repeated = over(service).submit(http(), delivered(contact(), "attempt-2"));
            assertThat(repeated.body().path("handled").booleanValue()).isTrue();
            assertThat(repeated.body().path("id").stringValue()).isEqualTo("id-1");
            assertThat(handled).hasSize(1);
            assertThat(eventsOf(SubmissionRedeliveredEvent.class)).singleElement()
                .satisfies(event -> assertThat(event.channel()).isEqualTo("http"));
        }

        @Test
        void theHandlerIsGivenTheSubmissionKeySoItCanStoreAnAttemptOnce() {
            SubmissionOutcome outcome = service().submit(FormRef.fromDocument(), contact(), bus().withSubmissionKey("attempt-1"));
            assertThat(((Accepted) outcome).submission().submissionKey()).isEqualTo("attempt-1");
            assertThat(handled.get(0).submissionKey()).isEqualTo("attempt-1");

            // The route passes the key of the body, and two people with the same answers are told apart by it.
            setUp();
            SubmissionService service = service();
            over(service).submit(http(), delivered(contact(), "attempt-2"));
            over(service).submit(http(), delivered(contact(), "attempt-3"));
            assertThat(handled).extracting(AcceptedSubmission::submissionKey).containsExactly("attempt-2", "attempt-3");
            assertThat(handled.get(0).digest()).isEqualTo(handled.get(1).digest());
        }

        @Test
        void twoAttemptsWithTheSameAnswersAreTwoSubmissions() {
            SubmissionService service = service();
            assertThat(service.submit(FormRef.fromDocument(), contact(), bus())).isInstanceOf(Accepted.class);
            assertThat(service.submit(FormRef.fromDocument(), contact(), bus())).isInstanceOf(Accepted.class);
            assertThat(handled).as("two people who give the same answers are two records").hasSize(2);
            assertThat(eventsOf(SubmissionRedeliveredEvent.class)).isEmpty();
        }

        @Test
        void aKnownKeyWithAnotherDocumentIsAConflictAndNeverTheFirstReceipt() {
            SubmissionService service = service();
            assertThat(service.submit(FormRef.fromDocument(), contact(), bus().withSubmissionKey("attempt-1"))).isInstanceOf(Accepted.class);
            ObjectNode other = envelope("contact", "1", "{\"name\":\"Grace\"}");
            SubmissionOutcome conflict = service.submit(FormRef.fromDocument(), other, bus().withSubmissionKey("attempt-1"));
            assertThat(conflict).isEqualTo(new KeyConflict(CanonicalJson.digest(other)));
            assertThat(handled).hasSize(1);
            assertThatThrownBy(() -> over(service).submit(http(), delivered(other, "attempt-1")))
                .isInstanceOf(DatumException.class)
                .satisfies(e -> {
                    assertThat(((DatumException) e).code()).isEqualTo("submission.keyConflict");
                    assertThat(((DatumException) e).httpStatus()).isEqualTo(409);
                });
        }

        @Test
        void aKnownKeyIsLookedUpBeforeTheSandboxSoAnotherDocumentIsAConflictEvenWhenItFailsARule() {
            SubmissionService service = service();
            assertThat(service.submit(FormRef.fromDocument(), contact(), bus().withSubmissionKey("attempt-1"))).isInstanceOf(Accepted.class);
            int runs = runtime.validations();

            // The same attempt again: the first receipt, and no run.
            assertThat(service.submit(FormRef.fromDocument(), contact(), bus().withSubmissionKey("attempt-1")))
                .isEqualTo(new Redelivered(new SubmissionReceipt("id-1", "CONTACT-1", null), CanonicalJson.digest(contact())));
            assertThat(runtime.validations()).as("a retry is answered before the sandbox").isEqualTo(runs);

            // The same key with another document that the kernel would refuse: a conflict, never the rule's errors.
            runtime.outcome = context -> {
                ObjectNode outcome = TestRuntime.described(NODES.objectNode(), context);
                outcome.putArray("errors").addObject().put("componentId", "name").put("code", "required");
                return outcome;
            };
            ObjectNode other = envelope("contact", "1", "{\"name\":\"\"}");
            assertThat(service.submit(FormRef.fromDocument(), other, bus().withSubmissionKey("attempt-1")))
                .isEqualTo(new KeyConflict(CanonicalJson.digest(other)));
            assertThat(runtime.validations()).as("the key is answered before the document is judged").isEqualTo(runs);
            assertThatThrownBy(() -> over(service).submit(http(), delivered(other, "attempt-1")))
                .isInstanceOf(DatumException.class)
                .satisfies(e -> assertThat(((DatumException) e).httpStatus()).isEqualTo(409));
            assertThat(eventsOf(SubmissionRejectedEvent.class)).isEmpty();
            assertThat(handled).hasSize(1);

            // A key no delivery was accepted under is still judged: the same document under a fresh key is refused 422.
            assertThat(service.submit(FormRef.fromDocument(), other, bus().withSubmissionKey("attempt-2"))).isInstanceOf(Rejected.class);
        }

        @Test
        void aDeliveryWithoutAKeyIsMalformedBeforeAnyRun() {
            SubmissionOutcome outcome = service().submit(FormRef.fromDocument(), contact(), SubmissionContext.of(SubmissionContext.BUS));
            assertThat(outcome).isInstanceOf(Malformed.class);
            assertThat(sandboxAsked).hasValue(0);
            assertThat(handled).isEmpty();
            assertThatThrownBy(() -> bus().withSubmissionKey("has space")).isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(() -> bus().withSubmissionKey("x".repeat(129))).isInstanceOf(IllegalArgumentException.class);
            // A check and a dry run carry none.
            assertThat(service().validate(FormRef.fromDocument(), contact(), SubmissionContext.of(SubmissionContext.BUS))).isInstanceOf(Checked.class);
        }
    }

    @Nested
    class NothingIsSkipped {

        @Test
        void aStaleVersionIsOutdatedBeforeAnyRun() {
            SubmissionOutcome outcome = service().submit(FormRef.fromDocument(), envelope("contact", "0", "{\"name\":\"Ada\"}"), bus());

            assertThat(outcome).isEqualTo(new Outdated("1", CanonicalJson.digest(Fixtures.contact())));
            assertThat(sandboxAsked).hasValue(0);
            assertThat(runtime.validations()).isZero();
            assertThat(handled).isEmpty();
        }

        /** The kernel reads the run context, not the definition, so the definition's map rides in the context. */
        @Test
        void theDefinitionsTranslationsRideInTheRunContextWhenItHasThem() {
            ObjectNode translated = Fixtures.contact();
            translated.set("translations", Fixtures.json("{\"fr-CA\":{\"components\":{\"name\":{\"patternMessage\":{\"text\":\"Forme\",\"source\":\"abc\"}}}}}"));
            forms = new Fixtures.Repository(translated);
            service().submit(FormRef.fromDocument(), envelope("contact", "1", "{\"name\":\"Ada\"}"), bus());
            assertThat(runtime.contexts().get(0).path("translations").path("fr-CA").path("components").path("name")
                .path("patternMessage").path("text").stringValue()).isEqualTo("Forme");

            setUp();
            service().submit(FormRef.fromDocument(), envelope("contact", "1", "{\"name\":\"Ada\"}"), bus());
            assertThat(runtime.contexts().get(0).has("translations")).as("a definition with no map sends none").isFalse();
        }

        /**
         * The host's catalog rides beside the map as {@code catalog}, only when it holds
         * something; the kernel's worded message is not asserted here (the bundled program is regenerated separately).
         */
        @Test
        void theHostCatalogRidesInTheRunContextOnlyWhenItHoldsSomething() {
            InMemoryTranslationCatalogStore store = new InMemoryTranslationCatalogStore();
            store.write("contact", (ObjectNode) Fixtures.json("{\"fr-CA\":{\"components\":{\"code\":{\"patternMessage\":\"C\"}}}}"), null);
            catalogs = store;
            service().submit(FormRef.fromDocument(), envelope("contact", "1", "{\"name\":\"Ada\"}"), bus());
            assertThat(runtime.contexts().get(0).path("catalog").path("fr-CA").path("components").path("code")
                .path("patternMessage").stringValue()).isEqualTo("C");

            setUp();
            catalogs = new InMemoryTranslationCatalogStore();
            service().submit(FormRef.fromDocument(), envelope("contact", "1", "{\"name\":\"Ada\"}"), bus());
            assertThat(runtime.contexts().get(0).has("catalog")).as("an empty catalog sends none").isFalse();

            setUp();
            service().submit(FormRef.fromDocument(), envelope("contact", "1", "{\"name\":\"Ada\"}"), bus());
            assertThat(runtime.contexts().get(0).has("catalog")).as("a host with no store sends none").isFalse();
        }

        /**
         * The catalog read is a dependency of the run like a customizer or the repository, so a store that throws
         * is the typed "no verdict" answer naming the store, never a raw exception, and no run is made.
         */
        @Test
        void aCatalogStoreThatThrowsIsTheTypedUnavailableAnswerNamingTheStore() {
            IllegalStateException down = new IllegalStateException("catalog database down");
            catalogs = new TranslationCatalogStore() {
                @Override
                public com.argusvane.datum.forms.translation.StoredCatalog read(String formKey) {
                    throw down;
                }

                @Override
                public String write(String formKey, ObjectNode catalog, String ifMatch) {
                    throw new AssertionError("a submission never writes the catalog");
                }
            };

            SubmissionOutcome outcome = service().submit(FormRef.fromDocument(), envelope("contact", "1", "{\"name\":\"Ada\"}"), bus());

            assertThat(outcome).isEqualTo(new Unavailable(SubmissionService.VALIDATOR_UNAVAILABLE, "The translation catalog store threw.", down));
            assertThat(runtime.validations()).isZero();
            assertThat(handled).isEmpty();
        }

        /** A store that answers nothing (a null stored catalog, or one holding a null catalog) is "no catalog": the run has none. */
        @Test
        void aCatalogStoreThatAnswersNothingGivesARunWithNoCatalogKey() {
            catalogs = new TranslationCatalogStore() {
                @Override
                public com.argusvane.datum.forms.translation.StoredCatalog read(String formKey) {
                    return null;
                }

                @Override
                public String write(String formKey, ObjectNode catalog, String ifMatch) {
                    throw new AssertionError("a submission never writes the catalog");
                }
            };
            SubmissionOutcome outcome = service().submit(FormRef.fromDocument(), envelope("contact", "1", "{\"name\":\"Ada\"}"), bus());
            assertThat(outcome).isInstanceOf(Accepted.class);
            assertThat(runtime.contexts().get(0).has("catalog")).as("a null stored catalog sends none").isFalse();

            setUp();
            catalogs = new TranslationCatalogStore() {
                @Override
                public com.argusvane.datum.forms.translation.StoredCatalog read(String formKey) {
                    return new com.argusvane.datum.forms.translation.StoredCatalog(null, null);
                }

                @Override
                public String write(String formKey, ObjectNode catalog, String ifMatch) {
                    throw new AssertionError("a submission never writes the catalog");
                }
            };
            outcome = service().submit(FormRef.fromDocument(), envelope("contact", "1", "{\"name\":\"Ada\"}"), bus());
            assertThat(outcome).isInstanceOf(Accepted.class);
            assertThat(runtime.contexts().get(0).has("catalog")).as("a null catalog sends none").isFalse();
        }

        @Test
        void theOptionSnapshotIsTakenAndASourceThatCannotAnswerStopsTheCall() {
            provider = (id, locale, principal) -> List.of(new OptionItem("red", null, null, null, null));
            service().submit(FormRef.fromDocument(), envelope("sourced", "1", "{\"colour\":\"red\"}"), bus());
            assertThat(runtime.contexts().get(0).path("optionSnapshot").path("colours").toString()).isEqualTo("[{\"value\":\"red\"}]");

            setUp();
            provider = (id, locale, principal) -> {
                throw new IllegalStateException("upstream down");
            };
            SubmissionOutcome outcome = service().submit(FormRef.fromDocument(), envelope("sourced", "1", "{\"colour\":\"red\"}"), bus());
            assertThat(outcome).isInstanceOf(Unavailable.class);
            assertThat(((Unavailable) outcome).code()).isEqualTo("server.unavailable");
            assertThat(((Unavailable) outcome).cause()).isInstanceOf(ProgramUnavailableException.class);
            assertThat(runtime.validations()).isZero();
            assertThat(handled).isEmpty();
        }

        @Test
        void theSignatureCheckSeesTheContextAndRefusesBeforeTheValidators() {
            AtomicReference<SubmissionContext> seen = new AtomicReference<>();
            signatureCheck = submission -> {
                seen.set(submission.submissionContext());
                return new SignatureVerdict(SignatureVerdict.Status.ABSENT, List.of(SubmissionError.error(null, "signature.required", "Sign it.")), Map.of());
            };
            validators.add(candidate -> {
                throw new AssertionError("validators run after the signature");
            });

            SubmissionOutcome outcome = service().submit(FormRef.fromDocument(), contact(), bus());

            assertThat(outcome).isInstanceOf(Rejected.class);
            assertThat(((Rejected) outcome).stage()).isEqualTo("signature");
            assertThat(seen.get().channel()).isEqualTo("bus");
            assertThat(handled).isEmpty();
        }

        @Test
        void theValidatorsRunAndOneThatThrowsIsValidatorUnavailableWithItsCause() {
            List<CandidateSubmission> judged = new ArrayList<>();
            validators.add(candidate -> {
                judged.add(candidate);
                return ValidatorResult.errors(SubmissionError.error("name", "server.taken", "Taken."));
            });
            SubmissionOutcome outcome = service().submit(FormRef.fromDocument(), contact(), bus());
            assertThat(outcome).isInstanceOf(Rejected.class);
            assertThat(((Rejected) outcome).stage()).isEqualTo("server");
            assertThat(judged.get(0).submissionContext().channel()).isEqualTo("bus");

            setUp();
            IllegalStateException down = new IllegalStateException("down");
            validators.add(candidate -> {
                throw down;
            });
            SubmissionOutcome failed = service().submit(FormRef.fromDocument(), contact(), bus());
            assertThat(failed).isEqualTo(new Unavailable(SubmissionService.VALIDATOR_UNAVAILABLE, "A server validator threw.", down));
            assertThat(handled).isEmpty();
        }

        @Test
        void aContributorSeesTheContextOfTheCall() {
            List<String> channels = new ArrayList<>();
            contributors.add((builder, submission) -> channels.add(submission.channel() + "|" + submission.principalName()));
            Principal device = () -> "device-7";

            service().submit(FormRef.fromDocument(), contact(), bus().withPrincipal(device));

            assertThat(channels).containsExactly("bus|device-7");
        }

        @Test
        void aRuntimeThatIsDownIsUnavailableWithItsOwnRefusal() {
            ProgramUnavailableException down = new ProgramUnavailableException("Submissions cannot be checked right now: stopped.");
            sandboxDown = down;

            SubmissionOutcome outcome = service().submit(FormRef.fromDocument(), contact(), bus());

            assertThat(outcome).isEqualTo(new Unavailable("server.unavailable", down.getMessage(), down));
            assertThat(handled).isEmpty();
        }
    }

    @Nested
    class TheCallersContext {

        @Test
        void theThrottleCountsTheKeyTheCallerBuiltWithItsChannel() {
            SubmissionContext device = bus().withThrottleKey(new ThrottleKey.Caller(null, "device-1"));
            service().submit(FormRef.fromDocument(), contact(), device);
            assertThat(throttle.recorded).containsExactly(new ThrottleKey(null, "contact", "device-1", ThrottleKey.Kind.SUBMIT, "bus"));

            setUp();
            throttle.deny = Duration.ofSeconds(30);
            SubmissionOutcome outcome = service().submit(FormRef.fromDocument(), contact(), device);
            assertThat(outcome).isInstanceOf(Throttled.class);
            assertThat(((Throttled) outcome).retryAfter()).isEqualTo(Duration.ofSeconds(30));
            assertThat(sandboxAsked).hasValue(0);
            assertThat(eventsOf(SubmissionThrottledEvent.class)).singleElement()
                .satisfies(event -> assertThat(event.channel()).isEqualTo("bus"));
        }

        /** Two addresses of one IPv6 /64 are one key, as the FastAPI host counts them; a mapped address is its IPv4 address. */
        @Test
        void theThrottleCountsAnIpv6CallerByItsSlash64() {
            for (String address : List.of("2001:db8:1:2::1", "2001:db8:1:2::ffff", "2001:db8:1:3::1", "::ffff:203.0.113.7")) {
                service().submit(FormRef.fromDocument(), contact(), bus().withThrottleKey(new ThrottleKey.Caller(address, null)));
            }
            assertThat(throttle.recorded).extracting(ThrottleKey::ip)
                .containsExactly("2001:db8:1:2::/64", "2001:db8:1:2::/64", "2001:db8:1:3::/64", "203.0.113.7");
            assertThat(throttle.recorded.get(0)).isEqualTo(throttle.recorded.get(1));
        }

        @Test
        void aContextWithNoThrottleKeyIsNotCountedAndTheRoutesAlwaysAre() {
            service().submit(FormRef.fromDocument(), contact(), bus());
            assertThat(throttle.checked).isEmpty();

            over(service()).submit(http(), delivered(contact()));
            assertThat(throttle.recorded).containsExactly(new ThrottleKey("203.0.113.9", "contact", null, ThrottleKey.Kind.SUBMIT));
        }

        @Test
        void aPreCheckSeesTheContextAndItsRefusalComesBeforeAnyRun() {
            List<IncomingSubmission> seen = new ArrayList<>();
            preChecks.add(incoming -> {
                seen.add(incoming);
                return "bus".equals(incoming.channel()) ? PreCheckDecision.Reject.of("spam.source") : PreCheckDecision.ALLOW;
            });

            SubmissionOutcome outcome = service().submit(FormRef.fromDocument(), contact(), bus().withClient("10.0.0.5", "agent/1"));

            assertThat(outcome).isEqualTo(new Refused(PreCheckDecision.Reject.of("spam.source")));
            assertThat(seen.get(0).formKey()).isEqualTo("contact");
            assertThat(seen.get(0).remoteAddress()).isEqualTo("10.0.0.5");
            assertThat(seen.get(0).bodyDigest()).as("a parsed document has no raw bytes").isNull();
            assertThat(sandboxAsked).hasValue(0);

            over(service()).submit(http(), delivered(contact()));
            assertThat(seen.get(1).channel()).isEqualTo("http");
            assertThat(seen.get(1).bodyDigest()).hasSize(64);
            assertThat(seen.get(1).header("user-agent")).isEqualTo("tests");
        }
    }

    @Nested
    class TheDocumentsRules {

        private SubmissionOutcome submit(JsonNode document) {
            return service().submit(FormRef.fromDocument(), document, bus());
        }

        @Test
        void eachRuleIsMetBeforeAnyRunWithTheRoutesWords() {
            ObjectNode surrogate = contact();
            ((ObjectNode) surrogate.path("submission").path("values")).put("name", "\uD800");
            assertThat(submit(surrogate)).isEqualTo(new Malformed("The submission is not JSON."));

            ObjectNode deep = contact();
            ObjectNode node = (ObjectNode) deep.path("submission").path("values");
            for (int i = 0; i < 70; i++) {
                node = node.putObject("n");
            }
            assertThat(submit(deep)).isEqualTo(new Malformed("The submission nests more than 64 levels deep."));

            ObjectNode huge = contact();
            ((ObjectNode) huge.path("submission").path("values")).put("n", BigInteger.TEN.pow(400));
            assertThat(submit(huge)).isEqualTo(new Malformed("The submission holds a number outside the range of a number."));

            assertThat(submit(NODES.arrayNode())).isEqualTo(new Malformed("The submission is not a JSON object."));

            ObjectNode check = contact();
            check.put("scope", "page");
            assertThat(submit(check)).isEqualTo(new Malformed("This is a check, not a submission."));

            ObjectNode wrapper = NODES.objectNode();
            wrapper.set("payload", contact());
            wrapper.putObject("format");
            wrapper.putArray("signatures");
            wrapper.put("extra", 1);
            assertThat(submit(wrapper)).isEqualTo(new Malformed("A signed document holds only format, payload and signatures."));

            assertThat(submit(envelope("not a key!", "1", "{}"))).isEqualTo(new NotFound("not a key!"));
            assertThat(submit(envelope("missing", "1", "{}"))).isEqualTo(new NotFound("missing"));

            ObjectNode noValues = contact();
            ((ObjectNode) noValues.path("submission")).put("values", "none");
            assertThat(submit(noValues)).isEqualTo(new Malformed("The submission has no values object."));

            ObjectNode badLocale = contact();
            ((ObjectNode) badLocale.path("submission")).put("locale", "en us");
            assertThat(submit(badLocale)).isEqualTo(new Malformed("The submission locale is not a language tag."));

            assertThat(runtime.validations()).isZero();
            assertThat(handled).isEmpty();
        }

        @Test
        void aFormTheCallerNamesMustBeTheFormTheDocumentNames() {
            assertThat(service().submit(FormRef.of("trip"), contact(), bus())).isEqualTo(new Malformed("The submission names another form."));
            assertThat(service().submit(FormRef.of("contact"), contact(), bus())).isInstanceOf(Accepted.class);
            assertThatThrownBy(() -> FormRef.of(null)).isInstanceOf(IllegalArgumentException.class);
        }

        @Test
        void aChannelIsAShortWord() {
            assertThat(SubmissionContext.of("nightly-batch:2026/10").channel()).isEqualTo("nightly-batch:2026/10");
            assertThatThrownBy(() -> SubmissionContext.of("two words")).isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(() -> SubmissionContext.of("")).isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(() -> SubmissionContext.of("x".repeat(65))).isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(() -> bus().withBodyDigest("ABC")).isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Nested
    class ChecksAndDryRuns {

        @Test
        void aJourneyCheckIsCheckedAndPublishesItsChannel() {
            SubmissionOutcome outcome = service().validate(FormRef.fromDocument(),
                envelope("trip", "2", "{\"name\":\"Ada\"}"), JourneyCheck.journey(), bus());
            assertThat(outcome).isInstanceOf(Checked.class);
            assertThat(((Checked) outcome).journeyId()).isEqualTo("main");
            assertThat(eventsOf(JourneyCheckedEvent.class)).singleElement()
                .satisfies(event -> assertThat(event.channel()).isEqualTo("bus"));
            assertThat(handled).isEmpty();
        }

        @Test
        void aPageCheckNamingNoPageIsMalformed() {
            assertThat(service().validate(FormRef.fromDocument(), envelope("trip", "2", "{}"), JourneyCheck.page("nope"), bus()))
                .isEqualTo(new Malformed("The check names no page of the journey."));
        }

        @Test
        void aDryRunReportsAndPublishesNothing() {
            SubmissionOutcome outcome = service().test(FormRef.fromDocument(), contact(), "debug", bus());

            assertThat(outcome).isInstanceOf(DryRun.class);
            DryRun dryRun = (DryRun) outcome;
            assertThat(dryRun.accepted()).isTrue();
            assertThat(dryRun.report().path("outcome").stringValue()).isEqualTo("accepted");
            assertThat(dryRun.report().path("sandbox").path("logLevel").stringValue()).isEqualTo("debug");
            assertThat(dryRun.values().path("name").stringValue()).isEqualTo("Ada");
            assertThat(events).isEmpty();
            assertThat(handled).isEmpty();
        }

        @Test
        void aDryRunReportAlwaysNamesTheFourIdLists() {
            DryRun dryRun = (DryRun) service().test(FormRef.fromDocument(), contact(), "debug", bus());

            for (String key : List.of("visibilitySkipped", "clientDerived", "clockDependent", "serverRules")) {
                assertThat(dryRun.report().path(key).isArray()).as(key).isTrue();
            }
        }
    }

    @Test
    void aReceiverTakesAServiceOrItsPartsNeverBoth() {
        SubmissionService service = service();
        assertThat(over(service).service()).isSameAs(service);
        assertThatThrownBy(() -> SubmissionReceiver.builder().service(service).throttle(throttle)
            .json(DatumJsonMapper.create(1024)).maxBodyBytes(1024).build())
            .isInstanceOf(IllegalStateException.class);
    }

    /**
     * The size cap: the service holds a caller with no bytes to the routes' body cap, measured on the
     * tree as the fewest bytes its JSON text can take, so a body the route read under the cap is never refused again.
     */
    @Nested
    class TheSizeCap {

        private ObjectNode padded(int length) {
            ObjectNode document = contact();
            ((ObjectNode) document.path("submission").path("values")).put("note", "x".repeat(length));
            return document;
        }

        @Test
        void aDocumentPastTheCapIsTooLargeBeforeTheThrottleThePreChecksAndAnyRunInEveryMode() {
            cap = 16 * 1024;
            List<IncomingSubmission> seen = new ArrayList<>();
            preChecks.add(incoming -> {
                seen.add(incoming);
                return PreCheckDecision.ALLOW;
            });
            SubmissionContext counted = bus().withThrottleKey(new ThrottleKey.Caller("198.51.100.7", null));
            ObjectNode big = padded(17 * 1024);
            SubmissionService service = service();

            assertThat(service.submit(FormRef.fromDocument(), big, counted)).isEqualTo(new TooLarge(16 * 1024));
            assertThat(service.validate(FormRef.fromDocument(), big, counted)).isEqualTo(new TooLarge(16 * 1024));
            assertThat(service.test(FormRef.fromDocument(), big, counted)).isEqualTo(new TooLarge(16 * 1024));
            assertThat(service.pdfCheck(FormRef.fromDocument(), big, counted)).isEqualTo(new TooLarge(16 * 1024));
            assertThat(throttle.checked).isEmpty();
            assertThat(seen).isEmpty();
            assertThat(sandboxAsked).hasValue(0);
            assertThat(handled).isEmpty();
            assertThat(events).isEmpty();

            assertThat(service.submit(FormRef.fromDocument(), padded(15 * 1024), counted)).isInstanceOf(Accepted.class);
        }

        @Test
        void aTreeThatHoldsItselfIsTooLargeRatherThanALoop() {
            ObjectNode document = contact();
            ((ObjectNode) document.path("submission").path("values")).set("loop", document);
            assertThat(service().submit(FormRef.fromDocument(), document, bus())).isEqualTo(new TooLarge(1 << 20));
            assertThat(sandboxAsked).hasValue(0);
        }

        @Test
        void aBodyTheRouteReadUnderItsCapIsNeverRefusedAgainAsATree() throws Exception {
            cap = 16 * 1024;
            // Exponents and escapes: the body reads into a tree whose own text is far longer than the body.
            String base = new String(delivered(contact()), StandardCharsets.UTF_8);
            int at = base.indexOf("\"name\":\"Ada\"") + "\"name\":\"Ada\"".length();
            StringBuilder pad = new StringBuilder(",\"note\":\"\\u00e9\",\"pad\":[1e5");
            while (base.length() + pad.length() + 6 < cap) {
                pad.append(",1e5");
            }
            pad.append(']');
            StringBuilder body = new StringBuilder(base.substring(0, at)).append(pad).append(base.substring(at));
            while (body.length() < cap) {
                body.append(' ');
            }
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            assertThat(bytes).hasSize((int) cap);
            JsonNode tree = DatumJsonMapper.create(cap).mapper().readTree(bytes);
            assertThat(tree.toString().length()).as("the tree's own text is past the cap").isGreaterThan((int) cap);

            ReceiverAnswer answer = over(service()).submit(http(), bytes);
            assertThat(answer.body().path("status").stringValue()).isEqualTo("accepted");
            assertThat(handled).hasSize(1);
            assertThat(service().test(FormRef.fromDocument(), tree.get("document"), bus())).isInstanceOf(DryRun.class);

            // One byte more is the route's own 413, on the bytes, before the service.
            byte[] oneMore = java.util.Arrays.copyOf(bytes, bytes.length + 1);
            oneMore[bytes.length] = ' ';
            assertThatThrownBy(() -> over(service()).submit(http(), oneMore)).isInstanceOf(RequestTooLargeException.class);
        }

        @Test
        void theCapDefaultsToTheBodyCapsDefaultAndAReceiverBuiltOfPartsPassesItsOwn() {
            SubmissionService defaults = SubmissionService.builder()
                .sandbox(() -> sandbox)
                .definitions(DefinitionService.builder().repository(forms).snapshots(new InMemoryDefinitionSnapshotStore(100, message -> { })).sandbox(() -> sandbox).events(event -> { }).publicCacheSize(16).build())
                .dataSources(new DataSourceOptions(null, Duration.ofSeconds(2), null))
                .handler(submission -> new SubmissionReceipt("id", "ref", null))
                .events(event -> { })
                .build();
            assertThat(defaults.maxDocumentBytes()).isEqualTo(ProgramLimits.BODY_BYTES.defaultValue());
            assertThatThrownBy(() -> SubmissionService.builder().maxDocumentBytes(0)).isInstanceOf(IllegalArgumentException.class);

            SubmissionReceiver parts = SubmissionReceiver.builder()
                .sandbox(() -> sandbox)
                .definitions(DefinitionService.builder().repository(forms).snapshots(new InMemoryDefinitionSnapshotStore(100, message -> { })).sandbox(() -> sandbox).events(event -> { }).publicCacheSize(16).build())
                .dataSources(new DataSourceOptions(null, Duration.ofSeconds(2), null))
                .handler(submission -> new SubmissionReceipt("id", "ref", null))
                .events(event -> { })
                .json(DatumJsonMapper.create(32 * 1024)).maxBodyBytes(32 * 1024).build();
            assertThat(parts.service().maxDocumentBytes()).isEqualTo(32 * 1024);
        }

        /** A word the program does not read is refused when the service is built, never first on a run. */
        @Test
        void aWordTheProgramDoesNotReadIsRefusedAtBuild() {
            assertThatThrownBy(() -> SubmissionService.builder()
                .sandbox(() -> sandbox)
                .definitions(DefinitionService.builder().repository(forms).snapshots(new InMemoryDefinitionSnapshotStore(100, message -> { })).sandbox(() -> sandbox).events(event -> { }).publicCacheSize(16).build())
                .dataSources(new DataSourceOptions(null, Duration.ofSeconds(2), null))
                .handler(submission -> new SubmissionReceipt("id", "ref", null))
                .events(event -> { })
                .logLevel("verbose")
                .build()).isInstanceOf(IllegalArgumentException.class).hasMessageContaining("logLevel is 'verbose'");
            assertThatThrownBy(() -> SubmissionReceiver.builder()
                .sandbox(() -> sandbox)
                .definitions(DefinitionService.builder().repository(forms).snapshots(new InMemoryDefinitionSnapshotStore(100, message -> { })).sandbox(() -> sandbox).events(event -> { }).publicCacheSize(16).build())
                .dataSources(new DataSourceOptions(null, Duration.ofSeconds(2), null))
                .handler(submission -> new SubmissionReceipt("id", "ref", null))
                .events(event -> { })
                .unknownFields("drop")
                .json(DatumJsonMapper.create(32 * 1024)).maxBodyBytes(32 * 1024).build())
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("unknownFields is 'drop'");
        }
    }

    /**
     * A pre-check's refusal is carried as the pre-check gave it, its code and words for any caller and no status:
     * the route maps the code to the status it answers.
     */
    @Test
    void aRefusalCarriesThePreChecksCodeAndWordsAndTheRouteChoosesTheStatus() {
        preChecks.add(incoming -> new PreCheckDecision.Reject("spam.throttled", "Slow down."));
        SubmissionOutcome outcome = service().submit(FormRef.fromDocument(), contact(), bus());
        assertThat(outcome).isInstanceOfSatisfying(Refused.class, refused -> {
            assertThat(refused.code()).isEqualTo("spam.throttled");
            assertThat(refused.message()).isEqualTo("Slow down.");
        });
        assertThatThrownBy(() -> over(service()).submit(http(), delivered(contact())))
            .isInstanceOfSatisfying(DatumException.class, e -> {
                assertThat(e.code()).isEqualTo("spam.throttled");
                // The standard mapping: 403 for every code (a code's words never choose a 429 without a Retry-After).
                assertThat(e.httpStatus()).isEqualTo(403);
            });
    }

    static final class Throttle implements SubmissionThrottle {
        Duration deny;
        Duration denyAddress;
        final List<ThrottleKey> checked = new ArrayList<>();
        final List<ThrottleKey> recorded = new ArrayList<>();

        @Override
        public ThrottleDecision checkAddress(String address) {
            return denyAddress == null ? ThrottleDecision.ALLOW : new ThrottleDecision.Deny(denyAddress);
        }

        @Override
        public ThrottleDecision check(ThrottleKey key) {
            checked.add(key);
            return deny == null ? ThrottleDecision.ALLOW : new ThrottleDecision.Deny(deny);
        }

        @Override
        public void record(ThrottleKey key) {
            recorded.add(key);
        }
    }

    /**
     * Every hook of a run reads the same {@link SubmissionContext}, the host options customizer and the rules
     * provider included (they took no context before), whatever the channel.
     */
    @Nested
    class TheHooksSeeTheContext {

        @Test
        void theHostOptionsCustomizerAndTheRulesProviderReadTheCallersContext() {
            List<String> seen = new ArrayList<>();
            hostCustomizers.add((key, definition, settings, submission) -> {
                seen.add("customizer:" + key + ":" + submission.channel() + ":" + submission.principal().getName());
                settings.setLogLevel("debug");
            });
            rulesProviders.add((key, definition, submission) -> {
                seen.add("rules:" + key + ":" + submission.channel());
                return List.of();
            });
            java.security.Principal device = () -> "device-7";

            SubmissionOutcome outcome = service().submit(FormRef.fromDocument(), contact(), bus().withPrincipal(device));

            assertThat(outcome).isInstanceOf(Accepted.class);
            assertThat(seen).containsExactly("customizer:contact:bus:device-7", "rules:contact:bus");
            List<ObjectNode> contexts = runtime.contexts();
            assertThat(contexts.get(contexts.size() - 1).path("logLevel").asString()).isEqualTo("debug");
        }
    }
}
