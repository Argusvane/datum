package com.argusvane.datum.examples.submissions;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.starter.test.DatumTck;
import com.argusvane.datum.submissions.events.SubmissionRedeliveredEvent;
import com.argusvane.datum.submissions.events.SubmissionRejectedEvent;
import com.argusvane.datum.submissions.events.SubmissionValidatedEvent;
import com.argusvane.datum.submissions.service.FormRef;
import com.argusvane.datum.submissions.service.SubmissionOutcome;
import com.argusvane.datum.submissions.service.SubmissionService;
import com.argusvane.datum.submissions.spi.SubmissionContext;
import com.argusvane.datum.submissions.spi.SubmissionError;
import com.argusvane.datum.submissions.spi.SubmissionHandler;
import com.argusvane.datum.tck.HostContract;
import com.argusvane.datum.tck.HostTarget;
import com.argusvane.datum.tck.Reply;
import com.argusvane.datum.tck.TckFixtures;
import java.util.Collections;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Bean;
import org.springframework.context.event.EventListener;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * With the REAL runtime: the security suite's golden documents get the same verdict through
 * {@code POST /api/submissions} (and the dry-run route) and through the example's queue, which hands them to the
 * {@link SubmissionService} bean on channel {@code bus}; the handler stores a valid document once whichever way it came
 * first, and every event carries the channel it came in on, with the client facts only for HTTP.
 */
@Tag("real-runtime")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
    "datum.web.api.endpoints.test=true",
    "datum.runtime.warm-up-runs=1"})
class SubmissionChannelsIT implements HostContract {

    private static final List<Object> EVENTS = new CopyOnWriteArrayList<>();
    private static final AtomicInteger HANDLED = new AtomicInteger();

    @TestConfiguration(proxyBeanMethods = false)
    static class Observed {

        /** Counts the example's handler calls, whichever way the document came in. */
        @Bean
        static BeanPostProcessor countingHandler() {
            return new BeanPostProcessor() {
                @Override
                public Object postProcessAfterInitialization(Object bean, String name) {
                    if (bean instanceof SubmissionHandler handler) {
                        return (SubmissionHandler) submission -> {
                            HANDLED.incrementAndGet();
                            return handler.handle(submission);
                        };
                    }
                    return bean;
                }
            };
        }

        @EventListener
        void validated(SubmissionValidatedEvent event) {
            EVENTS.add(event);
        }

        @EventListener
        void rejected(SubmissionRejectedEvent event) {
            EVENTS.add(event);
        }

        @EventListener
        void redelivered(SubmissionRedeliveredEvent event) {
            EVENTS.add(event);
        }
    }

    @LocalServerPort
    int port;

    @Autowired
    QueuedSubmissions queue;

    @Autowired
    SubmissionService service;

    @Override
    public HostTarget target() {
        return DatumTck.local(port);
    }

    @BeforeEach
    void forget() {
        EVENTS.clear();
        HANDLED.set(0);
    }

    /** A document queued as a submit attempt of its own: a fresh key, as a new broker message would have. */
    private SubmissionOutcome queued(JsonNode document) throws Exception {
        return queue.offer(document, UUID.randomUUID().toString()).get(60, TimeUnit.SECONDS);
    }

    private SubmissionOutcome queued(byte[] message) throws Exception {
        return queue.offer(message, UUID.randomUUID().toString()).get(60, TimeUnit.SECONDS);
    }

    private <T> List<T> eventsOf(Class<T> type) {
        return EVENTS.stream().filter(type::isInstance).map(type::cast).toList();
    }

    @Test
    void aSubmitAttemptIsStoredOnceWhicheverChannelBringsItFirst() throws Exception {
        // A document of its own, so no other test of this class has delivered it before.
        ObjectNode values = TckFixtures.validValues();
        values.put("name", "Grace Hopper");
        ObjectNode document = TckFixtures.envelope(TckFixtures.VERSION, values);
        String attempt = UUID.randomUUID().toString();

        SubmissionOutcome first = queue.offer(document, attempt).get(60, TimeUnit.SECONDS);
        assertThat(first).as(String.valueOf(first)).isInstanceOf(SubmissionOutcome.Accepted.class);
        SubmissionOutcome.Accepted accepted = (SubmissionOutcome.Accepted) first;
        assertThat(accepted.submission().channel()).isEqualTo("bus");
        assertThat(accepted.submission().remoteAddress()).isNull();
        assertThat(accepted.submission().userAgent()).isNull();

        // The same attempt (its key) over HTTP: the first receipt, handled.
        Reply again = http().postJson(target().api("/submissions"), TckFixtures.delivered(document, attempt));
        assertThat(again.status()).as(again.toString()).isEqualTo(200);
        assertThat(again.json().path("handled").booleanValue()).isTrue();
        assertThat(again.json().path("id").asString()).isEqualTo(accepted.receipt().id());
        assertThat(again.json().path("reference").asString()).isEqualTo(accepted.receipt().reference());
        assertThat(again.json().path("digest").asString()).isEqualTo(accepted.submission().digest());

        assertThat(HANDLED).as("the handler ran once for both channels").hasValue(1);
        assertThat(eventsOf(SubmissionValidatedEvent.class)).singleElement()
            .satisfies(event -> assertThat(event.channel()).isEqualTo("bus"));
        assertThat(eventsOf(SubmissionRedeliveredEvent.class)).singleElement()
            .satisfies(event -> assertThat(event.channel()).isEqualTo("http"));

        // The same answers under another key are another attempt: another record.
        Reply other = http().postJson(target().api("/submissions"), TckFixtures.delivered(document));
        assertThat(other.status()).as(other.toString()).isEqualTo(200);
        assertThat(other.json().path("handled").booleanValue()).isFalse();
        assertThat(other.json().path("id").asString()).isNotEqualTo(accepted.receipt().id());
        assertThat(HANDLED).hasValue(2);

        // The first key with another document, off the queue: a conflict, never the first receipt.
        ObjectNode changed = TckFixtures.envelope(TckFixtures.VERSION, values.deepCopy().put("name", "Grace Brewster Hopper"));
        assertThat(queue.offer(changed, attempt).get(60, TimeUnit.SECONDS))
            .isInstanceOf(SubmissionOutcome.KeyConflict.class);
        assertThat(HANDLED).hasValue(2);
    }

    @Test
    void theGoldenInvalidDocumentsAreRejectedAlikeOnBothChannels() throws Exception {
        for (String control : List.of("CTL-02", "CTL-03", "CTL-04")) {
            ObjectNode document = TckFixtures.envelope(control);

            Reply refused = http().postJson(target().api("/submissions"), TckFixtures.delivered(document));
            assertThat(refused.status()).as(control + " " + refused).isEqualTo(422);
            Set<String> overHttp = TckFixtures.codes(refused.json().path("errors"));

            SubmissionOutcome outcome = queued(document);
            assertThat(outcome).as(control + " " + outcome).isInstanceOf(SubmissionOutcome.Rejected.class);
            Set<String> overBus = new TreeSet<>();
            for (SubmissionError error : ((SubmissionOutcome.Rejected) outcome).errors()) {
                overBus.add(error.code() + "@" + error.field());
            }
            assertThat(overBus).as(control).isEqualTo(overHttp).isEqualTo(TckFixtures.goldenErrors(control));
        }
        assertThat(HANDLED).hasValue(0);
        List<SubmissionRejectedEvent> rejected = eventsOf(SubmissionRejectedEvent.class);
        assertThat(rejected).extracting(SubmissionRejectedEvent::channel).containsExactly("http", "bus", "http", "bus", "http", "bus");
        assertThat(rejected.get(0).remoteAddress()).as("the route's client facts").isNotNull();
        assertThat(rejected.get(1).remoteAddress()).as("the queue has none").isNull();
    }

    /**
     * One size cap on every channel: a document past {@code datum.web.api.max-body-size} is the route's
     * 413, the queue's {@code TooLarge} whether the message came as bytes or as a parsed tree, and nothing is handled.
     */
    @Test
    void aDocumentPastTheBodyCapIsRefusedOnEveryChannelBeforeAnyRun() throws Exception {
        ObjectNode values = TckFixtures.validValues();
        values.put("name", "x".repeat(1_100_000));
        ObjectNode document = TckFixtures.envelope(TckFixtures.VERSION, values);
        byte[] bytes = TckFixtures.wrapped(document).getBytes(java.nio.charset.StandardCharsets.UTF_8);

        Reply overHttp = http().postJson(target().api("/submissions"), TckFixtures.delivered(document));
        assertThat(overHttp.status()).as(overHttp.toString()).isEqualTo(413);

        assertThat(queued(document)).isEqualTo(new SubmissionOutcome.TooLarge(1024 * 1024));
        assertThat(queued(bytes)).isEqualTo(new SubmissionOutcome.TooLarge(1024 * 1024));
        assertThat(queued("{".getBytes(java.nio.charset.StandardCharsets.UTF_8)))
            .isEqualTo(new SubmissionOutcome.Malformed("The submission is not JSON."));

        // Under the cap, the same bytes off the queue are judged as the route judges them.
        ObjectNode fits = TckFixtures.envelope(TckFixtures.VERSION, TckFixtures.validValues().put("name", "Katherine Johnson"));
        assertThat(queued(fits.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)))
            .isInstanceOf(SubmissionOutcome.Accepted.class);
        assertThat(HANDLED).hasValue(1);
    }

    @Test
    void aStaleVersionIsOutdatedOnBothChannelsAndADryRunReportsTheSameVerdict() throws Exception {
        ObjectNode stale = TckFixtures.envelope("0", TckFixtures.validValues());
        Reply overHttp = http().postJson(target().api("/submissions"), TckFixtures.delivered(stale));
        assertThat(overHttp.status()).as(overHttp.toString()).isEqualTo(409);
        assertThat(overHttp.code()).isEqualTo("form.outdated");
        SubmissionOutcome overBus = queued(stale);
        assertThat(overBus).isInstanceOfSatisfying(SubmissionOutcome.Outdated.class,
            outdated -> assertThat(outdated.currentVersion()).isEqualTo(TckFixtures.VERSION));

        // The dry run judges without storing: the route's report and the service's carry the same outcome and digest.
        ObjectNode valid = TckFixtures.envelope("CTL-01");
        Reply report = http().postJson(target().api("/submissions/test"), TckFixtures.wrapped(valid));
        assertThat(report.status()).as(report.toString()).isEqualTo(200);
        SubmissionOutcome dryRun = service.test(FormRef.fromDocument(), valid, SubmissionContext.of(SubmissionContext.OTHER));
        assertThat(dryRun).isInstanceOfSatisfying(SubmissionOutcome.DryRun.class, run -> {
            assertThat(run.report().path("outcome").asString()).isEqualTo(report.json().path("outcome").asString()).isEqualTo("accepted");
            assertThat(run.report().path("digest").asString()).isEqualTo(report.json().path("digest").asString());
            assertThat(run.report().path("values")).isEqualTo(report.json().path("values"));
        });
        assertThat(HANDLED).hasValue(0);
        assertThat(Collections.unmodifiableList(EVENTS)).isEmpty();
    }
}
