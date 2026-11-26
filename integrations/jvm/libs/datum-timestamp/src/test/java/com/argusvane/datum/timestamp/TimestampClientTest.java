package com.argusvane.datum.timestamp;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** The client: the request it sends, and every way no timestamp comes, each with its message for the log. */
class TimestampClientTest {

    private static final byte[] DATA = "a signature value".getBytes(StandardCharsets.US_ASCII);

    private HttpServer server;
    private final Map<String, String> seen = new ConcurrentHashMap<>();
    private TimestampAuthority authority;
    private final java.util.concurrent.ExecutorService executor = java.util.concurrent.Executors.newCachedThreadPool();

    @BeforeEach
    void start() throws IOException {
        authority = new TimestampAuthority(TsaKeyMaterial.of(Fixtures.key("ec-p256")), null, null, Clock.systemUTC(), new InMemoryTsaLog(Clock.systemUTC()));
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/tsa", exchange -> {
            seen.put("method", exchange.getRequestMethod());
            seen.put("content-type", String.valueOf(exchange.getRequestHeaders().getFirst("Content-Type")));
            seen.put("accept", String.valueOf(exchange.getRequestHeaders().getFirst("Accept")));
            seen.put("authorization", String.valueOf(exchange.getRequestHeaders().getFirst("Authorization")));
            seen.put("upgrade", String.valueOf(exchange.getRequestHeaders().getFirst("Upgrade")));
            seen.put("protocol", exchange.getProtocol());
            TimestampReply reply = authority.respond(exchange.getRequestBody().readAllBytes(), null);
            send(exchange, reply.status(), reply.body());
        });
        server.createContext("/moved", exchange -> {
            exchange.getResponseHeaders().add("Location", "/tsa");
            send(exchange, 302, new byte[0]);
        });
        server.createContext("/broken", exchange -> send(exchange, 500, "oops".getBytes(StandardCharsets.US_ASCII)));
        server.createContext("/rejecting", exchange -> {
            exchange.getRequestBody().readAllBytes();
            send(exchange, 200, new TimestampRefusal(TimestampRefusal.FAIL_SYSTEM_FAILURE, "Down.").toResponse());
        });
        // A server that ignores reqPolicy: it grants under its own issuing policy whatever was asked.
        server.createContext("/ignoring", exchange -> {
            exchange.getRequestBody().readAllBytes();
            send(exchange, 200, authority.stamp(DATA, "sealing"));
        });
        // A refusal whose statusString tries to start a new log line.
        server.createContext("/forging", exchange -> {
            exchange.getRequestBody().readAllBytes();
            send(exchange, 200, new TimestampRefusal(TimestampRefusal.FAIL_UNACCEPTED_POLICY, "No.\nINFO forged line\u001b[2K").toResponse());
        });
        server.createContext("/slow", exchange -> {
            try {
                Thread.sleep(2500);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            send(exchange, 200, new byte[0]);
        });
        // 200 and a Content-Length, then a byte every 200 ms: the headers come at once, the body never ends in time.
        server.createContext("/trickle", exchange -> {
            exchange.getRequestBody().readAllBytes();
            exchange.sendResponseHeaders(200, 100_000);
            try (OutputStream out = exchange.getResponseBody()) {
                for (int i = 0; i < 100; i++) {
                    out.write(0x30);
                    out.flush();
                    Thread.sleep(200);
                }
            } catch (IOException | InterruptedException e) {
                // The client hung up, as it should.
            }
        });
        // A body one byte over the cap, streamed (chunked: no Content-Length to refuse it by).
        server.createContext("/huge", exchange -> {
            exchange.getRequestBody().readAllBytes();
            exchange.sendResponseHeaders(200, 0);
            byte[] block = new byte[64 * 1024];
            try (OutputStream out = exchange.getResponseBody()) {
                int left = TimestampClient.MAX_REPLY_BYTES + 1;
                while (left > 0) {
                    int n = Math.min(block.length, left);
                    out.write(block, 0, n);
                    left -= n;
                }
            } catch (IOException e) {
                // The client may hang up once past the cap.
            }
        });
        // A Content-Length over the cap: refused before the body is read.
        server.createContext("/announced", exchange -> {
            exchange.getRequestBody().readAllBytes();
            exchange.sendResponseHeaders(200, TimestampClient.MAX_REPLY_BYTES + 1L);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(new byte[16]);
                out.flush();
                Thread.sleep(5000);
            } catch (IOException | InterruptedException e) {
                // The client hung up.
            }
        });
        server.setExecutor(executor);
        server.start();
    }

    @AfterEach
    void stop() {
        server.stop(0);
        executor.shutdownNow();
    }

    private URI url(String path) {
        return URI.create("http://127.0.0.1:" + server.getAddress().getPort() + path);
    }

    private static void send(com.sun.net.httpserver.HttpExchange exchange, int status, byte[] body) throws IOException {
        exchange.sendResponseHeaders(status, body.length == 0 ? -1 : body.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(body);
        }
    }

    @Test
    void postsATimestampQueryAndTakesAGrantedReply() {
        byte[] reply = new TimestampClient(url("/tsa"), Duration.ofSeconds(5), new TimestampClient.Bearer("dtsa_key")).stamp(DATA, "sealing");
        assertThat(TimestampClient.granted(reply)).isTrue();
        assertThat(TimestampToken.parse(reply).verifyOver(DATA, List.of()).problem()).isNull();
        assertThat(seen).containsEntry("method", "POST").containsEntry("content-type", "application/timestamp-query")
            .containsEntry("accept", "application/timestamp-reply").containsEntry("authorization", "Bearer dtsa_key");
        new TimestampClient(url("/tsa"), null, new TimestampClient.Basic("anyone", "dtsa_key")).stamp(DATA, "sealing");
        assertThat(seen.get("authorization")).isEqualTo("Basic " + java.util.Base64.getEncoder().encodeToString("anyone:dtsa_key".getBytes(StandardCharsets.UTF_8)));
        assertThat(new TimestampClient.Bearer("secret").toString()).doesNotContain("secret");
        // A plain HTTP/1.1 POST (RFC 3161 3.4): no h2c upgrade offered on a request with a body.
        assertThat(seen).containsEntry("protocol", "HTTP/1.1").containsEntry("upgrade", "null");
    }

    @Test
    void theTimeoutBoundsTheBodyToo() {
        String base = "http://127.0.0.1:" + server.getAddress().getPort();
        long started = System.nanoTime();
        assertThatThrownBy(() -> new TimestampClient(url("/trickle"), Duration.ofSeconds(1), null).stamp(DATA, "sealing"))
            .isInstanceOfSatisfying(TimestampClientException.class, e -> {
                assertThat(e.status()).isZero();
                assertThat(e.getMessage()).isEqualTo("No timestamp from " + base + "/trickle: it did not answer within 1000 ms.");
            });
        // The server would take 20 s to send its body; the client gave up at its deadline.
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(4));
    }

    @Test
    void aReplyOverTheCapIsRefused() {
        String base = "http://127.0.0.1:" + server.getAddress().getPort();
        for (String path : List.of("/huge", "/announced")) {
            long started = System.nanoTime();
            assertThatThrownBy(() -> new TimestampClient(url(path), Duration.ofSeconds(10), null).stamp(DATA, "sealing"))
                .isInstanceOfSatisfying(TimestampClientException.class, e -> assertThat(e.status()).isEqualTo(200))
                .hasMessage("No timestamp from " + base + path + ": it answered with more than " + TimestampClient.MAX_REPLY_BYTES + " bytes.");
            assertThat(Duration.ofNanos(System.nanoTime() - started)).as(path).isLessThan(Duration.ofSeconds(4));
        }
    }

    @Test
    void aUrlTheClientCannotPostToIsRefusedWhenConfigured() {
        for (String url : List.of("ftp://tsa.example/x", "localhost:318/tsa", "http:///x", "tsa.example/x", "file:///etc/hosts")) {
            assertThatThrownBy(() -> new TimestampClient(URI.create(url)))
                .as(url)
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining(url);
        }
        // An https URL with a host is taken (no request is made here).
        assertThat(new TimestampClient(URI.create("HTTPS://tsa.example/tsa")).url().getHost()).isEqualTo("tsa.example");
    }

    @Test
    void namesTheServerAndTheProblemWhenNoTimestampComes() {
        String base = "http://127.0.0.1:" + server.getAddress().getPort();
        assertThatThrownBy(() -> new TimestampClient(url("/moved")).stamp(DATA, "sealing"))
            .isInstanceOfSatisfying(TimestampClientException.class, e -> {
                assertThat(e.status()).isEqualTo(302);
                assertThat(e.getMessage()).isEqualTo("No timestamp from " + base + "/moved: it answered HTTP 302.");
                assertThat(e.code()).isEqualTo("timestamp.unavailable");
            });
        assertThatThrownBy(() -> new TimestampClient(url("/broken")).stamp(DATA, "sealing"))
            .hasMessage("No timestamp from " + base + "/broken: it answered HTTP 500.");
        assertThatThrownBy(() -> new TimestampClient(url("/rejecting")).stamp(DATA, "sealing"))
            .isInstanceOfSatisfying(TimestampClientException.class, e -> assertThat(e.status()).isEqualTo(200))
            .hasMessage("No timestamp from " + base + "/rejecting: it did not grant a timestamp (rejection, systemFailure: \"Down.\").");
        // The server refuses a SHA-1 request: 400 with a rejection body, which the JDK transport does not read (it reads a
        // 200 reply only), so the message is the status alone.
        assertThatThrownBy(() -> new TimestampClient(url("/tsa")).request(Der.sequence(Der.integer(1),
            Der.sequence(Der.sequence(Der.oid("1.3.14.3.2.26"), Der.nul()), Der.octetString(new byte[20])))))
            .hasMessage("No timestamp from " + base + "/tsa: it answered HTTP 400.");
        assertThatThrownBy(() -> new TimestampClient(url("/slow"), Duration.ofSeconds(1), null).stamp(DATA, "sealing"))
            .isInstanceOfSatisfying(TimestampClientException.class, e -> {
                assertThat(e.status()).isZero();
                assertThat(e.getMessage()).startsWith("No timestamp from " + base + "/slow: ").endsWith(".");
            });
    }

    /**
     * A refused reqPolicy is told apart from any other refusal (unacceptedPolicy and the server's words), and a
     * server that grants under another policy than the one asked for gives no token.
     */
    @Test
    void theRequestedPolicyIsRefusedByNameAndAGrantUnderAnotherPolicyIsNoToken() {
        String base = "http://127.0.0.1:" + server.getAddress().getPort();
        String issuing = authority.acceptedPolicies().iterator().next();
        // The in-process authority refuses an unoffered policy with 400 and a rejection body; a transport that returns the
        // body (the contract allows it; the JDK one reads 200 replies only) lets the message name the failure and the words.
        TsaTransport carrying = (target, query, headers, timeout) -> {
            TimestampReply reply = authority.respond(query, null);
            return new TsaTransport.Reply(reply.status(), "application/timestamp-reply", reply.body());
        };
        assertThatThrownBy(() -> new TimestampClient(url("/tsa"), null, null, carrying, "1.2.3.4").stamp(DATA, "sealing"))
            .isInstanceOf(TimestampClientException.class)
            .hasMessageStartingWith("No timestamp from " + base + "/tsa: it answered HTTP 400 (rejection, unacceptedPolicy: \"")
            .hasMessageContaining(issuing);
        assertThatThrownBy(() -> new TimestampClient(url("/tsa"), null, null, new JdkTsaTransport(), "1.2.3.4").stamp(DATA, "sealing"))
            .hasMessage("No timestamp from " + base + "/tsa: it answered HTTP 400.");
        // The policy the server issues under is asked for and granted.
        byte[] granted = new TimestampClient(url("/tsa"), null, null, new JdkTsaTransport(), issuing).stamp(DATA, "sealing");
        assertThat(TimestampToken.fromResponse(granted).policy()).isEqualTo(issuing);
        // A server that ignores reqPolicy: its token names the issuing policy, not the one asked for.
        assertThatThrownBy(() -> new TimestampClient(url("/ignoring"), null, null, new JdkTsaTransport(), "1.2.3.4").stamp(DATA, "sealing"))
            .isInstanceOfSatisfying(TimestampClientException.class, e -> assertThat(e.status()).isEqualTo(200))
            .hasMessage("No timestamp from " + base + "/ignoring: it granted a timestamp under the policy " + issuing
                + ", not the policy 1.2.3.4 asked for.");
        // No policy asked: the same token is taken, as before.
        assertThat(TimestampClient.granted(new TimestampClient(url("/ignoring")).stamp(DATA, "sealing"))).isTrue();
    }

    /** The server's statusString is its text: it reaches the message on one line, its control characters as spaces. */
    @Test
    void aRefusalsWordsCannotForgeALogLine() {
        assertThatThrownBy(() -> new TimestampClient(url("/forging")).stamp(DATA, "sealing"))
            .hasMessageEndingWith("it did not grant a timestamp (rejection, unacceptedPolicy: \"No. INFO forged line [2K\").")
            .satisfies(e -> assertThat(e.getMessage()).doesNotContain("\n").doesNotContain("\u001b"));
        assertThat(TimestampClient.why("oops".getBytes(StandardCharsets.US_ASCII))).isEmpty();
        assertThat(TimestampClient.why(new byte[0])).isEmpty();
    }

    @Test
    void grantedReadsTheStatusLeniently() {
        assertThat(TimestampClient.granted(Fixtures.unhex("3003020100"))).isFalse();
        assertThat(TimestampClient.granted(Fixtures.unhex("30053003020100"))).isTrue();
        assertThat(TimestampClient.granted(Fixtures.unhex("30053003020101"))).isTrue();
        assertThat(TimestampClient.granted(Fixtures.unhex("30053003020102"))).isFalse();
        // BER lengths are taken: the token is checked by whoever reads it.
        assertThat(TimestampClient.granted(Fixtures.unhex("308200053081030201000000"))).isTrue();
        assertThat(TimestampClient.granted(new byte[0])).isFalse();
        assertThat(TimestampClient.granted(null)).isFalse();
    }
}
