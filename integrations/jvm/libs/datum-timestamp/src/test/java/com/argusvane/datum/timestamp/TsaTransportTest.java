package com.argusvane.datum.timestamp;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.net.URI;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** The transport seam: what the client asks of it, how it reads its answers, and the JDK default's own rules. */
class TsaTransportTest {

    private static final URI URL = URI.create("https://tsa.example/stamp");

    /** What a transport was asked: the whole call. */
    private record Call(URI url, byte[] query, Map<String, String> headers, Duration timeout) {
    }

    @Test
    void theClientAsksTheTransportForOnePostWithItsHeadersAndTimeout() {
        TimestampAuthority authority = new TimestampAuthority(TsaKeyMaterial.of(Fixtures.key("ec-p256")), null, null, Clock.systemUTC(),
            new InMemoryTsaLog(Clock.systemUTC()));
        List<Call> calls = new ArrayList<>();
        TsaTransport transport = (url, query, headers, timeout) -> {
            calls.add(new Call(url, query, headers, timeout));
            TimestampReply reply = authority.respond(query, null);
            return new TsaTransport.Reply(reply.status(), "application/timestamp-reply", reply.body());
        };
        TimestampClient client = new TimestampClient(URL, Duration.ofSeconds(3), new TimestampClient.Bearer("sekret"), transport);

        byte[] token = client.stamp("a signature value".getBytes(StandardCharsets.US_ASCII), "sealing");

        assertThat(TimestampClient.granted(token)).isTrue();
        assertThat(calls).hasSize(1);
        assertThat(calls.get(0).url()).isEqualTo(URL);
        assertThat(calls.get(0).timeout()).isEqualTo(Duration.ofSeconds(3));
        assertThat(calls.get(0).headers()).containsEntry("Content-Type", "application/timestamp-query")
            .containsEntry("Accept", "application/timestamp-reply").containsEntry("Authorization", "Bearer sekret");
    }

    @Test
    void anyStatusButAGrantedOkIsNamedWithTheServer() {
        TimestampClient answers500 = new TimestampClient(URL, null, null, (url, query, headers, timeout) -> new TsaTransport.Reply(500, null, new byte[0]));
        assertThatThrownBy(() -> answers500.request(new byte[] {1})).isInstanceOf(TimestampClientException.class)
            .hasMessage("No timestamp from https://tsa.example/stamp: it answered HTTP 500.")
            .satisfies(e -> assertThat(((TimestampClientException) e).status()).isEqualTo(500));

        TimestampClient answersGarbage = new TimestampClient(URL, null, null, (url, query, headers, timeout) -> new TsaTransport.Reply(200, null, new byte[] {1, 2}));
        assertThatThrownBy(() -> answersGarbage.request(new byte[] {1})).hasMessageContaining("it did not grant a timestamp");

        TimestampClient redirected = new TimestampClient(URL, null, null, (url, query, headers, timeout) -> new TsaTransport.Reply(302, null, new byte[0]));
        assertThatThrownBy(() -> redirected.request(new byte[] {1})).hasMessageContaining("it answered HTTP 302");
    }

    @Test
    void aTransportThatGotNoReplyBecomesATimestampClientException() {
        TimestampClient timedOut = new TimestampClient(URL, null, null, (url, query, headers, timeout) -> {
            throw new TsaTransportException(0, "it did not answer within 2000 ms.");
        });
        assertThatThrownBy(() -> timedOut.request(new byte[] {1})).isInstanceOf(TimestampClientException.class)
            .hasMessage("No timestamp from https://tsa.example/stamp: it did not answer within 2000 ms.")
            .satisfies(e -> assertThat(((TimestampClientException) e).status()).isZero());

        TimestampClient tooLarge = new TimestampClient(URL, null, null, (url, query, headers, timeout) -> {
            throw new TsaTransportException(200, "it answered with more than 1048576 bytes");
        });
        assertThatThrownBy(() -> tooLarge.request(new byte[] {1})).hasMessageContaining("more than 1048576 bytes")
            .satisfies(e -> assertThat(((TimestampClientException) e).status()).isEqualTo(200));
    }

    @Test
    void theJdkTransportTakesTheCallersClientButNeverOneThatFollowsRedirects() {
        HttpClient mine = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).connectTimeout(Duration.ofSeconds(2)).build();
        assertThat(new JdkTsaTransport(mine)).isNotNull();
        assertThat(new JdkTsaTransport()).isNotNull();
        for (HttpClient.Redirect redirect : new HttpClient.Redirect[] {HttpClient.Redirect.NORMAL, HttpClient.Redirect.ALWAYS}) {
            HttpClient following = HttpClient.newBuilder().followRedirects(redirect).build();
            assertThatThrownBy(() -> new JdkTsaTransport(following)).isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("must not follow redirects");
        }
    }

    /** {@code datum.pdf.signing.tsa.policy}: every request the client writes carries the reqPolicy, or none when unset. */
    @Test
    void theRequestCarriesTheConfiguredPolicyOnlyWhenOneIsSet() {
        List<TimestampQuery> seen = new ArrayList<>();
        TsaTransport transport = (url, query, headers, timeout) -> {
            seen.add(TimestampQuery.parse(query));
            return new TsaTransport.Reply(500, null, new byte[0]);
        };
        byte[] data = "a signature value".getBytes(StandardCharsets.US_ASCII);
        assertThatThrownBy(() -> new TimestampClient(URL, null, null, transport, " 1.2.3.4 ").stamp(data, "sealing")).isInstanceOf(TimestampClientException.class);
        assertThatThrownBy(() -> new TimestampClient(URL, null, null, transport, null).stamp(data, "sealing")).isInstanceOf(TimestampClientException.class);
        assertThatThrownBy(() -> new TimestampClient(URL, null, null, transport, " ").stamp(data, "sealing")).isInstanceOf(TimestampClientException.class);
        assertThat(seen).extracting(TimestampQuery::policy).containsExactly("1.2.3.4", null, null);
        assertThat(new TimestampClient(URL, null, null, transport, "1.2.3.4").policy()).isEqualTo("1.2.3.4");
        assertThatThrownBy(() -> new TimestampClient(URL, null, null, transport, "one.two")).isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("one.two").hasMessageContaining("object identifier");
    }
}
