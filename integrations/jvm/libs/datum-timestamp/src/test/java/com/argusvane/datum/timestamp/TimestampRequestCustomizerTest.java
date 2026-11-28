package com.argusvane.datum.timestamp;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.hooks.HookRefusedException;
import com.argusvane.datum.core.observation.DatumObservations;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.bouncycastle.asn1.cmp.PKIFailureInfo;
import org.bouncycastle.tsp.TimeStampResponse;
import org.bouncycastle.tsp.TimeStampTokenInfo;
import org.junit.jupiter.api.Test;

/**
 * The timestamp side of the hook model: {@link TimestampRequestCustomizer}s run in order before anything is
 * loaded or spent, choose the policy and the accuracy within the server's bounds, refuse with RFC 3161 rejections, and a
 * customizer that throws is a systemFailure, never a token issued without it.
 */
class TimestampRequestCustomizerTest {

    private static final String OTHER = "1.3.6.1.4.1.99999.1";

    private static TimestampAuthority authority(AtomicInteger serials, List<TimestampRequestCustomizer> customizers) {
        return new TimestampAuthority(TsaKeyMaterial.of(Fixtures.key("tsa")), null, Duration.ofSeconds(1),
            TsaTimeSource.of(Fixtures.clock(Fixtures.OCT_5)), entry -> serials.incrementAndGet(), List.of(OTHER), customizers, DatumObservations.none());
    }

    private static TimeStampTokenInfo info(TimestampReply reply) throws Exception {
        return new TimeStampResponse(reply.body()).getTimeStampToken().getTimeStampInfo();
    }

    @Test
    void theCustomizersRunInOrderAndChooseThePolicyAndTheAccuracy() throws Exception {
        List<String> seen = new ArrayList<>();
        TimestampRequestCustomizer first = draft -> {
            seen.add("first:" + draft.client() + ":" + draft.channel() + ":" + draft.algorithm() + ":" + draft.requestedPolicy());
            draft.policy(OTHER);
            draft.accuracy(Duration.ofMillis(250));
        };
        TimestampRequestCustomizer second = draft -> {
            seen.add("second:" + draft.policy() + ":" + draft.accuracy().toMillis());
            draft.accuracy(Duration.ofSeconds(3));
        };
        AtomicInteger serials = new AtomicInteger();

        TimestampReply reply = authority(serials, List.of(first, second)).respond(TimestampQuery.forData("x".getBytes()), "client-1");

        assertThat(reply.granted()).isTrue();
        assertThat(seen).containsExactly("first:client-1:http:sha256:null", "second:" + OTHER + ":250");
        TimeStampTokenInfo info = info(reply);
        assertThat(info.getPolicy().getId()).isEqualTo(OTHER);
        assertThat(info.getAccuracy().getSeconds().intValueExact()).isEqualTo(3);
        assertThat(reply.issued().policy()).as("the issue and the log name the chosen policy").isEqualTo(OTHER);
    }

    @Test
    void withNoCustomizerTheTokenIsTheConfiguredOne() throws Exception {
        TimestampReply reply = authority(new AtomicInteger(), List.of()).respond(TimestampQuery.forData("x".getBytes()), null);
        TimeStampTokenInfo info = info(reply);
        assertThat(info.getPolicy().getId()).isEqualTo(TimestampAuthority.DEFAULT_POLICY);
        assertThat(info.getAccuracy().getSeconds().intValueExact()).isEqualTo(1);
    }

    @Test
    void aRequestThatNamesAPolicyKeepsItAndTheBoundsHold() {
        List<String> seen = new ArrayList<>();
        AtomicInteger serials = new AtomicInteger();
        TimestampAuthority asked = authority(serials, List.of(draft -> {
            seen.add(draft.requestedPolicy());
            draft.policy(TimestampAuthority.DEFAULT_POLICY);
        }));
        byte[] query = TimestampQuery.forData("x".getBytes(), "sha256", true, null, OTHER);

        TimestampReply reply = asked.respond(query, null);

        assertThat(seen).containsExactly(OTHER);
        assertThat(reply.status()).as("a draft value outside the bounds is the application's failure").isEqualTo(503);
        assertThat(reply.refusal().failInfo()).isEqualTo(TimestampRefusal.FAIL_SYSTEM_FAILURE);
        assertThat(serials).hasValue(0);

        TimestampRequestDraft draft = new TimestampRequestDraft(TimestampQuery.parse(TimestampQuery.forData("x".getBytes())), null, "http",
            java.util.Set.of(TimestampAuthority.DEFAULT_POLICY), TimestampAuthority.DEFAULT_POLICY, Duration.ZERO);
        assertThatThrownBy(() -> draft.policy(OTHER)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> draft.accuracy(Duration.ofSeconds(61))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> draft.accuracy(Duration.ofMillis(-1))).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void aRefusalIsARejectionBeforeAnySerialAndStopsTheLaterCustomizers() throws Exception {
        AtomicInteger serials = new AtomicInteger();
        List<String> ran = new ArrayList<>();
        TimestampAuthority refusing = authority(serials, List.of(draft -> {
            ran.add("first");
            if ("blocked".equals(draft.client())) {
                throw HookRefusedException.forbidden("tsa.client.blocked", "This client may not ask for tokens.");
            }
        }, draft -> ran.add("second")));

        TimestampReply reply = refusing.respond(TimestampQuery.forData("x".getBytes()), "blocked");

        assertThat(reply.status()).isEqualTo(400);
        TimeStampResponse read = new TimeStampResponse(reply.body());
        assertThat(read.getStatus()).isEqualTo(2);
        assertThat(read.getFailInfo().intValue()).isEqualTo(PKIFailureInfo.badRequest);
        assertThat(read.getStatusString()).isEqualTo("This client may not ask for tokens.");
        assertThat(ran).containsExactly("first");
        assertThat(serials).hasValue(0);

        TimestampAuthority ownBit = authority(serials, List.of(draft -> {
            throw new TimestampRefusedException(TimestampRefusal.FAIL_UNACCEPTED_POLICY, "Ask for the receipts policy.");
        }));
        TimestampReply policy = ownBit.respond(TimestampQuery.forData("x".getBytes()), null);
        assertThat(new TimeStampResponse(policy.body()).getFailInfo().intValue()).as("the TSA's own refusal passes as thrown")
            .isEqualTo(PKIFailureInfo.unacceptedPolicy);
        assertThat(serials).hasValue(0);
    }

    @Test
    void aCustomizerThatThrowsIsASystemFailureForTheEndpointAndTheHostsOwnStamps() throws Exception {
        AtomicInteger serials = new AtomicInteger();
        TimestampAuthority broken = authority(serials, List.of(TimestampRequestCustomizer.everyChannel(draft -> {
            throw new IllegalStateException("policy directory down /secret/path");
        })));

        TimestampReply reply = broken.respond(TimestampQuery.forData("x".getBytes()), null);

        assertThat(reply.status()).isEqualTo(503);
        TimeStampResponse read = new TimeStampResponse(reply.body());
        assertThat(read.getFailInfo().intValue()).isEqualTo(PKIFailureInfo.systemFailure);
        assertThat(read.getStatusString()).doesNotContain("secret");
        assertThatThrownBy(() -> broken.stamp("x".getBytes(), "sealing"))
            .isInstanceOfSatisfying(TimestampRefusedException.class, e -> assertThat(e.failInfo()).isEqualTo(TimestampRefusal.FAIL_SYSTEM_FAILURE));
        assertThat(serials).hasValue(0);
    }

    @Test
    void byDefaultACustomizerLeavesTheHostsOwnTokensAloneAndOptsInWithEveryChannel() throws Exception {
        // A client policy that refuses an unknown client (client == null) must not refuse the host's
        // own seals and receipts, which carry no client, unless the customizer says it is meant for them.
        AtomicInteger serials = new AtomicInteger();
        List<String> ran = new ArrayList<>();
        TimestampRequestCustomizer clientPolicy = draft -> {
            ran.add("client:" + draft.channel());
            if (draft.client() == null) {
                throw HookRefusedException.forbidden("tsa.client.unknown", "Sign in to ask for tokens.");
            }
        };
        TimestampAuthority authority = authority(serials, List.of(clientPolicy));

        assertThat(authority.respond(TimestampQuery.forData("x".getBytes()), null).status()).isEqualTo(400);
        byte[] sealed = authority.stamp("x".getBytes(), "sealing");
        assertThat(new TimeStampResponse(sealed).getStatus()).as("the seal's token is issued").isZero();
        assertThat(ran).containsExactly("client:http");
        assertThat(serials).hasValue(1);

        List<String> every = new ArrayList<>();
        TimestampAuthority opted = authority(serials, List.of(TimestampRequestCustomizer.everyChannel(draft -> {
            every.add(draft.channel());
            draft.accuracy(Duration.ofSeconds(5));
        })));
        TimeStampResponse receipt = new TimeStampResponse(opted.stamp("x".getBytes(), "receipt"));
        assertThat(every).containsExactly("receipt");
        assertThat(receipt.getTimeStampToken().getTimeStampInfo().getAccuracy().getSeconds().intValueExact()).isEqualTo(5);

        TimestampAuthority askedFirst = authority(serials, List.of(new TimestampRequestCustomizer() {
            @Override
            public void customize(TimestampRequestDraft draft) {
            }

            @Override
            public boolean appliesTo(String channel) {
                throw new IllegalStateException("the channel table is down");
            }
        }));
        assertThatThrownBy(() -> askedFirst.stamp("x".getBytes(), "sealing"))
            .as("appliesTo throwing is the customizer's failure")
            .isInstanceOfSatisfying(TimestampRefusedException.class, e -> assertThat(e.failInfo()).isEqualTo(TimestampRefusal.FAIL_SYSTEM_FAILURE));
    }
}
