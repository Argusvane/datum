package com.argusvane.datum.submissions.receiver;

import static com.argusvane.datum.submissions.Fixtures.bytes;
import static com.argusvane.datum.submissions.Fixtures.check;
import static com.argusvane.datum.submissions.Fixtures.envelope;
import static com.argusvane.datum.submissions.Fixtures.json;
import static com.argusvane.datum.submissions.Fixtures.delivered;
import static com.argusvane.datum.submissions.Fixtures.wrapped;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.DatumException;
import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.core.RequestTooLargeException;
import com.argusvane.datum.core.canonical.CanonicalJson;
import com.argusvane.datum.core.contracts.OptionItem;
import com.argusvane.datum.sandbox.protocol.RuleModule;
import com.argusvane.datum.sandbox.protocol.SandboxException;
import com.argusvane.datum.sandbox.protocol.SandboxService;
import com.argusvane.datum.forms.DefinitionService;
import com.argusvane.datum.forms.FormNotFoundException;
import com.argusvane.datum.forms.datasource.DataSourceOptions;
import com.argusvane.datum.forms.datasource.DataSourceProvider;
import com.argusvane.datum.forms.snapshot.InMemoryDefinitionSnapshotStore;
import com.argusvane.datum.submissions.Fixtures;
import com.argusvane.datum.sandbox.runtime.TestRuntime;
import com.argusvane.datum.submissions.events.JourneyCheckedEvent;
import com.argusvane.datum.submissions.events.SubmissionRejectedEvent;
import com.argusvane.datum.submissions.events.SubmissionThrottledEvent;
import com.argusvane.datum.submissions.events.SubmissionValidatedEvent;
import com.argusvane.datum.submissions.spi.AcceptedSubmission;
import com.argusvane.datum.submissions.spi.CandidateSubmission;
import com.argusvane.datum.submissions.spi.IncomingSubmission;
import com.argusvane.datum.submissions.spi.PreCheckDecision;
import com.argusvane.datum.submissions.spi.SignatureVerdict;
import com.argusvane.datum.submissions.spi.SubmissionError;
import com.argusvane.datum.submissions.spi.SubmissionMode;
import com.argusvane.datum.submissions.spi.SubmissionPreCheck;
import com.argusvane.datum.submissions.spi.SubmissionReceipt;
import com.argusvane.datum.submissions.spi.SubmissionRequest;
import com.argusvane.datum.submissions.spi.SubmissionSignatureCheck;
import com.argusvane.datum.submissions.spi.SubmissionThrottle;
import com.argusvane.datum.submissions.spi.SubmissionValidator;
import com.argusvane.datum.submissions.spi.ThrottleDecision;
import com.argusvane.datum.submissions.spi.ThrottleKey;
import com.argusvane.datum.submissions.spi.ValidatorResult;
import com.argusvane.datum.web.error.BadRequestException;
import com.argusvane.datum.web.error.UnsupportedMediaTypeException;
import com.argusvane.datum.web.json.DatumJsonMapper;
import java.security.Principal;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ObjectNode;

/**
 * The receiver's order and refusals, from the conformance suite's REC rows and the journey check rules:
 * each refusal comes before anything costlier, and a refused request runs
 * no sandbox, calls no handler and (outside its own) publishes no event.
 */
class SubmissionReceiverTest {

    private TestRuntime runtime;
    private SandboxService service;
    private Fixtures.Repository forms;
    private Throttle throttle;
    private List<Object> events;
    private List<AcceptedSubmission> handled;
    private List<SubmissionPreCheck> preChecks;
    private List<SubmissionValidator> validators;
    private List<String> calls;
    private SubmissionSignatureCheck signatureCheck;
    private DataSourceProvider provider;
    private List<com.argusvane.datum.submissions.spi.SandboxContextContributor> contributors;
    private List<com.argusvane.datum.submissions.spi.SandboxRulesProvider> rules;
    private long cap;
    private InMemoryDefinitionSnapshotStore snapshots;
    /** An event type whose listener throws (the publisher's own failure), or null. */
    private Class<?> listenerThrowsOn;
    /** Whether the events go through the host's default (guarded) publisher; false: an application's own, as given. */
    private boolean defaultPublisher = true;
    
    private com.argusvane.datum.core.DatumEventPublisher published(com.argusvane.datum.core.DatumEventPublisher publisher) {
        return defaultPublisher ? com.argusvane.datum.core.DatumEventPublisher.guarded(publisher) : publisher;
    }
    private SubmissionHandlerDouble handlerDouble;
    private com.argusvane.datum.submissions.spi.SubmissionIdempotencyStore idempotency;

    /** A data source that owns every source id and answers each with what {@code items} gives. */
    private static DataSourceProvider source(java.util.function.Supplier<List<OptionItem>> items) {
        return new DataSourceProvider() {
            @Override
            public List<OptionItem> items(String id, String locale, Principal principal) {
                return items.get();
            }

            @Override
            public boolean exists(String id) {
                return true;
            }
        };
    }

    @BeforeEach
    void setUp() {
        runtime = new TestRuntime();
        service = runtime.service();
        forms = new Fixtures.Repository(Fixtures.contact(), Fixtures.trip(), Fixtures.twoJourneys(), Fixtures.sourced());
        throttle = new Throttle();
        events = Collections.synchronizedList(new ArrayList<>());
        handled = new ArrayList<>();
        preChecks = new ArrayList<>();
        validators = new ArrayList<>();
        calls = Collections.synchronizedList(new ArrayList<>());
        contributors = new ArrayList<>();
        rules = new ArrayList<>();
        signatureCheck = null;
        provider = null;
        cap = 1 << 20;
        snapshots = new InMemoryDefinitionSnapshotStore(100);
        listenerThrowsOn = null;
        handlerDouble = null;
        idempotency = new com.argusvane.datum.submissions.idempotency.InMemorySubmissionIdempotencyStore(100);
        failingSandbox = null;
    }

    /** A sandbox that stands in for the service in a test of what a failing run is answered as; null: the service. */
    private com.argusvane.datum.sandbox.protocol.Sandbox failingSandbox;

    private SubmissionReceiver receiver() {
        return receiver(null);
    }

    private SubmissionReceiver receiver(com.argusvane.datum.submissions.receiver.PreCheckStatuses statuses) {
        return SubmissionReceiver.builder()
            .preCheckStatuses(statuses)
            .sandbox(() -> {
                calls.add("sandbox");
                return failingSandbox != null ? failingSandbox : service;
            })
            .definitions(DefinitionService.builder().repository(forms).snapshots(snapshots).sandbox(() -> service).events(event -> { }).publicCacheSize(16).build())
            .dataSources(new DataSourceOptions(provider, Duration.ofSeconds(2), null))
            .json(DatumJsonMapper.create(cap))
            .maxBodyBytes(cap)
            .handler(submission -> {
                calls.add("handler");
                if (handlerDouble != null) {
                    return handlerDouble.handle(submission);
                }
                handled.add(submission);
                return new SubmissionReceipt("id-1", "CONTACT-1", json("{\"title\":\"Thanks\"}"));
            })
            .throttle(throttle)
            .preChecks(preChecks)
            .validators(validators)
            .contributors(contributors)
            .rulesProviders(rules)
            .signatureCheck(signatureCheck)
            .idempotency(idempotency)
            .events(published(event -> {
                calls.add("event:" + event.getClass().getSimpleName());
                events.add(event);
                if (listenerThrowsOn != null && listenerThrowsOn.isInstance(event)) {
                    throw new IllegalStateException("listener down");
                }
            }))
            .build();
    }

    private static SubmissionRequest request() {
        return new SubmissionRequest("application/json", Map.of("User-Agent", List.of("tests")), "203.0.113.9", null);
    }

    private static ObjectNode contactEnvelope() {
        return envelope("contact", "1", "{\"name\":\"Ada\"}");
    }

    private <T> List<T> eventsOf(Class<T> type) {
        return events.stream().filter(type::isInstance).map(type::cast).toList();
    }

    // ------------------------------------------------------------------------------------------ 415, 413, 400

    @Nested
    class Reading {

        @Test
        void aBodyThatIsNotJsonByItsTypeIsRefusedBeforeAnythingElse() {
            SubmissionRequest plain = new SubmissionRequest("text/plain", Map.of(), null, null);
            assertThatThrownBy(() -> receiver().submit(plain, delivered(contactEnvelope())))
                .isInstanceOf(UnsupportedMediaTypeException.class);
            assertThat(throttle.checked).isEmpty();
            assertThat(runtime.validations()).isZero();
        }

        @Test
        void aBodyPastTheCapIs413BeforeItIsParsed() {
            cap = 64;
            assertThatThrownBy(() -> receiver().submit(request(), bytes("{\"document\":" + "x".repeat(100) + "}")))
                .isInstanceOf(RequestTooLargeException.class)
                .satisfies(e -> assertThat(((DatumException) e).httpStatus()).isEqualTo(413));
            assertThat(throttle.checked).isEmpty();
        }

        @Test
        void notJsonAndNotAnObjectAreBadDocuments() {
            for (String body : List.of("", "{", "nope", "null", "[]", "\"x\"", "1")) {
                assertThatThrownBy(() -> receiver().submit(request(), bytes(body)))
                    .as(body)
                    .isInstanceOf(BadRequestException.class)
                    .satisfies(e -> assertThat(((DatumException) e).code()).isEqualTo("bad_document"));
            }
            assertThatThrownBy(() -> receiver().submit(request(), new byte[] {0x7b, 0x22, (byte) 0xff, (byte) 0xfe, 0x22, 0x7d}))
                .isInstanceOf(BadRequestException.class);
            assertThat(throttle.checked).isEmpty();
        }

        @Test
        void aNumberOutsideTheRangeOfANumberIsABadDocument() {
            String body = new String(delivered(contactEnvelope()), java.nio.charset.StandardCharsets.UTF_8).replace("\"Ada\"", "1e999");
            assertThatThrownBy(() -> receiver().submit(request(), bytes(body))).isInstanceOf(BadRequestException.class)
                .hasMessageContaining("outside the range");
            String negative = new String(check(contactEnvelope(), "journey", null), java.nio.charset.StandardCharsets.UTF_8).replace("\"Ada\"", "-1e999");
            assertThatThrownBy(() -> receiver().validate(request(), bytes(negative))).isInstanceOf(BadRequestException.class);
            assertThat(runtime.validations()).isZero();
        }

        @Test
        void aDocumentDeeperThan64LevelsIsABadDocument() {
            StringBuilder deep = new StringBuilder();
            for (int i = 0; i < 70; i++) {
                deep.append('[');
            }
            deep.append('1');
            for (int i = 0; i < 70; i++) {
                deep.append(']');
            }
            String body = new String(delivered(contactEnvelope()), java.nio.charset.StandardCharsets.UTF_8).replace("\"Ada\"", deep);
            assertThatThrownBy(() -> receiver().submit(request(), bytes(body))).isInstanceOf(BadRequestException.class)
                .hasMessageContaining("64 levels");
        }

        @Test
        void aCheckSentToTheSubmitRouteIsRefused() {
            ObjectNode withScope = contactEnvelope();
            withScope.put("scope", "journey");
            assertThatThrownBy(() -> receiver().submit(request(), delivered(withScope))).isInstanceOf(BadRequestException.class)
                .hasMessage("This is a check, not a submission.");
            // REC-05 scope-on-submit / pageid-on-submit: beside the document.
            assertThatThrownBy(() -> receiver().submit(request(), check(contactEnvelope(), "journey", null)))
                .isInstanceOf(BadRequestException.class);
            ObjectNode body = json("{}");
            body.set("document", contactEnvelope());
            body.put("pageId", "p1");
            assertThatThrownBy(() -> receiver().submit(request(), Fixtures.bytes(body))).isInstanceOf(BadRequestException.class);
        }

        @Test
        void aSignedWrapperHoldsOnlyFormatPayloadAndSignatures() {
            ObjectNode smuggled = json("{\"format\":{\"scope\":\"envelope\"},\"signatures\":[],\"smuggled\":{\"name\":\"x\"}}");
            smuggled.set("payload", contactEnvelope());
            assertThatThrownBy(() -> receiver().submit(request(), delivered(smuggled))).isInstanceOf(BadRequestException.class);
            ObjectNode noSignatures = json("{\"format\":{}}");
            noSignatures.set("payload", contactEnvelope());
            assertThatThrownBy(() -> receiver().submit(request(), delivered(noSignatures))).isInstanceOf(BadRequestException.class);
            ObjectNode noFormat = json("{\"signatures\":[]}");
            noFormat.set("payload", contactEnvelope());
            assertThatThrownBy(() -> receiver().submit(request(), delivered(noFormat))).isInstanceOf(BadRequestException.class);
            assertThatThrownBy(() -> receiver().submit(request(), delivered(json("{\"format\":{},\"signatures\":[],\"payload\":\"x\"}"))))
                .isInstanceOf(BadRequestException.class);
            assertThat(runtime.validations()).isZero();
        }

        @Test
        void noValuesOrALocaleThatIsNotATagAreBadDocuments() {
            ObjectNode noValues = contactEnvelope();
            ((ObjectNode) noValues.get("submission")).remove("values");
            assertThatThrownBy(() -> receiver().submit(request(), delivered(noValues))).isInstanceOf(BadRequestException.class);
            for (String locale : List.of("en\n", "<script>", "x".repeat(33))) {
                ObjectNode bad = contactEnvelope();
                ((ObjectNode) bad.get("submission")).put("locale", locale);
                assertThatThrownBy(() -> receiver().submit(request(), delivered(bad))).isInstanceOf(BadRequestException.class)
                    .hasMessageContaining("locale");
            }
        }

        @Test
        void aCheckReadsALocaleThatIsNotATagAsEnglish() {
            ObjectNode bad = contactEnvelope();
            ((ObjectNode) bad.get("submission")).put("locale", "en\n");
            receiver().validate(request(), check(bad, "journey", null));
            // contact has no journeys: the check is answered journey.unknown without a run, and the bad locale
            // never breaks a check.
            assertThat(eventsOf(JourneyCheckedEvent.class)).hasSize(1);
        }

        @Test
        void aDeliveryWithoutItsSubmissionKeyIsABadDocument() {
            // The bare document, and the wrapper without a key or with one that is not a key: never received.
            for (byte[] body : List.of(Fixtures.bytes(contactEnvelope()), wrapped(contactEnvelope()),
                    bytes("{\"document\":" + contactEnvelope() + ",\"submissionKey\":7}"),
                    delivered(contactEnvelope(), "has space"), delivered(contactEnvelope(), "x".repeat(129)))) {
                assertThatThrownBy(() -> receiver().submit(request(), body)).isInstanceOf(BadRequestException.class)
                    .satisfies(e -> assertThat(((DatumException) e).code()).isEqualTo("bad_document"));
            }
            assertThat(handled).isEmpty();
            ReceiverAnswer answer = receiver().submit(request(), delivered(contactEnvelope(), "x".repeat(128)));
            assertThat(answer.body().path("status").stringValue()).isEqualTo("accepted");
        }

        /** FormKeys is the one key rule: 128 characters reach the repository, 129 do not. */
        @Test
        void theKeyRuleIsFormKeysOneHundredTwentyEightCharacters() {
            assertThatThrownBy(() -> receiver().submit(request(), delivered(envelope("a".repeat(129), "1", "{}"))))
                .isInstanceOf(UnknownFormException.class);
            assertThat(forms.reads).hasValue(0);
            assertThatThrownBy(() -> receiver().submit(request(), delivered(envelope("a".repeat(128), "1", "{}"))))
                .isInstanceOf(FormNotFoundException.class);
            assertThat(forms.reads.get()).as("a key that passes the rule is asked of the repository").isPositive();
        }

        @Test
        void aFormKeyNoRepositoryCanHoldIsNotFoundWithoutAskingOneOrRepeatingIt() {
            assertThatThrownBy(() -> receiver().submit(request(), delivered(envelope("../etc", "1", "{}"))))
                .isInstanceOf(FormNotFoundException.class);
            // SEC-05: an id such as this one is never reflected into the error body.
            assertThatThrownBy(() -> receiver().submit(request(), delivered(envelope("Stack trace /var/www/html <br />", "1", "{}"))))
                .isInstanceOf(UnknownFormException.class)
                .satisfies(e -> {
                    UnknownFormException unknown = (UnknownFormException) e;
                    assertThat(unknown.code()).isEqualTo("form.notFound");
                    assertThat(unknown.httpStatus()).isEqualTo(404);
                    assertThat(unknown.getMessage()).isEqualTo("There is no such form.");
                    assertThat(unknown.errorItems()).singleElement()
                        .satisfies(item -> assertThat(item.message()).doesNotContain("Stack", "/var/www", "<br"));
                });
            assertThat(forms.reads).hasValue(0);
            assertThat(throttle.checked).isEmpty();
        }

        @Test
        void aLoneSurrogateInAValueOrAKeyIsNotJson() {
            // Strict JSON refuses these: 400 before the throttle, the data sources or a run.
            String good = new String(delivered(contactEnvelope()), java.nio.charset.StandardCharsets.UTF_8);
            for (String bad : List.of(good.replace("\"Ada\"", "\"\\ud800\""), good.replace("\"Ada\"", "\"x\\udc00y\""),
                good.replace("\"name\"", "\"\\ud83d\""))) {
                assertThatThrownBy(() -> receiver().submit(request(), bytes(bad)))
                    .as(bad)
                    .isInstanceOf(BadRequestException.class)
                    .hasMessage("The submission is not JSON.");
            }
            String check = new String(check(contactEnvelope(), "journey", null), java.nio.charset.StandardCharsets.UTF_8)
                .replace("\"Ada\"", "\"\\ud800\"");
            assertThatThrownBy(() -> receiver().validate(request(), bytes(check))).isInstanceOf(BadRequestException.class)
                .hasMessage("The submission is not JSON.");
            assertThatThrownBy(() -> receiver().test(request(), bytes(good.replace("\"Ada\"", "\"\\ud800\""))))
                .isInstanceOf(BadRequestException.class);
            // A pair is a character, not a refusal.
            receiver().submit(request(), bytes(good.replace("\"Ada\"", "\"\\ud83d\\ude00\"")));
            assertThat(throttle.checked).hasSize(1);
            assertThat(runtime.validations()).isEqualTo(1);
        }

        @Test
        void anIntegerTooLongForADoubleIsOutsideTheRangeOfANumber() {
            // Jackson reads it as a BigInteger, which the kernel's JSON.parse would make Infinity.
            String body = new String(delivered(contactEnvelope()), java.nio.charset.StandardCharsets.UTF_8).replace("\"Ada\"", "1" + "0".repeat(400));
            assertThatThrownBy(() -> receiver().submit(request(), bytes(body))).isInstanceOf(BadRequestException.class)
                .hasMessageContaining("outside the range");
            String decimal = new String(delivered(contactEnvelope()), java.nio.charset.StandardCharsets.UTF_8).replace("\"Ada\"", "-1" + "0".repeat(400) + ".5");
            assertThatThrownBy(() -> receiver().submit(request(), bytes(decimal))).isInstanceOf(BadRequestException.class);
            assertThat(runtime.validations()).isZero();
        }
    }

    // ------------------------------------------------------------------------------------------ throttle, pre-check (access is the application's security)

    @Nested
    class BeforeTheDefinition {

        @Test
        void aThrottledRequestRunsNoSandboxAndPublishesItsEvent() {
            throttle.deny = Duration.ofMillis(1500);
            assertThatThrownBy(() -> receiver().submit(request(), delivered(contactEnvelope())))
                .isInstanceOf(ThrottledException.class)
                .satisfies(e -> {
                    ThrottledException throttled = (ThrottledException) e;
                    assertThat(throttled.httpStatus()).isEqualTo(429);
                    // The wire's code and words (conformance suite REC-14).
                    assertThat(throttled.code()).isEqualTo("flood");
                    assertThat(throttled.getMessage()).isEqualTo("Too many submissions from your address. Try again later.");
                    assertThat(throttled.responseHeaders()).containsEntry("Retry-After", "2");
                });
            assertThat(runtime.validations()).isZero();
            assertThat(throttle.recorded).isEmpty();
            assertThat(forms.reads).hasValue(0);
            assertThat(eventsOf(SubmissionThrottledEvent.class)).singleElement()
                .satisfies(event -> assertThat(event.kind()).isEqualTo(ThrottleKey.Kind.SUBMIT));
        }

        @Test
        void theAddressLimitComesAfterTheContentTypeAndCountsTheAddressAsTheThrottleCountsIt() {
            SubmissionRequest plain = new SubmissionRequest("text/plain", Map.of(), "203.0.113.9", null);
            assertThatThrownBy(() -> receiver().admit(plain, SubmissionMode.SUBMIT)).isInstanceOf(UnsupportedMediaTypeException.class);
            assertThat(throttle.addressesChecked).as("415 before the address is counted").isEmpty();
            receiver().admit(request(), SubmissionMode.SUBMIT);
            receiver().admit(new SubmissionRequest("application/json", Map.of(), "2001:db8:1:2::7", null), SubmissionMode.VALIDATE);
            receiver().admit(new SubmissionRequest("application/json", Map.of(), "[::ffff:198.51.100.4]", null), SubmissionMode.TEST);
            assertThat(throttle.addressesRecorded).containsExactly("203.0.113.9", "2001:db8:1:2::/64", "198.51.100.4");
            assertThat(throttle.checked).as("the per-form throttle waits for the parse").isEmpty();
        }

        @Test
        void aRequestWithNoClientAddressIsNotCountedByTheAddressLimit() {
            throttle.denyAddress = Duration.ofSeconds(5);
            receiver().admit(new SubmissionRequest("application/json", Map.of(), null, null), SubmissionMode.SUBMIT);
            receiver().admit(new SubmissionRequest("application/json", Map.of(), "", null), SubmissionMode.SUBMIT);
            assertThat(throttle.addressesChecked).isEmpty();
            assertThat(throttle.addressesRecorded).isEmpty();
        }

        @Test
        void aRequestOverTheAddressLimitIsTheFlood429AndPublishesThePerFormRefusalsEvent() {
            throttle.denyAddress = Duration.ofMillis(1500);
            assertThatThrownBy(() -> receiver().admit(new SubmissionRequest("application/json", Map.of(), "2001:db8:1:2::7", null), SubmissionMode.SUBMIT))
                .isInstanceOf(ThrottledException.class)
                .satisfies(e -> {
                    ThrottledException throttled = (ThrottledException) e;
                    assertThat(throttled.httpStatus()).isEqualTo(429);
                    assertThat(throttled.code()).isEqualTo("flood");
                    assertThat(throttled.responseHeaders()).containsEntry("Retry-After", "2");
                });
            assertThat(throttle.addressesRecorded).as("a refused request is not counted").isEmpty();
            assertThat(eventsOf(SubmissionThrottledEvent.class)).singleElement().satisfies(event -> {
                assertThat(event.kind()).isEqualTo(ThrottleKey.Kind.SUBMIT);
                assertThat(event.key()).isEqualTo(new ThrottleKey("2001:db8:1:2::/64", null, null, ThrottleKey.Kind.SUBMIT));
                assertThat(event.channel()).isEqualTo("http");
            });
            events.clear();
            assertThatThrownBy(() -> receiver().admit(request(), SubmissionMode.TEST)).isInstanceOf(ThrottledException.class);
            assertThat(events).as("a dry run publishes nothing, not even its throttling").isEmpty();
            assertThat(runtime.validations()).isZero();
        }

        @Test
        void receiveDoesNotCountTheAddressAgain() {
            receiver().submit(request(), delivered(contactEnvelope()));
            assertThat(throttle.addressesChecked).isEmpty();
            assertThat(throttle.recorded).hasSize(1);
        }

        @Test
        void aThrottledDryRunIsRefusedButPublishesNothing() {
            throttle.deny = Duration.ofSeconds(1);
            assertThatThrownBy(() -> receiver().test(request(), wrapped(contactEnvelope()))).isInstanceOf(ThrottledException.class);
            assertThat(throttle.checked).singleElement().satisfies(key -> assertThat(key.kind()).isEqualTo(ThrottleKey.Kind.TEST));
            assertThat(events).isEmpty();
            assertThat(runtime.validations()).isZero();
        }

        @Test
        void theThrottleCountsByModeAndRecordsAnAllowedAttemptBeforeLaterRefusals() {
            assertThatThrownBy(() -> receiver().submit(request(), delivered(envelope("contact", "0", "{}"))))
                .isInstanceOf(SubmissionOutdatedException.class);
            receiver().validate(request(), check(contactEnvelope(), "journey", null));
            receiver().test(request(), wrapped(contactEnvelope()));
            assertThat(throttle.recorded).extracting(ThrottleKey::kind)
                .containsExactly(ThrottleKey.Kind.SUBMIT, ThrottleKey.Kind.VALIDATE, ThrottleKey.Kind.TEST);
            assertThat(throttle.recorded.get(0)).isEqualTo(new ThrottleKey("203.0.113.9", "contact", null, ThrottleKey.Kind.SUBMIT));
        }

        @Test
        void aPreCheckRejectRunsNoSandboxAndAnswersItsCodeAndStatus() {
            List<IncomingSubmission> seen = new ArrayList<>();
            preChecks.add(incoming -> {
                seen.add(incoming);
                return new PreCheckDecision.Reject("spam.invalid", "No.");
            });
            preChecks.add(incoming -> {
                throw new AssertionError("The first refusal answers.");
            });
            byte[] body = delivered(contactEnvelope());
            assertThatThrownBy(() -> receiver(PreCheckStatuses.bySuffix()).submit(request(), body))
                .isInstanceOf(DatumException.class)
                .satisfies(e -> {
                    assertThat(((DatumException) e).code()).isEqualTo("spam.invalid");
                    assertThat(((DatumException) e).httpStatus()).as("the suffix mapping: .invalid is 422").isEqualTo(422);
                    assertThat(e.getMessage()).isEqualTo("No.");
                });
            assertThat(runtime.validations()).isZero();
            assertThat(forms.reads).hasValue(0);
            assertThat(seen).singleElement().satisfies(incoming -> {
                assertThat(incoming.formKey()).isEqualTo("contact");
                assertThat(incoming.mode()).isEqualTo(SubmissionMode.SUBMIT);
                assertThat(incoming.remoteAddress()).isEqualTo("203.0.113.9");
                assertThat(incoming.bodyDigest()).isEqualTo(CanonicalJson.sha256Hex(new String(body, java.nio.charset.StandardCharsets.UTF_8)));
                assertThat(incoming.header("user-agent")).isEqualTo("tests");
                assertThat(incoming.principal()).as("anonymous").isNull();
            });
        }

        /**
         * A refusal names a code and words only; the route maps the code to the status: 403 for every code
         * unless the application gives a mapping (the code-suffix one, or its own), and a mapping that answers no refusal
         * fails the request.
         */
        @Test
        void theRouteMapsAPreChecksCodeToItsStatus() {
            String[] code = {"spam.honeypot"};
            preChecks.add(incoming -> PreCheckDecision.Reject.of(code[0]));
            // The standard mapping: 403 whatever the code says, as Reject.of answers.
            for (String name : List.of("spam.honeypot", "access.denied", "captcha.invalid", "spam.throttled", "captcha.unavailable")) {
                code[0] = name;
                assertThatThrownBy(() -> receiver().submit(request(), delivered(contactEnvelope())))
                    .as(name)
                    .isInstanceOfSatisfying(DatumException.class, e -> {
                        assertThat(e.code()).isEqualTo(name);
                        assertThat(e.httpStatus()).isEqualTo(403);
                        assertThat(e).as("never a 429 without its Retry-After").isNotInstanceOf(ThrottledException.class);
                    });
            }
            // The suffix mapping, opted into: 422 for .invalid, 503 for .unavailable, and 403 for everything else,
            // .throttled included (a 429 on this wire always carries Retry-After, which a pre-check has no way to give).
            java.util.Map<String, Integer> expected = new java.util.LinkedHashMap<>();
            expected.put("spam.honeypot", 403);
            expected.put("access.denied", 403);
            expected.put("captcha.invalid", 422);
            expected.put("spam.throttled", 403);
            expected.put("captcha.unavailable", 503);
            expected.put("invalid", 403);
            SubmissionReceiver bySuffix = receiver(com.argusvane.datum.submissions.receiver.PreCheckStatuses.bySuffix());
            expected.forEach((name, status) -> {
                code[0] = name;
                assertThatThrownBy(() -> bySuffix.submit(request(), delivered(contactEnvelope())))
                    .as(name)
                    .isInstanceOfSatisfying(DatumException.class, e -> {
                        assertThat(e.code()).isEqualTo(name);
                        assertThat(e.httpStatus()).isEqualTo(status);
                    });
            });
            code[0] = "spam.honeypot";
            SubmissionReceiver own = receiver(name -> name.equals("spam.honeypot") ? 400 : 403);
            assertThatThrownBy(() -> own.submit(request(), delivered(contactEnvelope())))
                .isInstanceOfSatisfying(DatumException.class, e -> assertThat(e.httpStatus()).isEqualTo(400));
            SubmissionReceiver broken = receiver(name -> 200);
            assertThatThrownBy(() -> broken.submit(request(), delivered(contactEnvelope()))).isInstanceOf(IllegalStateException.class);
            assertThat(runtime.validations()).isZero();
            // The code is a word: a refusal cannot smuggle text into the wire's code.
            assertThatThrownBy(() -> PreCheckDecision.Reject.of("no spaces here")).isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(() -> PreCheckDecision.Reject.of("")).isInstanceOf(IllegalArgumentException.class);
        }

        @Test
        void aPreCheckSeesTheCallerSoOneFormCanBeRefusedToOnePerson() {
            // Who may use a given form is the application's rule, and the form key is in the body, so
            // the pre-check is where it is written; it needs the caller the route's security admitted.
            preChecks.add(incoming -> incoming.principal() != null && "outsider".equals(incoming.principal().getName())
                && "contact".equals(incoming.formKey()) ? PreCheckDecision.Reject.of("access.denied") : PreCheckDecision.ALLOW);
            SubmissionRequest outsider = new SubmissionRequest("application/json", Map.of(), "203.0.113.9", principal("outsider"));
            for (SubmissionMode mode : List.of(SubmissionMode.SUBMIT, SubmissionMode.TEST)) {
                byte[] body = delivered(contactEnvelope());
                assertThatThrownBy(() -> receiver().receive(outsider, body, mode))
                    .as(mode.name())
                    .isInstanceOf(DatumException.class)
                    .satisfies(e -> {
                        assertThat(((DatumException) e).code()).isEqualTo("access.denied");
                        assertThat(((DatumException) e).httpStatus()).isEqualTo(403);
                    });
            }
            assertThatThrownBy(() -> receiver().validate(outsider, check(contactEnvelope(), "journey", null)))
                .isInstanceOf(DatumException.class)
                .satisfies(e -> assertThat(((DatumException) e).code()).isEqualTo("access.denied"));
            assertThat(runtime.validations()).isZero();
            assertThat(handled).isEmpty();
            SubmissionRequest ada = new SubmissionRequest("application/json", Map.of(), "203.0.113.9", principal("ada"));
            assertThat(receiver().submit(ada, delivered(contactEnvelope())).status()).isEqualTo(200);
            assertThat(receiver().submit(request(), delivered(contactEnvelope())).status()).as("anonymous").isEqualTo(200);
        }
    }

    // ------------------------------------------------------------------------------------------ the definition

    @Nested
    class TheDefinition {

        @Test
        void anUnknownFormIsNotFoundAndRunsNothing() {
            assertThatThrownBy(() -> receiver().submit(request(), delivered(envelope("Exception", "1", "{}"))))
                .isInstanceOf(UnknownFormException.class)
                .satisfies(e -> assertThat(((UnknownFormException) e).errorItems().get(0).message()).doesNotContain("Exception"));
            assertThat(runtime.validations()).isZero();
        }

        @Test
        void anAcceptedDeliveryLeavesItsDefinitionVersionResolvable() {
            // Plan, "Receiver correctness": AcceptedSubmission.definitionSha256 always resolves later, even from a
            // repository that never saves.
            receiver().submit(request(), delivered(contactEnvelope()));
            String sha256 = handled.get(0).definitionSha256();
            assertThat(snapshots.find("contact", sha256)).hasValueSatisfying(definition ->
                assertThat(CanonicalJson.digest(definition)).isEqualTo(sha256));
        }

        @Test
        void aStaleVersionIs409WithTheCurrentHashAndRunsNoSandbox() {
            for (String version : List.of("0", "999")) {
                assertThatThrownBy(() -> receiver().submit(request(), delivered(envelope("contact", version, "{\"name\":\"Ada\"}"))))
                    .isInstanceOf(SubmissionOutdatedException.class)
                    .satisfies(e -> {
                        SubmissionOutdatedException outdated = (SubmissionOutdatedException) e;
                        assertThat(outdated.httpStatus()).isEqualTo(409);
                        assertThat(outdated.code()).isEqualTo("form.outdated");
                        assertThat(outdated.currentSha256()).isEqualTo(CanonicalJson.digest(Fixtures.contact()));
                        // The 409 names no hash; the full definition's is builder-only (server-secret rules).
                        assertThat(outdated.responseHeaders()).isEmpty();
                        assertThat(outdated.extraBody()).isEmpty();
                        assertThat(outdated.errorItems()).singleElement().satisfies(item -> assertThat(item.message()).doesNotContain(outdated.currentSha256()));
                    });
            }
            ObjectNode noVersion = contactEnvelope();
            ((ObjectNode) noVersion.path("versionContext").path("form")).remove("version");
            assertThatThrownBy(() -> receiver().submit(request(), delivered(noVersion))).isInstanceOf(SubmissionOutdatedException.class);
            assertThat(runtime.validations()).isZero();
            assertThat(calls).doesNotContain("sandbox");
        }
    }

    // ------------------------------------------------------------------------------------------ delivery

    @Nested
    class Delivery {

        @Test
        void anAcceptedDeliveryIsHandledThenPublishedAndAnsweredWithItsReceipt() {
            runtime.outcome = context -> {
                ObjectNode outcome = TestRuntime.accepting(context);
                outcome.putArray("errors").addObject().put("componentId", "name").put("code", "spelling").put("severity", "warning");
                outcome.putArray("clientDerived").add("total");
                outcome.putArray("clockDependent").add("name");
                outcome.putArray("logs").addObject().put("level", "info").put("message", "hello");
                outcome.putArray("index").addObject().put("path", "name").put("delta", "0").put("value", "Ada");
                return outcome;
            };
            validators.add(candidate -> ValidatorResult.warnings(SubmissionError.warning("name", "server.note", "Checked.")));
            ObjectNode document = contactEnvelope();

            ReceiverAnswer answer = receiver().submit(request(), delivered(document));

            assertThat(answer.status()).isEqualTo(200);
            ObjectNode body = answer.body();
            assertThat(body.path("id").stringValue()).isEqualTo("id-1");
            assertThat(body.path("reference").stringValue()).isEqualTo("CONTACT-1");
            assertThat(body.path("status").stringValue()).isEqualTo("accepted");
            assertThat(body.path("digest").stringValue()).isEqualTo(CanonicalJson.digest(document));
            assertThat(body.path("receipt").path("title").stringValue()).isEqualTo("Thanks");
            assertThat(body.path("warnings")).hasSize(2);
            assertThat(body.path("warnings").get(1).path("message").stringValue()).isEqualTo("Checked.");

            AcceptedSubmission accepted = handled.get(0);
            assertThat(accepted.formKey()).isEqualTo("contact");
            assertThat(accepted.definitionSha256()).isEqualTo(CanonicalJson.digest(Fixtures.contact()));
            assertThat(accepted.canonicalDocument()).isEqualTo(CanonicalJson.serialize(document));
            assertThat(accepted.digest()).isEqualTo(CanonicalJson.digest(document));
            assertThat(accepted.values().path("name").stringValue()).isEqualTo("Ada");
            assertThat(accepted.warnings()).extracting(SubmissionError::code).containsExactly("spelling", "server.note");
            assertThat(accepted.warnings().get(1).stage()).isEqualTo("server");
            assertThat(accepted.clientDerived()).containsExactly("total");
            assertThat(accepted.clockDependent()).containsExactly("name");
            assertThat(accepted.runLog()).hasSize(1);
            assertThat(accepted.index()).hasSize(1);
            assertThat(accepted.remoteAddress()).isEqualTo("203.0.113.9");
            assertThat(accepted.userAgent()).isEqualTo("tests");
            assertThat(accepted.locale()).isEqualTo("en");
            assertThat(accepted.signature()).isNull();

            // Order: the sandbox, the handler, then the event.
            assertThat(calls).containsExactly("sandbox", "handler", "event:SubmissionValidatedEvent");
            assertThat(eventsOf(SubmissionValidatedEvent.class).get(0).receipt().id()).isEqualTo("id-1");
        }

        @Test
        void sandboxErrorsStopBeforeTheValidatorsWithA422AndItsEvent() {
            runtime.outcome = context -> {
                ObjectNode outcome = TestRuntime.described(json("{\"errors\":[{\"componentId\":\"name\",\"code\":\"required\"}]}"), context);
                return outcome;
            };
            validators.add(candidate -> {
                throw new AssertionError("validators run only on accepted answers");
            });
            assertThatThrownBy(() -> receiver().submit(request(), delivered(contactEnvelope())))
                .isInstanceOf(SubmissionRejectedException.class)
                .satisfies(e -> {
                    SubmissionRejectedException rejected = (SubmissionRejectedException) e;
                    assertThat(rejected.httpStatus()).isEqualTo(422);
                    assertThat(rejected.stage()).isEqualTo("sandbox");
                    assertThat(rejected.errorItems()).singleElement().satisfies(item -> {
                        assertThat(item.field()).isEqualTo("name");
                        assertThat(item.code()).isEqualTo("required");
                    });
                });
            assertThat(handled).isEmpty();
            assertThat(eventsOf(SubmissionRejectedEvent.class)).singleElement().satisfies(event -> {
                assertThat(event.stage()).isEqualTo("sandbox");
                assertThat(event.formKey()).isEqualTo("contact");
                assertThat(event.remoteAddress()).isEqualTo("203.0.113.9");
            });
        }

        @Test
        void anOutcomeWithoutValuesIsRejectedEvenWithoutAnError() {
            runtime.outcome = context -> TestRuntime.described(json("{\"errors\":[]}"), context);
            assertThatThrownBy(() -> receiver().submit(request(), delivered(contactEnvelope())))
                .isInstanceOf(SubmissionRejectedException.class);
            assertThat(handled).isEmpty();
        }

        @Test
        void validatorErrorsAre422AtTheServerStageAfterEveryValidatorRan() {
            List<String> ran = new ArrayList<>();
            validators.add(candidate -> {
                ran.add("first");
                assertThat(candidate.scope().kind()).isEqualTo("submission");
                assertThat(candidate.scope().test()).isFalse();
                return ValidatorResult.errors(SubmissionError.error("name", "server.taken", "Taken."));
            });
            validators.add(candidate -> {
                ran.add("second");
                return ValidatorResult.warnings(SubmissionError.warning(null, "server.late", null));
            });
            assertThatThrownBy(() -> receiver().submit(request(), delivered(contactEnvelope())))
                .isInstanceOf(SubmissionRejectedException.class)
                .satisfies(e -> {
                    SubmissionRejectedException rejected = (SubmissionRejectedException) e;
                    assertThat(rejected.stage()).isEqualTo("server");
                    assertThat(rejected.errors()).extracting(SubmissionError::code).containsExactly("server.taken", "server.late");
                    assertThat(rejected.errors().get(0).stage()).isEqualTo("server");
                    assertThat(rejected.errors().get(0).source()).isEqualTo("server");
                });
            assertThat(ran).containsExactly("first", "second");
            assertThat(handled).isEmpty();
            assertThat(eventsOf(SubmissionRejectedEvent.class)).singleElement()
                .satisfies(event -> assertThat(event.stage()).isEqualTo("server"));
        }

        @Test
        void validatorWarningsReachTheEventAndNeverBlock() {
            validators.add(candidate -> ValidatorResult.warnings(SubmissionError.warning("name", "server.soft", null)));
            receiver().submit(request(), delivered(contactEnvelope()));
            assertThat(eventsOf(SubmissionValidatedEvent.class)).singleElement()
                .satisfies(event -> assertThat(event.submission().warnings()).extracting(SubmissionError::code).containsExactly("server.soft"));
        }

        @Test
        void aValidatorThatThrowsIs503ValidatorUnavailableAndNothingIsHandled() {
            validators.add(candidate -> {
                throw new IllegalStateException("database down");
            });
            assertThatThrownBy(() -> receiver().submit(request(), delivered(contactEnvelope())))
                .isInstanceOf(ValidatorUnavailableException.class)
                .satisfies(e -> assertThat(((DatumException) e).httpStatus()).isEqualTo(503));
            assertThat(handled).isEmpty();
        }

        @Test
        void aValidatorThatThrowsAnErrorIsNotCaughtAndNothingIsHandled() {
            validators.add(candidate -> {
                throw new StackOverflowError();
            });
            assertThatThrownBy(() -> receiver().submit(request(), delivered(contactEnvelope())))
                .isInstanceOf(StackOverflowError.class);
            validators.clear();
            validators.add(candidate -> {
                throw new AssertionError("broken invariant");
            });
            assertThatThrownBy(() -> receiver().submit(request(), delivered(contactEnvelope())))
                .isInstanceOf(AssertionError.class);
            assertThat(handled).isEmpty();
        }

        @Test
        void aListenerThatThrowsNeverChangesTheAnswer() {
            listenerThrowsOn = SubmissionValidatedEvent.class;
            ReceiverAnswer answer = receiver().submit(request(), delivered(contactEnvelope()));
            assertThat(answer.status()).isEqualTo(200);
            assertThat(answer.body().path("id").stringValue()).isEqualTo("id-1");

            listenerThrowsOn = SubmissionRejectedEvent.class;
            runtime.outcome = context -> TestRuntime.described(json("{\"errors\":[{\"componentId\":\"name\",\"code\":\"required\"}]}"), context);
            assertThatThrownBy(() -> receiver().submit(request(), delivered(contactEnvelope())))
                .isInstanceOf(SubmissionRejectedException.class)
                .satisfies(e -> assertThat(((SubmissionRejectedException) e).errorItems().get(0).code()).isEqualTo("required"));
        }

        /**
         * An application's own publisher is used as given, so one that throws on the
         * accepted event (an outbox write that failed) reaches the caller after the handler stored the submission.
         */
        @Test
        void anApplicationsOwnPublisherThatThrowsReachesTheCallerAfterTheHandler() {
            defaultPublisher = false;
            listenerThrowsOn = SubmissionValidatedEvent.class;
            assertThatThrownBy(() -> receiver().submit(request(), delivered(contactEnvelope())))
                .isInstanceOf(IllegalStateException.class).hasMessage("listener down");
            assertThat(handled).hasSize(1);
            assertThat(eventsOf(SubmissionValidatedEvent.class)).hasSize(1);
        }

        @Test
        void aHandlerThatThrowsStoresNothingAndFiresNoEvent() {
            handlerDouble = submission -> {
                throw new IllegalStateException("database down");
            };
            assertThatThrownBy(() -> receiver().submit(request(), delivered(contactEnvelope())))
                .isInstanceOf(IllegalStateException.class).hasMessage("database down");
            assertThat(eventsOf(SubmissionValidatedEvent.class)).isEmpty();
            handlerDouble = submission -> null;
            assertThatThrownBy(() -> receiver().submit(request(), delivered(contactEnvelope())))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("no receipt");
            assertThat(eventsOf(SubmissionValidatedEvent.class)).isEmpty();
        }

        @Test
        void theValidatorsSeeTheSanitizedValuesNotTheRawOnes() {
            runtime.outcome = context -> {
                ObjectNode outcome = TestRuntime.accepting(context);
                outcome.set("values", json("{\"name\":\"Ada\"}"));
                return outcome;
            };
            List<CandidateSubmission> seen = new ArrayList<>();
            validators.add(candidate -> {
                seen.add(candidate);
                return ValidatorResult.OK;
            });
            receiver().submit(request(), delivered(envelope("contact", "1", "{\"name\":\"Ada\",\"smuggled\":1}")));
            assertThat(seen.get(0).values().has("smuggled")).isFalse();
            assertThat(handled.get(0).values().has("smuggled")).isFalse();
        }

        @Test
        void aDigestTheHostDisagreesWithIs503AndNothingIsHandled() {
            runtime.outcome = context -> {
                ObjectNode outcome = TestRuntime.accepting(context);
                // Self-consistent, but of another document.
                outcome.put("canonical", "{\"other\":true}");
                outcome.put("digest", CanonicalJson.sha256Hex("{\"other\":true}"));
                return outcome;
            };
            assertThatThrownBy(() -> receiver().submit(request(), delivered(contactEnvelope())))
                .isInstanceOf(ValidatorUnavailableException.class)
                .hasMessageContaining("digested");
            assertThat(handled).isEmpty();
        }

        @Test
        void anOutcomeWithoutItsDocumentDigestOrIndexIs503() {
            runtime.outcome = context -> json("{\"errors\":[],\"values\":{}}");
            assertThatThrownBy(() -> receiver().submit(request(), delivered(contactEnvelope())))
                .isInstanceOf(ValidatorUnavailableException.class).hasMessageContaining("no canonical document or digest");
            runtime.outcome = context -> {
                ObjectNode outcome = TestRuntime.accepting(context);
                outcome.put("digest", "0".repeat(64));
                return outcome;
            };
            assertThatThrownBy(() -> receiver().submit(request(), delivered(contactEnvelope())))
                .isInstanceOf(ValidatorUnavailableException.class).hasMessageContaining("not the SHA-256");
            runtime.outcome = context -> {
                ObjectNode outcome = TestRuntime.accepting(context);
                outcome.remove("index");
                return outcome;
            };
            assertThatThrownBy(() -> receiver().submit(request(), delivered(contactEnvelope())))
                .isInstanceOf(ValidatorUnavailableException.class).hasMessageContaining("index");
            assertThat(handled).isEmpty();
        }

        @Test
        void aBusyRuntimeAnswersItsOwnCodeAndNothingIsHandled() {
            service = new SandboxService(com.argusvane.datum.sandbox.protocol.ProgramRunner.on(runtime), service.program(), new com.argusvane.datum.sandbox.protocol.RunScript("/* f */"),
                com.argusvane.datum.sandbox.protocol.ProgramLimits.defaults(), com.argusvane.datum.sandbox.protocol.HostOptions.defaults(),
                new com.argusvane.datum.sandbox.protocol.RunSlots(1, Duration.ZERO, "validation"),
                new com.argusvane.datum.sandbox.protocol.AbiProbe(), com.argusvane.datum.sandbox.protocol.RunLog.slf4j(), null);
            try (var taken = service.slots().acquire()) {
                assertThatThrownBy(() -> receiver().submit(request(), delivered(contactEnvelope())))
                    .isInstanceOf(SandboxException.class)
                    .satisfies(e -> {
                        assertThat(((DatumException) e).code()).isEqualTo("server.busy");
                        assertThat(((DatumException) e).httpStatus()).isEqualTo(503);
                    });
            }
            assertThat(handled).isEmpty();
            assertThat(eventsOf(SubmissionRejectedEvent.class)).isEmpty();
        }

        @Test
        void theContextIsBuiltFromTheServersDefinitionAndTheDocumentGoesInAfterTheContributors() {
            contributors.add((builder, req) -> {
                builder.context().set("document", json("{\"forged\":true}"));
                builder.context().put("formulaErrors", "warn");
                ((ObjectNode) builder.context().get("values")).put("name", "Changed");
                builder.context().putObject("externalData").put("k", "v");
                builder.rules().add(new RuleModule("extra", "1.0.0", "({validators: []})"));
            });
            ObjectNode document = contactEnvelope();
            receiver().submit(request(), delivered(document));
            ObjectNode context = runtime.contexts().get(0);
            assertThat(context.path("formId").stringValue()).isEqualTo("contact");
            assertThat(context.path("form").path("id").stringValue()).isEqualTo("root");
            assertThat(context.get("document")).isEqualTo(document);
            assertThat(context.path("formulaErrors").stringValue()).isEqualTo("fail");
            assertThat(context.path("today").isString()).isTrue();
            assertThat(context.path("externalData").path("k").stringValue()).isEqualTo("v");
            assertThat(context.path("unknownFields").stringValue()).isEqualTo("strip");
            assertThat(context.path("logLevel").stringValue()).as("unset: the kernel's own default").isEqualTo("warn");
            assertThat(context.has("reportFold")).isFalse();
            // The contributor changed the run's values, never the document the digest is taken from.
            assertThat(context.path("values").path("name").stringValue()).isEqualTo("Changed");
            assertThat(handled.get(0).digest()).isEqualTo(CanonicalJson.digest(document));
        }

        @Test
        void ruleModulesComeFromTheProvidersInOrder() {
            rules.add((key, definition, submission) -> List.of(new RuleModule("a", "1.0.0", "({validators: []})")));
            rules.add((key, definition, submission) -> List.of(new RuleModule("b", "1.0.0", "({validators: []})")));
            ReceiverAnswer report = receiver().test(request(), wrapped(contactEnvelope()));
            assertThat(report.body().path("sandbox").path("rules").toString()).isEqualTo("[\"a\",\"b\"]");
            rules.clear();
            rules.add((key, definition, submission) -> {
                throw new IllegalStateException("file missing");
            });
            assertThatThrownBy(() -> receiver().submit(request(), delivered(contactEnvelope())))
                .isInstanceOf(com.argusvane.datum.core.ProgramUnavailableException.class);
        }

        @Test
        void aContributorThatThrowsIs503AndRunsNothing() {
            contributors.add((builder, req) -> {
                throw new IllegalStateException("boom");
            });
            assertThatThrownBy(() -> receiver().submit(request(), delivered(contactEnvelope()))).isInstanceOf(ValidatorUnavailableException.class);
            assertThat(runtime.validations()).isZero();
            contributors.clear();
            contributors.add((builder, req) -> {
                throw new AssertionError("an Error, not an exception");
            });
            assertThatThrownBy(() -> receiver().submit(request(), delivered(contactEnvelope()))).isInstanceOf(AssertionError.class);
            assertThat(runtime.validations()).isZero();
        }

        @Test
        void aHostOptionsCustomizerThatThrowsIs503AndRunsNothing() {
            assertThatThrownBy(() -> SubmissionReceiver.builder()
                .definitions(DefinitionService.builder().repository(forms).snapshots(snapshots).sandbox(() -> service).events(event -> { }).publicCacheSize(16).build())
                .sandbox(() -> service).dataSources(new DataSourceOptions(null, Duration.ofSeconds(2), null))
                .json(DatumJsonMapper.create(cap)).maxBodyBytes(cap).handler(submission -> null).events(event -> { })
                .customizers(List.of((key, definition, settings, submission) -> {
                    throw new IllegalStateException("settings store down");
                }))
                .build().submit(request(), delivered(contactEnvelope())))
                .isInstanceOf(ValidatorUnavailableException.class);
            assertThat(runtime.validations()).isZero();
        }

        /** A word the program does not read fails the run as a throwing customizer does: never a quiet default. */
        @Test
        void aHostOptionsCustomizerThatSetsAWordTheProgramDoesNotReadIs503AndRunsNothing() {
            for (java.util.function.Consumer<com.argusvane.datum.sandbox.protocol.RunSettings> set : List.<java.util.function.Consumer<com.argusvane.datum.sandbox.protocol.RunSettings>>of(
                settings -> settings.setLogLevel("verbose"), settings -> settings.setUnknownFields("drop"))) {
                assertThatThrownBy(() -> SubmissionReceiver.builder()
                    .definitions(DefinitionService.builder().repository(forms).snapshots(snapshots).sandbox(() -> service).events(event -> { }).publicCacheSize(16).build())
                    .sandbox(() -> service).dataSources(new DataSourceOptions(null, Duration.ofSeconds(2), null))
                    .json(DatumJsonMapper.create(cap)).maxBodyBytes(cap).handler(submission -> null).events(event -> { })
                    .customizers(List.of((key, definition, settings, submission) -> set.accept(settings)))
                    .build().submit(request(), delivered(contactEnvelope())))
                    .isInstanceOf(ValidatorUnavailableException.class);
            }
            assertThat(runtime.validations()).isZero();
        }

        @Test
        void aDataSourceThatCannotAnswerIs503BeforeAnyRun() {
            provider = source(() -> {
                throw new IllegalStateException("upstream down");
            });
            assertThatThrownBy(() -> receiver().submit(request(), delivered(envelope("sourced", "1", "{\"colour\":\"red\"}"))))
                .isInstanceOf(ProgramUnavailableException.class)
                .satisfies(e -> {
                    // One of the three typed 503 codes the suite's REC-16 reads.
                    assertThat(((DatumException) e).code()).isEqualTo("server.unavailable");
                    assertThat(((DatumException) e).httpStatus()).isEqualTo(503);
                });
            assertThat(runtime.validations()).isZero();
        }

        @Test
        void theOptionSnapshotHoldsWhatTheSourceAllows() {
            provider = source(() -> List.of(new OptionItem("red", null, null, null, null)));
            receiver().submit(request(), delivered(envelope("sourced", "1", "{\"colour\":\"red\"}")));
            assertThat(runtime.contexts().get(0).path("optionSnapshot").path("colours").toString()).isEqualTo("[{\"value\":\"red\"}]");
        }
    }

    // ------------------------------------------------------------------------------------------ journeys

    // ------------------------------------------------------------------------------------------ a retried submit attempt

    @Nested
    class Redelivery {

        @Test
        void aFirstDeliveryIsNotHandledAndIsRemembered() {
            ReceiverAnswer first = receiver().submit(request(), delivered(contactEnvelope(), "attempt-1"));
            assertThat(first.body().path("handled").booleanValue()).isFalse();
            assertThat(idempotency.find("contact", "1", "attempt-1")).isPresent().get()
                .satisfies(remembered -> {
                    assertThat(remembered.receipt().id()).isEqualTo("id-1");
                    assertThat(remembered.digest()).isEqualTo(first.body().path("digest").stringValue());
                });
        }

        @Test
        void theSameAttemptAgainIsAnsweredWithTheFirstReceiptAndRunsNoHandler() {
            SubmissionReceiver receiver = receiver();
            ReceiverAnswer first = receiver.submit(request(), delivered(contactEnvelope(), "attempt-1"));
            handlerDouble = submission -> new SubmissionReceipt("id-2", "CONTACT-2", null);
            validators.add(candidate -> {
                throw new AssertionError("the validators judged it the first time");
            });
            events.clear();
            calls.clear();

            ReceiverAnswer second = receiver.submit(request(), delivered(contactEnvelope(), "attempt-1"));

            assertThat(second.status()).isEqualTo(200);
            assertThat(second.body().path("handled").booleanValue()).isTrue();
            assertThat(second.body().path("id").stringValue()).isEqualTo("id-1");
            assertThat(second.body().path("reference").stringValue()).isEqualTo("CONTACT-1");
            assertThat(second.body().path("digest").stringValue()).isEqualTo(first.body().path("digest").stringValue());
            assertThat(second.body().path("receipt").path("title").stringValue()).isEqualTo("Thanks");
            assertThat(calls).doesNotContain("handler", "event:SubmissionValidatedEvent");
            assertThat(handled).hasSize(1);
            assertThat(eventsOf(SubmissionValidatedEvent.class)).isEmpty();
            assertThat(eventsOf(com.argusvane.datum.submissions.events.SubmissionRedeliveredEvent.class)).singleElement()
                .satisfies(event -> {
                    assertThat(event.formKey()).isEqualTo("contact");
                    assertThat(event.digest()).isEqualTo(first.body().path("digest").stringValue());
                    assertThat(event.receipt().id()).isEqualTo("id-1");
                });
        }

        @Test
        void aRedeliveryRunsNoSecondSignatureCheckRecordUseOrValidator() {
            // The lookup sits above the signature and validator stages: a repeated signed document must not be
            // refused as a replay, nor spend a second use or run the server validators again.
            List<String> stages = new ArrayList<>();
            signatureCheck = new SubmissionSignatureCheck() {
                @Override
                public SignatureVerdict check(CandidateSubmission submission) {
                    stages.add("check");
                    return new SignatureVerdict(SignatureVerdict.Status.VALID, List.of(), Map.of());
                }

                @Override
                public void recordUse(AcceptedSubmission submission) {
                    stages.add("recordUse");
                }
            };
            validators.add(candidate -> {
                stages.add("validate");
                return ValidatorResult.OK;
            });
            SubmissionReceiver receiver = receiver();
            receiver.submit(request(), delivered(contactEnvelope(), "attempt-1"));
            assertThat(stages).containsExactly("check", "validate", "recordUse");
            stages.clear();

            ReceiverAnswer second = receiver.submit(request(), delivered(contactEnvelope(), "attempt-1"));

            assertThat(second.body().path("handled").booleanValue()).isTrue();
            assertThat(stages).isEmpty();
        }

        @Test
        void anotherAttemptIsAFirstDeliveryAgainEvenWithTheSameAnswers() {
            SubmissionReceiver receiver = receiver();
            receiver.submit(request(), delivered(contactEnvelope()));
            ReceiverAnswer same = receiver.submit(request(), delivered(contactEnvelope()));
            assertThat(same.body().path("handled").booleanValue()).isFalse();
            assertThat(handled).hasSize(2);
            handled.remove(1);
            ReceiverAnswer other = receiver.submit(request(), delivered(envelope("contact", "1", "{\"name\":\"Grace\"}")));
            assertThat(other.body().path("handled").booleanValue()).isFalse();
            assertThat(handled).hasSize(2);
        }

        @Test
        void aRejectedDocumentIsNeverRememberedAndLearnsNothingOfEarlierOnes() {
            SubmissionReceiver receiver = receiver();
            runtime.outcome = context -> {
                ObjectNode outcome = TestRuntime.accepting(context);
                outcome.putArray("errors").addObject().put("componentId", "name").put("code", "required");
                return outcome;
            };
            assertThatThrownBy(() -> receiver.submit(request(), delivered(contactEnvelope()))).isInstanceOf(SubmissionRejectedException.class);
            assertThat(((com.argusvane.datum.submissions.idempotency.InMemorySubmissionIdempotencyStore) idempotency).size()).isZero();
        }

        @Test
        void aHandlerThatFailsRemembersNothingSoTheRetryIsHandled() {
            SubmissionReceiver receiver = receiver();
            handlerDouble = submission -> {
                throw new IllegalStateException("database down");
            };
            assertThatThrownBy(() -> receiver.submit(request(), delivered(contactEnvelope(), "attempt-1"))).isInstanceOf(IllegalStateException.class);
            handlerDouble = null;
            ReceiverAnswer retry = receiver.submit(request(), delivered(contactEnvelope(), "attempt-1"));
            assertThat(retry.body().path("handled").booleanValue()).isFalse();
            assertThat(handled).hasSize(1);
        }

        @Test
        void aDryRunAndACheckNeitherReadNorWriteTheStore() {
            SubmissionReceiver receiver = receiver();
            receiver.test(request(), wrapped(contactEnvelope()));
            assertThat(((com.argusvane.datum.submissions.idempotency.InMemorySubmissionIdempotencyStore) idempotency).size()).isZero();
            receiver.submit(request(), delivered(contactEnvelope()));
            ReceiverAnswer dry = receiver.test(request(), wrapped(contactEnvelope()));
            assertThat(dry.body().path("outcome").stringValue()).isEqualTo("accepted");
            assertThat(dry.body().has("handled")).isFalse();
        }

        @Test
        void aStoreThatCannotAnswerRefusesTheDeliveryWith503AndOneThatCannotRememberStillAnswers() {
            idempotency = new com.argusvane.datum.submissions.spi.SubmissionIdempotencyStore() {
                @Override
                public java.util.Optional<Remembered> find(String formKey, String version, String submissionKey) {
                    throw new IllegalStateException("db down");
                }

                @Override
                public void remember(String formKey, String version, String submissionKey, String digest, SubmissionReceipt receipt) {
                }
            };
            assertThatThrownBy(() -> receiver().submit(request(), delivered(contactEnvelope())))
                .isInstanceOf(ValidatorUnavailableException.class);
            assertThat(handled).isEmpty();

            idempotency = new com.argusvane.datum.submissions.spi.SubmissionIdempotencyStore() {
                @Override
                public java.util.Optional<Remembered> find(String formKey, String version, String submissionKey) {
                    return java.util.Optional.empty();
                }

                @Override
                public void remember(String formKey, String version, String submissionKey, String digest, SubmissionReceipt receipt) {
                    throw new IllegalStateException("db down");
                }
            };
            ReceiverAnswer answer = receiver().submit(request(), delivered(contactEnvelope()));
            assertThat(answer.body().path("id").stringValue()).isEqualTo("id-1");
            assertThat(handled).hasSize(1);
        }
    }

    @Nested
    class Journeys {

        @Test
        void anUnknownJourneyIs422BeforeAnyRun() {
            for (String raw : List.of("\"no-such\"", "\"__proto__\"", "7", "{\"id\":7}")) {
                ObjectNode document = envelope("trip", "2", "{\"name\":\"Ada\"}");
                ((ObjectNode) document.get("submission")).set("journey", json("{\"j\":" + raw + "}").get("j"));
                assertThatThrownBy(() -> receiver().submit(request(), delivered(document)))
                    .as(raw)
                    .isInstanceOf(SubmissionRejectedException.class)
                    .satisfies(e -> {
                        assertThat(((SubmissionRejectedException) e).stage()).isEqualTo("journey");
                        assertThat(((SubmissionRejectedException) e).errorItems().get(0).code()).isEqualTo("journey.unknown");
                    });
            }
            assertThat(runtime.validations()).isZero();
        }

        @Test
        void aDeliveryThatNamesNoJourneyIsJudgedByTheOnlyOne() {
            receiver().submit(request(), delivered(envelope("trip", "2", "{\"name\":\"Ada\"}")));
            assertThat(runtime.contexts().get(0).path("journey").path("id").stringValue()).isEqualTo("main");
            assertThat(handled.get(0).journeyId()).isEqualTo("main");
        }

        @Test
        void aFormWithSeveralJourneysAndNoDefaultRequiresOne() {
            assertThatThrownBy(() -> receiver().submit(request(), delivered(envelope("pick", "3", "{}"))))
                .isInstanceOf(SubmissionRejectedException.class)
                .satisfies(e -> assertThat(((SubmissionRejectedException) e).errorItems().get(0).code()).isEqualTo("journey.required"));
            // A null id names none: the same rule.
            ObjectNode nullId = envelope("pick", "3", "{}");
            ((ObjectNode) nullId.get("submission")).set("journey", json("{\"id\":null}"));
            assertThatThrownBy(() -> receiver().submit(request(), delivered(nullId))).isInstanceOf(SubmissionRejectedException.class);
            assertThat(runtime.validations()).isZero();
        }
    }

    // ------------------------------------------------------------------------------------------ checks

    @Nested
    class Checks {

        private ObjectNode tripEnvelope(String values) {
            ObjectNode document = envelope("trip", "2", values);
            ((ObjectNode) document.get("submission")).set("journey", json("{\"id\":\"main\"}"));
            return document;
        }

        @Test
        void aPageCheckAnswersTheSuitesShapeWithThePagesErrorsOnly() {
            runtime.outcome = context -> json("{\"errors\":[{\"componentId\":\"name\",\"code\":\"required\"},"
                + "{\"componentId\":\"city\",\"code\":\"required\"},{\"code\":\"journey.exit\"},{\"code\":\"form.level\"}],"
                + "\"pageComponentIds\":[\"name\"]}");
            ReceiverAnswer answer = receiver().validate(request(), check(tripEnvelope("{}"), "page", "p1"));
            assertThat(answer.status()).isEqualTo(200);
            assertThat(answer.body().toString()).isEqualTo("{\"accepted\":false,\"errors\":[{\"field\":\"name\",\"code\":\"required\"},"
                + "{\"code\":\"form.level\"}]}");
            ObjectNode context = runtime.contexts().get(0);
            assertThat(context.path("page").stringValue()).isEqualTo("p1");
            assertThat(context.path("reportFold").booleanValue()).isTrue();
            assertThat(context.has("document")).isFalse();
            assertThat(handled).isEmpty();
            assertThat(eventsOf(JourneyCheckedEvent.class)).singleElement()
                .isEqualTo(new JourneyCheckedEvent("trip", "main", "p1", false, "http"));
            assertThat(eventsOf(SubmissionRejectedEvent.class)).isEmpty();
        }

        @Test
        void theValidatorsJudgeTheSubmittableValuesOfARunThatBlockedElsewhere() {
            runtime.outcome = context -> json("{\"errors\":[{\"componentId\":\"city\",\"code\":\"required\"}],"
                + "\"pageComponentIds\":[\"name\"],\"submittable\":{\"name\":\"Ada\"}}");
            List<CandidateSubmission> seen = new ArrayList<>();
            validators.add(candidate -> {
                seen.add(candidate);
                return ValidatorResult.warnings(SubmissionError.warning("name", "server.hint", null));
            });
            ReceiverAnswer answer = receiver().validate(request(), check(tripEnvelope("{\"name\":\"Ada\",\"raw\":1}"), "page", "p1"));
            assertThat(answer.body().toString()).isEqualTo("{\"accepted\":true,\"errors\":[],"
                + "\"notes\":[{\"field\":\"name\",\"code\":\"server.hint\",\"severity\":\"warning\"}]}");
            CandidateSubmission candidate = seen.get(0);
            assertThat(candidate.values().toString()).isEqualTo("{\"name\":\"Ada\"}");
            assertThat(candidate.scope().kind()).isEqualTo("page");
            assertThat(candidate.scope().pageId()).isEqualTo("p1");
            assertThat(candidate.scope().componentIds()).containsExactly("name");
            assertThat(candidate.envelope().path("submission").path("journey").path("id").stringValue()).isEqualTo("main");
            assertThat(candidate.document()).isNull();
        }

        @Test
        void aCheckWithNoValuesToJudgeSaysTheServerStageWasSkipped() {
            runtime.outcome = context -> json("{\"errors\":[]}");
            ReceiverAnswer answer = receiver().validate(request(), check(tripEnvelope("{}"), "journey", null));
            assertThat(answer.body().toString()).isEqualTo("{\"accepted\":true,\"errors\":[],\"notes\":[{\"code\":\"server.skipped\",\"severity\":\"info\"}]}");
        }

        @Test
        void anUnknownOrMissingJourneyIsAnsweredInTheVerdict() {
            ObjectNode unknown = envelope("trip", "2", "{}");
            ((ObjectNode) unknown.get("submission")).set("journey", json("{\"id\":\"no-such\"}"));
            assertThat(receiver().validate(request(), check(unknown, "journey", null)).body().toString())
                .isEqualTo("{\"accepted\":false,\"errors\":[{\"code\":\"journey.unknown\"}]}");
            assertThat(receiver().validate(request(), check(envelope("pick", "3", "{}"), "journey", null)).body().toString())
                .isEqualTo("{\"accepted\":false,\"errors\":[{\"code\":\"journey.required\"}]}");
            assertThat(runtime.validations()).isZero();
        }

        @Test
        void aMalformedCheckIsABadDocument() {
            assertThatThrownBy(() -> receiver().validate(request(), check(tripEnvelope("{}"), "everything", null)))
                .isInstanceOf(BadRequestException.class);
            assertThatThrownBy(() -> receiver().validate(request(), check(tripEnvelope("{}"), "page", null)))
                .isInstanceOf(BadRequestException.class);
            assertThatThrownBy(() -> receiver().validate(request(), check(tripEnvelope("{}"), "page", "no-such-page")))
                .isInstanceOf(BadRequestException.class);
            // The scope is required, not defaulted.
            ObjectNode noScope = json("{}");
            noScope.set("document", tripEnvelope("{}"));
            assertThatThrownBy(() -> receiver().validate(request(), Fixtures.bytes(noScope))).isInstanceOf(BadRequestException.class);
            assertThatThrownBy(() -> receiver().validate(request(), Fixtures.bytes(tripEnvelope("{}"))))
                .isInstanceOf(BadRequestException.class);
            ObjectNode numbered = envelope("trip", "2", "{}");
            ((ObjectNode) numbered.get("submission")).set("journey", json("{\"id\":7}"));
            assertThatThrownBy(() -> receiver().validate(request(), check(numbered, "journey", null)))
                .isInstanceOf(BadRequestException.class);
            assertThat(runtime.validations()).isZero();
        }

        @Test
        void aPageIdBesideAJourneyScopeIsRefusedNotIgnored() {
            assertThatThrownBy(() -> receiver().validate(request(), check(tripEnvelope("{}"), "journey", "p1")))
                .isInstanceOf(BadRequestException.class);
            assertThat(runtime.validations()).isZero();
            // A page check still needs its page.
            runtime.outcome = context -> json("{\"errors\":[],\"pageComponentIds\":[\"name\"]}");
            assertThat(receiver().validate(request(), check(tripEnvelope("{}"), "page", "p1")).status()).isEqualTo(200);
        }

        @Test
        void warningsRideInNotesAndOnlyBlockingFindingsAreErrors() {
            runtime.outcome = context -> json("{\"errors\":[{\"componentId\":\"name\",\"code\":\"required\",\"message\":\"Say it.\"},"
                + "{\"componentId\":\"city\",\"code\":\"hint\",\"severity\":\"warning\"},{\"code\":\"form.note\",\"severity\":\"info\"}]}");
            ReceiverAnswer answer = receiver().validate(request(), check(tripEnvelope("{}"), "journey", null));
            assertThat(answer.status()).isEqualTo(200);
            assertThat(answer.body().toString()).isEqualTo("{\"accepted\":false,"
                + "\"errors\":[{\"field\":\"name\",\"code\":\"required\",\"message\":\"Say it.\"}],"
                + "\"notes\":[{\"field\":\"city\",\"code\":\"hint\",\"severity\":\"warning\"},{\"code\":\"form.note\",\"severity\":\"info\"}]}");
        }

        @Test
        void anAcceptedCheckWithNothingToSayHasNoNotesMember() {
            runtime.outcome = context -> json("{\"errors\":[],\"values\":{\"name\":\"Ada\"}}");
            assertThat(receiver().validate(request(), check(tripEnvelope("{\"name\":\"Ada\"}"), "journey", null)).body().toString())
                .isEqualTo("{\"accepted\":true,\"errors\":[]}");
        }

        /**
         * A run that failed is no verdict: the check answers it as a delivery does, with the run's own code, and both are
         * 503 (the server's failure), never a 422 that would read as a judgement of the answers.
         */
        @Test
        void aRunThatFailedIsRefusedAsADeliveryIsAndNeverAnsweredAsAVerdict() {
            runtime.terminate = com.argusvane.datum.sandbox.wasi.Termination.TRAP;
            for (byte[] body : List.of(check(tripEnvelope("{}"), "journey", null), check(tripEnvelope("{}"), "page", "p1"))) {
                assertThatThrownBy(() -> receiver().validate(request(), body)).isInstanceOf(DatumException.class)
                    .satisfies(e -> {
                        assertThat(((DatumException) e).code()).isEqualTo("wasm.execution_error");
                        assertThat(((DatumException) e).httpStatus()).isEqualTo(503);
                    });
            }
            assertThatThrownBy(() -> receiver().submit(request(), delivered(tripEnvelope("{}")))).isInstanceOf(DatumException.class)
                .satisfies(e -> {
                    assertThat(((DatumException) e).code()).isEqualTo("wasm.execution_error");
                    assertThat(((DatumException) e).httpStatus()).isEqualTo(503);
                });
            assertThat(eventsOf(JourneyCheckedEvent.class)).isEmpty();
        }

        @Test
        void aCancelledRunIs503AsOnADelivery() {
            runtime.terminate = com.argusvane.datum.sandbox.wasi.Termination.INTERRUPTED;
            assertThatThrownBy(() -> receiver().validate(request(), check(tripEnvelope("{}"), "journey", null)))
                .isInstanceOf(DatumException.class)
                .satisfies(e -> {
                    assertThat(((DatumException) e).code()).isEqualTo("server.unavailable");
                    assertThat(((DatumException) e).httpStatus()).isEqualTo(503);
                });
        }

        /** The registered form is the one too deep (the document's own depth is a 400 before any run): the server's 503. */
        @Test
        void aRegisteredFormThatNestsTooDeepIsRefusedNotAnsweredAsAFinding() {
            failingSandbox = (com.argusvane.datum.sandbox.protocol.Sandbox) java.lang.reflect.Proxy.newProxyInstance(
                getClass().getClassLoader(), new Class<?>[] {com.argusvane.datum.sandbox.protocol.Sandbox.class},
                (proxy, method, args) -> {
                    if (method.getName().equals("validate")) {
                        throw new com.argusvane.datum.core.DefinitionTooDeepException(32, "The definition nests too deep.");
                    }
                    return method.invoke(service, args);
                });
            assertThatThrownBy(() -> receiver().validate(request(), check(tripEnvelope("{}"), "journey", null)))
                .isInstanceOf(com.argusvane.datum.core.DefinitionTooDeepException.class)
                .satisfies(e -> {
                    assertThat(((DatumException) e).code()).isEqualTo("definition.tooDeep");
                    assertThat(((DatumException) e).httpStatus()).isEqualTo(503);
                });
            // The submitted document nesting too deep is the caller's: a 400 before the service.
            ObjectNode deep = tripEnvelope("{}");
            ObjectNode cursor = deep;
            for (int i = 0; i < SubmissionReceiver.DOCUMENT_DEPTH + 2; i++) {
                cursor = cursor.putObject("n");
            }
            assertThatThrownBy(() -> receiver().validate(request(), check(deep, "journey", null))).isInstanceOf(BadRequestException.class);
        }

        @Test
        void aPageCheckWhoseRunNamedNoComponentsFailsClosed() {
            runtime.outcome = context -> json("{\"errors\":[]}");
            assertThatThrownBy(() -> receiver().validate(request(), check(tripEnvelope("{}"), "page", "p1")))
                .isInstanceOf(ValidatorUnavailableException.class);
        }
    }

    // ------------------------------------------------------------------------------------------ dry runs

    @Nested
    class DryRuns {

        @Test
        void aDryRunCallsNoHandlerPublishesNoEventAndReportsTheVerdict() {
            List<CandidateSubmission> seen = new ArrayList<>();
            validators.add(candidate -> {
                seen.add(candidate);
                return ValidatorResult.OK;
            });
            ObjectNode body = json("{\"logLevel\":\"debug\"}");
            body.set("document", contactEnvelope());
            ReceiverAnswer answer = receiver().test(request(), Fixtures.bytes(body));
            assertThat(answer.status()).isEqualTo(200);
            assertThat(answer.body().path("outcome").stringValue()).isEqualTo("accepted");
            assertThat(answer.body().path("digest").stringValue()).isEqualTo(CanonicalJson.digest(contactEnvelope()));
            assertThat(answer.body().path("sandbox").path("logLevel").stringValue()).isEqualTo("debug");
            assertThat(handled).isEmpty();
            assertThat(events).isEmpty();
            assertThat(seen.get(0).scope().test()).isTrue();
            assertThat(seen.get(0).mode()).isEqualTo(SubmissionMode.TEST);
        }

        @Test
        void aRejectedDryRunIsAReportNotA422() {
            runtime.outcome = context -> TestRuntime.described(json("{\"errors\":[{\"componentId\":\"name\",\"code\":\"required\"}]}"), context);
            ReceiverAnswer answer = receiver().test(request(), wrapped(contactEnvelope()));
            assertThat(answer.body().path("outcome").stringValue()).isEqualTo("rejected");
            assertThat(answer.body().path("stage").stringValue()).isEqualTo("sandbox");
            assertThat(answer.body().path("errors").get(0).path("severity").stringValue()).isEqualTo("error");
            assertThat(events).isEmpty();
        }

        @Test
        void aDryRunJudgesTheSignatureButRecordsNoUse() {
            List<String> signatureCalls = new ArrayList<>();
            signatureCheck = new SubmissionSignatureCheck() {
                @Override
                public SignatureVerdict check(CandidateSubmission submission) {
                    signatureCalls.add("check");
                    return new SignatureVerdict(SignatureVerdict.Status.VALID, List.of(), Map.of());
                }

                @Override
                public void recordUse(AcceptedSubmission submission) {
                    signatureCalls.add("recordUse");
                }
            };
            ReceiverAnswer answer = receiver().test(request(), wrapped(contactEnvelope()));
            assertThat(answer.body().path("signature").path("status").stringValue()).isEqualTo("valid");
            assertThat(signatureCalls).containsExactly("check");
        }
    }

    @Nested
    class PdfRequests {

        @Test
        void aPdfRequestIsJudgedLikeADryRun() {
            List<CandidateSubmission> seen = new ArrayList<>();
            validators.add(candidate -> {
                seen.add(candidate);
                return ValidatorResult.OK;
            });
            ReceiverAnswer answer = receiver().receive(request(), wrapped(contactEnvelope()), SubmissionMode.PDF);
            assertThat(answer.body().path("outcome").stringValue()).isEqualTo("accepted");
            assertThat(answer.body().path("values").isObject()).isTrue();
            assertThat(handled).isEmpty();
            assertThat(events).isEmpty();
            assertThat(seen.get(0).mode()).isEqualTo(SubmissionMode.PDF);
            assertThat(seen.get(0).scope().test()).isTrue();
        }

        @Test
        void aPdfRequestIsNotCountedByTheReceiver() {
            receiver().receive(request(), wrapped(contactEnvelope()), SubmissionMode.PDF);
            // The PDF facade counted the request under kind pdf; the receiver adds no second count.
            assertThat(throttle.checked).isEmpty();
            assertThat(throttle.recorded).isEmpty();
        }

        @Test
        void aPdfRequestNeverRecordsASignatureUse() {
            List<String> signatureCalls = new ArrayList<>();
            signatureCheck = new SubmissionSignatureCheck() {
                @Override
                public SignatureVerdict check(CandidateSubmission submission) {
                    signatureCalls.add("check");
                    return new SignatureVerdict(SignatureVerdict.Status.VALID, List.of(), Map.of());
                }

                @Override
                public void recordUse(AcceptedSubmission submission) {
                    signatureCalls.add("recordUse");
                }
            };
            receiver().receive(request(), wrapped(contactEnvelope()), SubmissionMode.PDF);
            assertThat(signatureCalls).containsExactly("check");
        }

        @Test
        void aRejectedPdfRequestIsAReportAndPublishesNothing() {
            runtime.outcome = context -> TestRuntime.described(json("{\"errors\":[{\"componentId\":\"name\",\"code\":\"required\"}]}"), context);
            ReceiverAnswer answer = receiver().receive(request(), wrapped(contactEnvelope()), SubmissionMode.PDF);
            assertThat(answer.body().path("outcome").stringValue()).isEqualTo("rejected");
            assertThat(events).isEmpty();
            assertThat(ThrottleKey.kindOf(SubmissionMode.PDF)).isEqualTo(ThrottleKey.Kind.PDF);
        }
    }

    // ------------------------------------------------------------------------------------------ signatures

    @Nested
    class Signatures {

        @Test
        void aRefusingVerdictIs422AtTheSignatureStageBeforeTheValidators() {
            signatureCheck = submission -> new SignatureVerdict(SignatureVerdict.Status.ABSENT,
                List.of(SubmissionError.error(null, "signature.required", "Sign it.")), Map.of());
            validators.add(candidate -> {
                throw new AssertionError("validators run after the signature");
            });
            assertThatThrownBy(() -> receiver().submit(request(), delivered(contactEnvelope())))
                .isInstanceOf(SubmissionRejectedException.class)
                .satisfies(e -> {
                    SubmissionRejectedException rejected = (SubmissionRejectedException) e;
                    assertThat(rejected.stage()).isEqualTo("signature");
                    assertThat(rejected.errorItems().get(0).code()).isEqualTo("signature.required");
                });
            assertThat(handled).isEmpty();
        }

        @Test
        void anInvalidVerdictWithoutErrorsStillRefuses() {
            // Fail closed: a checker that found the signature invalid but gave no reason does not let it through.
            signatureCheck = submission -> new SignatureVerdict(SignatureVerdict.Status.INVALID, List.of(), Map.of("check", "signature"));
            assertThatThrownBy(() -> receiver().submit(request(), delivered(contactEnvelope())))
                .isInstanceOf(SubmissionRejectedException.class)
                .satisfies(e -> {
                    SubmissionRejectedException rejected = (SubmissionRejectedException) e;
                    assertThat(rejected.httpStatus()).isEqualTo(422);
                    assertThat(rejected.stage()).isEqualTo("signature");
                    assertThat(rejected.errorItems()).singleElement().satisfies(item -> assertThat(item.code()).isEqualTo("signature.invalid"));
                });
            assertThat(handled).isEmpty();
            ReceiverAnswer report = receiver().test(request(), wrapped(contactEnvelope()));
            assertThat(report.body().path("outcome").stringValue()).isEqualTo("rejected");
            assertThat(report.body().path("stage").stringValue()).isEqualTo("signature");
            assertThat(report.body().path("errors").get(0).path("code").stringValue()).isEqualTo("signature.invalid");
        }

        /** The check's {@code recordUse} and {@code stored} steps, and its {@code releaseUse}, as calls in order. */
        private SubmissionSignatureCheck steps(RuntimeException storedFails, Error storedErrs) {
            return new SubmissionSignatureCheck() {
                @Override
                public SignatureVerdict check(CandidateSubmission submission) {
                    return new SignatureVerdict(SignatureVerdict.Status.VALID, List.of(), Map.of());
                }

                @Override
                public void recordUse(AcceptedSubmission submission) {
                    calls.add("recordUse");
                }

                @Override
                public void stored(AcceptedSubmission submission, SubmissionReceipt receipt) {
                    calls.add("stored:" + receipt.id() + ":" + submission.digest());
                    if (storedFails != null) {
                        throw storedFails;
                    }
                    if (storedErrs != null) {
                        throw storedErrs;
                    }
                }

                @Override
                public void releaseUse(AcceptedSubmission submission) {
                    calls.add("releaseUse");
                }
            };
        }

        /**
         * The check hears that the document was stored, with the handler's receipt, after the
         * handler and before the validated event, so a "valid" signature event names a stored document only.
         */
        @Test
        void theStoredStepRunsAfterTheHandlerWithItsReceipt() {
            signatureCheck = steps(null, null);
            String digest = CanonicalJson.digest(contactEnvelope());
            ReceiverAnswer answer = receiver().submit(request(), delivered(contactEnvelope()));
            assertThat(answer.status()).isEqualTo(200);
            assertThat(calls).containsSubsequence("recordUse", "handler", "stored:id-1:" + digest, "event:SubmissionValidatedEvent");
            assertThat(calls).doesNotContain("releaseUse");
        }

        @Test
        void aHandlerThatFailsNeverReachesTheStoredStep() {
            signatureCheck = steps(null, null);
            handlerDouble = submission -> {
                throw new IllegalStateException("database down");
            };
            assertThatThrownBy(() -> receiver().submit(request(), delivered(contactEnvelope()))).hasMessage("database down");
            handlerDouble = submission -> null;
            assertThatThrownBy(() -> receiver().submit(request(), delivered(contactEnvelope()))).hasMessageContaining("no receipt");
            assertThat(calls).filteredOn(call -> call.startsWith("stored")).isEmpty();
            assertThat(calls).containsSubsequence("recordUse", "handler", "releaseUse", "recordUse", "handler", "releaseUse");
        }

        /** The document is stored by then: a stored step that fails is logged, the answer and the validated event stand, and nothing is released. */
        @Test
        void aStoredStepThatFailsIsLoggedAndTheAnswerStands() {
            for (SubmissionSignatureCheck failing : List.of(steps(new IllegalStateException("audit down"), null),
                steps(null, new AssertionError("an invariant")))) {
                calls.clear();
                events.clear();
                // A fresh store, or the second document would be answered as a redelivery with no handler.
                idempotency = new com.argusvane.datum.submissions.idempotency.InMemorySubmissionIdempotencyStore(100);
                signatureCheck = failing;
                ReceiverAnswer answer = receiver().submit(request(), delivered(contactEnvelope()));
                assertThat(answer.status()).isEqualTo(200);
                assertThat(answer.body().path("id").stringValue()).isEqualTo("id-1");
                assertThat(eventsOf(SubmissionValidatedEvent.class)).hasSize(1);
                assertThat(calls).doesNotContain("releaseUse");
            }
        }

        @Test
        void aRefusedUseNeverReachesTheStoredStep() {
            signatureCheck = new SubmissionSignatureCheck() {
                @Override
                public SignatureVerdict check(CandidateSubmission submission) {
                    return new SignatureVerdict(SignatureVerdict.Status.VALID, List.of(), Map.of());
                }

                @Override
                public void recordUse(AcceptedSubmission submission) {
                    throw new DatumException("signature.invalid", 422, "Already received.");
                }

                @Override
                public void stored(AcceptedSubmission submission, SubmissionReceipt receipt) {
                    calls.add("stored");
                }
            };
            assertThatThrownBy(() -> receiver().submit(request(), delivered(contactEnvelope()))).isInstanceOf(DatumException.class);
            assertThat(calls).doesNotContain("stored", "handler");
        }

        @Test
        void aDryRunNeverReachesTheStoredStep() {
            signatureCheck = steps(null, null);
            receiver().test(request(), wrapped(contactEnvelope()));
            assertThat(calls).filteredOn(call -> call.startsWith("stored") || call.equals("recordUse")).isEmpty();
        }

        @Test
        void aHandlerThatFailsAfterTheUseWasRecordedReleasesIt() {
            List<String> signatureCalls = new ArrayList<>();
            signatureCheck = new SubmissionSignatureCheck() {
                @Override
                public SignatureVerdict check(CandidateSubmission submission) {
                    return new SignatureVerdict(SignatureVerdict.Status.VALID, List.of(), Map.of());
                }

                @Override
                public void recordUse(AcceptedSubmission submission) {
                    signatureCalls.add("recordUse:" + submission.digest());
                }

                @Override
                public void releaseUse(AcceptedSubmission submission) {
                    signatureCalls.add("releaseUse:" + submission.digest());
                    throw new IllegalStateException("release failed too");
                }
            };
            handlerDouble = submission -> {
                throw new IllegalStateException("database down");
            };
            String digest = CanonicalJson.digest(contactEnvelope());
            assertThatThrownBy(() -> receiver().submit(request(), delivered(contactEnvelope())))
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("database down")
                .satisfies(e -> assertThat(e.getSuppressed()).singleElement().satisfies(s -> assertThat(s).hasMessage("release failed too")));
            assertThat(signatureCalls).containsExactly("recordUse:" + digest, "releaseUse:" + digest);
            assertThat(eventsOf(SubmissionValidatedEvent.class)).isEmpty();
        }

        @Test
        void aHandlerThatFailsWithAnErrorReleasesTheUseToo() {
            List<String> signatureCalls = new ArrayList<>();
            signatureCheck = new SubmissionSignatureCheck() {
                @Override
                public SignatureVerdict check(CandidateSubmission submission) {
                    return new SignatureVerdict(SignatureVerdict.Status.VALID, List.of(), Map.of());
                }

                @Override
                public void recordUse(AcceptedSubmission submission) {
                    signatureCalls.add("recordUse");
                }

                @Override
                public void releaseUse(AcceptedSubmission submission) {
                    signatureCalls.add("releaseUse");
                }
            };
            handlerDouble = submission -> {
                throw new NoClassDefFoundError("missing");
            };
            assertThatThrownBy(() -> receiver().submit(request(), delivered(contactEnvelope())))
                .isInstanceOf(NoClassDefFoundError.class);
            assertThat(signatureCalls).containsExactly("recordUse", "releaseUse");
        }

        @Test
        void aRefusedUseIsNeitherHandledNorReleased() {
            List<String> signatureCalls = new ArrayList<>();
            signatureCheck = new SubmissionSignatureCheck() {
                @Override
                public SignatureVerdict check(CandidateSubmission submission) {
                    return new SignatureVerdict(SignatureVerdict.Status.VALID, List.of(), Map.of());
                }

                @Override
                public void recordUse(AcceptedSubmission submission) {
                    signatureCalls.add("recordUse");
                    throw new DatumException("signature.invalid", 422, "Already received.");
                }

                @Override
                public void releaseUse(AcceptedSubmission submission) {
                    signatureCalls.add("releaseUse");
                }
            };
            assertThatThrownBy(() -> receiver().submit(request(), delivered(contactEnvelope()))).isInstanceOf(DatumException.class);
            assertThat(signatureCalls).containsExactly("recordUse");
            assertThat(calls).doesNotContain("handler");
        }

        @Test
        void aSignatureCheckThatThrowsAnErrorIsNotCaught() {
            signatureCheck = submission -> {
                throw new NoClassDefFoundError("webauthn4j");
            };
            assertThatThrownBy(() -> receiver().submit(request(), delivered(contactEnvelope()))).isInstanceOf(NoClassDefFoundError.class);
            assertThat(handled).isEmpty();
        }

        @Test
        void anAcceptedVerdictIsKeptAndItsUseRecordedJustBeforeTheHandler() {
            signatureCheck = new SubmissionSignatureCheck() {
                @Override
                public SignatureVerdict check(CandidateSubmission submission) {
                    calls.add("signature.check");
                    assertThat(submission.document()).isNotNull();
                    return new SignatureVerdict(SignatureVerdict.Status.VALID, List.of(), Map.of("credentialId", "c1"));
                }

                @Override
                public void recordUse(AcceptedSubmission submission) {
                    calls.add("signature.recordUse");
                }
            };
            validators.add(candidate -> {
                calls.add("validator");
                return ValidatorResult.OK;
            });
            receiver().submit(request(), delivered(contactEnvelope()));
            assertThat(calls).containsExactly("sandbox", "signature.check", "validator", "signature.recordUse", "handler",
                "event:SubmissionValidatedEvent");
            assertThat(handled.get(0).signature().details()).containsEntry("credentialId", "c1");
        }
    }

    // ------------------------------------------------------------------------------------------ doubles

    /** A handler a test sets in place of the default one. */
    @FunctionalInterface
    interface SubmissionHandlerDouble {
        SubmissionReceipt handle(AcceptedSubmission submission);
    }

    /** A throttle that allows unless told to deny, recording checks and records, per form and per address. */
    static final class Throttle implements SubmissionThrottle {
        Duration deny;
        Duration denyAddress;
        final List<ThrottleKey> checked = new ArrayList<>();
        final List<ThrottleKey> recorded = new ArrayList<>();
        final List<String> addressesChecked = new ArrayList<>();
        final List<String> addressesRecorded = new ArrayList<>();

        @Override
        public ThrottleDecision checkAddress(String address) {
            addressesChecked.add(address);
            return denyAddress == null ? ThrottleDecision.ALLOW : new ThrottleDecision.Deny(denyAddress);
        }

        @Override
        public void recordAddress(String address) {
            addressesRecorded.add(address);
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

    private static Principal principal(String name) {
        return () -> name;
    }
}
