package com.argusvane.datum.submissions.service;

import static com.argusvane.datum.submissions.Fixtures.envelope;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.DatumException;
import com.argusvane.datum.sandbox.protocol.SandboxService;
import com.argusvane.datum.forms.DefinitionService;
import com.argusvane.datum.forms.datasource.DataSourceOptions;
import com.argusvane.datum.forms.snapshot.InMemoryDefinitionSnapshotStore;
import com.argusvane.datum.submissions.Fixtures;
import com.argusvane.datum.sandbox.runtime.TestRuntime;
import com.argusvane.datum.submissions.idempotency.InMemorySubmissionIdempotencyStore;
import com.argusvane.datum.submissions.receiver.SubmissionReceiver;
import com.argusvane.datum.submissions.service.SubmissionOutcome.Accepted;
import com.argusvane.datum.submissions.service.SubmissionOutcome.Checked;
import com.argusvane.datum.submissions.service.SubmissionOutcome.DryRun;
import com.argusvane.datum.submissions.service.SubmissionOutcome.Redelivered;
import com.argusvane.datum.submissions.service.SubmissionOutcome.Unavailable;
import com.argusvane.datum.submissions.spi.HostContextProvider;
import com.argusvane.datum.submissions.spi.HostContextRequest;
import com.argusvane.datum.submissions.spi.SandboxContextContributor;
import com.argusvane.datum.submissions.spi.SubmissionContext;
import com.argusvane.datum.submissions.spi.SubmissionMode;
import com.argusvane.datum.submissions.spi.SubmissionReceipt;
import com.argusvane.datum.submissions.spi.SubmissionRequest;
import com.argusvane.datum.web.json.DatumJsonMapper;
import java.security.Principal;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The server supplies the values {@code host.} reads, as {@code @argusvane/datum-submissions}'
 * {@code JudgeOptions.hostContext} does on {@code receive} and {@code validate} ({@code service-host-context.test.ts}): the
 * provider's context rides in every run of a delivery, a journey's check (page and journey scope) and a dry run; with
 * none the key is left out and the run is the lenient one; nothing of the request body or the document is
 * ever read for it; a retry of an accepted attempt keeps its first verdict without asking again; and a provider that
 * fails, or answers what JSON cannot carry inside the ABI's bounds, refuses the call as the host's fault (503
 * {@code server.unavailable}), never a more lenient verdict.
 */
class HostContextTest {

    private TestRuntime runtime;
    private SandboxService sandbox;
    private HostContextProvider provider;
    private List<HostContextRequest> asked;
    private List<SandboxContextContributor> contributors;

    @BeforeEach
    void setUp() {
        runtime = new TestRuntime();
        sandbox = runtime.service();
        provider = null;
        asked = new ArrayList<>();
        contributors = new ArrayList<>();
    }

    private SubmissionService service() {
        HostContextProvider recorded = provider == null ? null : request -> {
            asked.add(request);
            return provider.hostContext(request);
        };
        return SubmissionService.builder()
            .sandbox(() -> sandbox)
            .definitions(DefinitionService.builder().repository(new Fixtures.Repository(Fixtures.contact(), Fixtures.trip()))
                .snapshots(new InMemoryDefinitionSnapshotStore(100, message -> { })).sandbox(() -> sandbox).events(event -> { })
                .publicCacheSize(16).build())
            .dataSources(new DataSourceOptions(null, Duration.ofSeconds(2), null))
            .handler(submission -> new SubmissionReceipt("id-" + UUID.randomUUID(), "REF", null))
            .contributors(contributors)
            .hostContext(recorded)
            .idempotency(new InMemorySubmissionIdempotencyStore(100))
            .events(event -> { })
            .build();
    }

    private static SubmissionContext caller() {
        Principal ada = () -> "ada";
        return SubmissionContext.http("203.0.113.9", Map.of("X-Role", List.of("admin")), ada, null)
            .withSubmissionKey(UUID.randomUUID().toString());
    }

    private static ObjectNode tripDocument(String values) {
        ObjectNode document = envelope("trip", "2", values);
        ((ObjectNode) document.get("submission")).putObject("journey").put("id", "main");
        return document;
    }

    private JsonNode lastHostContext() {
        List<ObjectNode> contexts = runtime.contexts();
        return contexts.get(contexts.size() - 1).get("hostContext");
    }

    @Test
    void withNoProviderNoRunCarriesAContextAndAContributorCannotAddOne() {
        contributors.add((builder, submission) -> builder.context().putObject("hostContext").put("role", "admin"));
        SubmissionService service = service();
        assertThat(service.submit(FormRef.fromDocument(), envelope("contact", "1", "{\"name\":\"Ada\"}"), caller())).isInstanceOf(Accepted.class);
        assertThat(lastHostContext()).as("the host context is the provider's alone").isNull();
        assertThat(service.validate(FormRef.fromDocument(), tripDocument("{\"name\":\"Ada\"}"), caller())).isInstanceOf(Checked.class);
        assertThat(lastHostContext()).isNull();
    }

    @Test
    void theProvidersContextRidesInEveryRunAndItIsToldTheFormTheModeAndTheCaller() {
        provider = request -> Optional.of(Map.of("role", request.submission().header("X-Role"), "user", Map.of("name", request.submission().principalName())));
        SubmissionService service = service();

        assertThat(service.submit(FormRef.fromDocument(), envelope("contact", "1", "{\"name\":\"Ada\"}"), caller())).isInstanceOf(Accepted.class);
        assertThat(lastHostContext().path("role").asString()).isEqualTo("admin");
        assertThat(lastHostContext().path("user").path("name").asString()).isEqualTo("ada");
        assertThat(lastHostContext().size()).isEqualTo(2);
        assertThat(service.validate(FormRef.fromDocument(), tripDocument("{\"name\":\"Ada\"}"), JourneyCheck.journey(), caller()))
            .isInstanceOf(Checked.class);
        assertThat(lastHostContext().path("role").asString()).isEqualTo("admin");
        runtime.outcome = context -> {
            ObjectNode outcome = TestRuntime.accepting(context);
            outcome.putArray("pageComponentIds").add("name");
            return outcome;
        };
        assertThat(service.validate(FormRef.fromDocument(), tripDocument("{\"name\":\"Ada\"}"), JourneyCheck.page("p1"), caller()))
            .isInstanceOf(Checked.class);
        assertThat(lastHostContext().path("role").asString()).isEqualTo("admin");
        assertThat(service.test(FormRef.fromDocument(), envelope("contact", "1", "{\"name\":\"Ada\"}"), caller())).isInstanceOf(DryRun.class);
        assertThat(lastHostContext().path("role").asString()).isEqualTo("admin");

        assertThat(asked).extracting(HostContextRequest::mode)
            .containsExactly(SubmissionMode.SUBMIT, SubmissionMode.VALIDATE, SubmissionMode.VALIDATE, SubmissionMode.TEST);
        assertThat(asked.get(0).formKey()).isEqualTo("contact");
        assertThat(asked.get(0).formVersion()).isEqualTo("1");
        assertThat(asked.get(1).formKey()).isEqualTo("trip");
        assertThat(asked.get(1).formVersion()).isEqualTo("2");
        assertThat(asked.get(0).submission().principalName()).isEqualTo("ada");
    }

    @Test
    void emptyIsNoContextAndAnEmptyMapIsAContext() {
        provider = request -> Optional.empty();
        SubmissionService service = service();
        service.submit(FormRef.fromDocument(), envelope("contact", "1", "{\"name\":\"Ada\"}"), caller());
        assertThat(lastHostContext()).isNull();

        provider = request -> Optional.of(Map.of());
        service = service();
        service.submit(FormRef.fromDocument(), envelope("contact", "1", "{\"name\":\"Ada\"}"), caller());
        assertThat(lastHostContext().toString()).as("a context with no keys: every host. read is no answer").isEqualTo("{}");
    }

    /** HCX-04's lib half: what a client writes, in the body or in the document, never reaches hostContext. */
    @Test
    void nothingTheClientWritesIsReadForTheContext() {
        provider = request -> Optional.of(Map.of("role", "user"));
        SubmissionService service = service();
        SubmissionReceiver receiver = SubmissionReceiver.builder().service(service).json(DatumJsonMapper.create(1 << 20)).maxBodyBytes(1 << 20).build();
        ObjectNode document = envelope("contact", "1", "{\"name\":\"Ada\",\"hostContext\":{\"role\":\"admin\"},\"host\":{\"role\":\"admin\"}}");
        document.putObject("hostContext").put("role", "admin");
        ObjectNode body = Fixtures.json("{}");
        body.set("document", document);
        body.put("submissionKey", UUID.randomUUID().toString());
        body.putObject("hostContext").put("role", "admin");
        receiver.submit(SubmissionRequest.json(), Fixtures.bytes(body));
        assertThat(lastHostContext().toString()).isEqualTo("{\"role\":\"user\"}");

        provider = null;
        service = service();
        receiver = SubmissionReceiver.builder().service(service).json(DatumJsonMapper.create(1 << 20)).maxBodyBytes(1 << 20).build();
        body.put("submissionKey", UUID.randomUUID().toString());
        receiver.submit(SubmissionRequest.json(), Fixtures.bytes(body));
        assertThat(lastHostContext()).as("no provider: no context, whatever the body says").isNull();
    }

    /** A retry of an accepted attempt is answered with its first receipt before any run: the context is not asked again. */
    @Test
    void aRetryOfTheSameAttemptKeepsTheFirstVerdict() {
        Map<String, Object> role = new HashMap<>(Map.of("role", "user"));
        provider = request -> Optional.of(Map.copyOf(role));
        SubmissionService service = service();
        SubmissionContext attempt = caller();
        ObjectNode document = envelope("contact", "1", "{\"name\":\"Ada\"}");
        SubmissionOutcome first = service.submit(FormRef.fromDocument(), document, attempt);
        assertThat(first).isInstanceOf(Accepted.class);
        int runs = runtime.validations();

        role.put("role", "admin");
        SubmissionOutcome again = service.submit(FormRef.fromDocument(), document.deepCopy(), attempt);
        assertThat(again).isInstanceOf(Redelivered.class);
        assertThat(((Redelivered) again).receipt().id()).isEqualTo(((Accepted) first).receipt().id());
        assertThat(runtime.validations()).as("no second run").isEqualTo(runs);
        assertThat(asked).hasSize(1);
    }

    @Test
    void aProviderThatFailsIsTheHostsFaultNeverALenientVerdict() {
        List<HostContextProvider> broken = new ArrayList<>();
        broken.add(request -> {
            throw new IllegalStateException("the directory is down");
        });
        broken.add(request -> null);
        broken.add(request -> Optional.of(Map.of("score", Double.NaN)));
        broken.add(request -> Optional.of(Map.of("score", Double.POSITIVE_INFINITY)));
        broken.add(request -> Optional.of(Map.of("name", "\ud800")));
        broken.add(request -> Optional.of(nested(HostContexts.MAX_DEPTH)));
        // A value Jackson cannot write (its getter throws).
        broken.add(request -> Optional.of(Map.of("self", new Unwritable())));
        for (HostContextProvider each : broken) {
            provider = each;
            SubmissionService service = service();
            int runs = runtime.validations();
            for (SubmissionOutcome outcome : List.of(
                service.submit(FormRef.fromDocument(), envelope("contact", "1", "{\"name\":\"Ada\"}"), caller()),
                service.validate(FormRef.fromDocument(), tripDocument("{\"name\":\"Ada\"}"), caller()),
                service.test(FormRef.fromDocument(), envelope("contact", "1", "{\"name\":\"Ada\"}"), caller()))) {
                assertThat(outcome).isInstanceOf(Unavailable.class);
                assertThat(((Unavailable) outcome).code()).isEqualTo("server.unavailable");
            }
            assertThat(runtime.validations()).as("no run without the context the host meant").isEqualTo(runs);
        }

        // Over the route: 503 server.unavailable (not validator_unavailable: the application's own provider is the host's
        // dependency, like a data source, and the answer names no validator).
        provider = broken.get(0);
        SubmissionReceiver receiver = SubmissionReceiver.builder().service(service()).json(DatumJsonMapper.create(1 << 20)).maxBodyBytes(1 << 20).build();
        assertThatThrownBy(() -> receiver.submit(SubmissionRequest.json(), Fixtures.delivered(envelope("contact", "1", "{\"name\":\"Ada\"}"))))
            .isInstanceOfSatisfying(DatumException.class, e -> {
                assertThat(e.code()).isEqualTo("server.unavailable");
                assertThat(e.httpStatus()).isEqualTo(503);
            });

        // A DatumException the provider throws answers as itself.
        provider = request -> {
            throw new DatumException("access.denied", 403, "No.");
        };
        SubmissionService refusing = service();
        assertThatThrownBy(() -> refusing.submit(FormRef.fromDocument(), envelope("contact", "1", "{\"name\":\"Ada\"}"), caller()))
            .isInstanceOfSatisfying(DatumException.class, e -> assertThat(e.code()).isEqualTo("access.denied"));
    }

    @Test
    void theBoundsAreTheAbis() {
        // 63 nested maps under the root measure 64 levels: accepted; one more is refused.
        assertThat(HostContexts.checked(nested(HostContexts.MAX_DEPTH - 1), "f").isObject()).isTrue();
        assertThatThrownBy(() -> HostContexts.checked(nested(HostContexts.MAX_DEPTH), "f")).isInstanceOf(HostContexts.Failed.class)
            .hasMessageContaining("64 levels");
        Map<String, Object> wide = new LinkedHashMap<>();
        wide.put("list", java.util.Collections.nCopies(HostContexts.MAX_VALUES, 1));
        assertThatThrownBy(() -> HostContexts.checked(wide, "f")).isInstanceOf(HostContexts.Failed.class).hasMessageContaining("values");
        // A copy: what the provider keeps cannot change the run.
        Map<String, Object> kept = new HashMap<>(Map.of("role", "user"));
        ObjectNode written = HostContexts.checked(kept, "f");
        kept.put("role", "admin");
        assertThat(written.path("role").asString()).isEqualTo("user");
    }

    /** A bean whose one property cannot be read. */
    public static final class Unwritable {
        public String getRole() {
            throw new IllegalStateException("no role");
        }
    }

    /** Maps nested {@code levels} deep under the root map, {@code {"n": {"n": ... {"leaf": 1}}}}. */
    private static Map<String, Object> nested(int levels) {
        Map<String, Object> leaf = new LinkedHashMap<>();
        leaf.put("leaf", 1);
        Map<String, Object> current = leaf;
        for (int i = 0; i < levels - 1; i++) {
            Map<String, Object> outer = new LinkedHashMap<>();
            outer.put("n", current);
            current = outer;
        }
        return current;
    }
}
