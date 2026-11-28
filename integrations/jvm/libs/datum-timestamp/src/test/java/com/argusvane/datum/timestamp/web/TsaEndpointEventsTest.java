package com.argusvane.datum.timestamp.web;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.DatumEventPublisher;
import com.argusvane.datum.timestamp.InMemoryTsaLog;
import com.argusvane.datum.timestamp.SelfSignedTsaCertificate;
import com.argusvane.datum.timestamp.TimestampAuthority;
import com.argusvane.datum.timestamp.TimestampQuery;
import com.argusvane.datum.timestamp.TsaClient;
import com.argusvane.datum.timestamp.TsaKeyMaterial;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * {@link TsaEndpoint} guards the publisher it is given, with no Spring binding in between: a plain-Java
 * host whose listener throws still sends the signed token (its serial is spent) and the refusal, never a 500. The Spring
 * binding guards too, so only this library-level test notices if the endpoint's own guard is lost.
 */
class TsaEndpointEventsTest {

    /** Through the host's default publisher, the guarded one. */
    @Test
    void aThrowingListenerStillSendsTheTokenAndTheRefusal() {
        List<Object> attempted = new ArrayList<>();
        TsaEndpoint endpoint = endpoint(DatumEventPublisher.guarded(event -> {
            attempted.add(event);
            throw new AssertionError("audit listener broke");
        }));
        TsaClient client = new TsaClient("c-1", "Client one");

        TsaHttpReply granted = endpoint.issue(TimestampQuery.forData("A document.".getBytes(StandardCharsets.US_ASCII)), client);
        assertThat(granted.status()).isEqualTo(200);
        assertThat(granted.contentType()).isEqualTo("application/timestamp-reply");
        assertThat(granted.body()).isNotEmpty();
        assertThat(attempted).singleElement().isInstanceOfSatisfying(TimestampIssuedEvent.class,
            event -> assertThat(event.client()).isEqualTo("c-1"));

        TsaHttpReply refused = endpoint.issue("not a TimeStampReq".getBytes(StandardCharsets.US_ASCII), null);
        assertThat(refused.contentType()).isEqualTo("application/timestamp-reply");
        assertThat(attempted).hasSize(2).last().isInstanceOf(TimestampRefusedEvent.class);
    }

    /**
     * The endpoint uses the publisher it is given as given, so an application's own
     * publisher that throws reaches the caller, after the token was signed.
     */
    @Test
    void anApplicationsOwnPublisherThatThrowsReachesTheCaller() {
        List<Object> attempted = new ArrayList<>();
        TsaEndpoint endpoint = endpoint(event -> {
            attempted.add(event);
            throw new IllegalStateException("outbox down");
        });
        org.assertj.core.api.Assertions.assertThatIllegalStateException().isThrownBy(() -> endpoint.issue(
            TimestampQuery.forData("A document.".getBytes(StandardCharsets.US_ASCII)), new TsaClient("c-1", "Client one")))
            .withMessage("outbox down");
        assertThat(attempted).singleElement().isInstanceOf(TimestampIssuedEvent.class);
    }

    private static TsaEndpoint endpoint(DatumEventPublisher events) {
        TsaKeyMaterial keys = TsaKeyMaterial.of(SelfSignedTsaCertificate.create("Events TSA"));
        Clock clock = Clock.systemUTC();
        TimestampAuthority authority = new TimestampAuthority(keys, null, null, clock, new InMemoryTsaLog(clock));
        TsaFlood open = new TsaFlood() {
            @Override
            public boolean isAllowed(String event, int limit, long windowSeconds, String identifier) {
                return true;
            }

            @Override
            public void register(String event, long windowSeconds, String identifier) {
            }
        };
        TsaClient client = new TsaClient("c-1", "Client one");
        return new TsaEndpoint(authority, key -> Optional.of(client), open, new TsaCertificates(keys, List.of()), TsaSettings.defaults(), events, Set.of());
    }
}
