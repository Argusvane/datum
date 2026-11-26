package com.argusvane.datum.examples.webfluxpdf;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.sun.net.httpserver.HttpServer;
import com.argusvane.datum.pdf.spring.RestClientTsaTransport;
import com.argusvane.datum.timestamp.InMemoryTsaLog;
import com.argusvane.datum.timestamp.SelfSignedTsaCertificate;
import com.argusvane.datum.timestamp.TimestampAuthority;
import com.argusvane.datum.timestamp.TimestampReply;
import com.argusvane.datum.timestamp.TsaKeyMaterial;
import com.argusvane.datum.timestamp.TsaTransport;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.util.List;
import java.util.UUID;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Scope;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.client.RestClient;
import reactor.core.scheduler.Schedulers;
import tools.jackson.databind.json.JsonMapper;

/**
 * The reactive proof of the RestClient timestamp transport, through a real request: a stored submission is
 * issued as a sealed receipt over HTTP on Netty with {@code datum.pdf.signing.tsa.url} naming a mock timestamp server, so
 * it is the PDF service's own timestamper (not a client the test builds) that must reach the server through the
 * application's {@code RestClient.Builder}. A wrapper around the transport bean records the thread it is called on and
 * asserts that it is never a Reactor non-blocking thread: the blocking client runs on the PDF service's blocking pool, not
 * the event loop. Real runtime, so it runs in the integration phase beside {@link PdfExampleIT}.
 */
@Tag("real-runtime")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
    "datum.web.throttle.limit=100",
    "datum.runtime.pdf.time-limit=60s",
    "datum.pdf.seal.enabled=true",
    "datum.pdf.seal.timestamp=true"})
class TimestampSealOverRestClientIT {

    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final Map<String, String> SEEN = new ConcurrentHashMap<>();
    private static final List<Boolean> NON_BLOCKING = new CopyOnWriteArrayList<>();
    private static final List<String> DELEGATES = new CopyOnWriteArrayList<>();
    private static final HttpServer SERVER = server();
    private static final Path STORE_DIR = makeKeyStore();

    private static HttpServer server() {
        try {
            TimestampAuthority authority = new TimestampAuthority(TsaKeyMaterial.of(SelfSignedTsaCertificate.create("Mock TSA")), null, null,
                Clock.systemUTC(), new InMemoryTsaLog(Clock.systemUTC()));
            HttpServer http = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
            http.createContext("/tsa", exchange -> {
                SEEN.put("x-example", String.valueOf(exchange.getRequestHeaders().getFirst("X-Example")));
                TimestampReply reply = authority.respond(exchange.getRequestBody().readAllBytes(), null);
                exchange.sendResponseHeaders(reply.status(), reply.body().length);
                try (OutputStream out = exchange.getResponseBody()) {
                    out.write(reply.body());
                }
            });
            http.start();
            return http;
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Runs scripts/make-dev-keystore.sh as PdfExampleIT does. */
    private static Path makeKeyStore() {
        try {
            Path dir = Files.createTempDirectory("datum-example-pdf-tsa");
            Path script = Path.of(System.getProperty("user.dir")).resolve("scripts/make-dev-keystore.sh");
            assumeTrue(Files.isRegularFile(script), "scripts/make-dev-keystore.sh is not under the working directory.");
            ProcessBuilder builder = new ProcessBuilder("sh", script.toString(), dir.toString()).redirectErrorStream(true);
            builder.environment().put("KEYTOOL", Path.of(System.getProperty("java.home"), "bin", "keytool").toString());
            Process process = builder.start();
            String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            assertThat(process.waitFor(60, TimeUnit.SECONDS)).as(output).isTrue();
            assertThat(process.exitValue()).as(output).isZero();
            return dir;
        } catch (IOException e) {
            throw new IllegalStateException(e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(e);
        }
    }

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("spring.ssl.bundle.jks.pdf-signer.keystore.location", () -> "file:" + STORE_DIR.resolve("dev-signer.p12"));
        registry.add("spring.ssl.bundle.jks.pdf-signer.keystore.password", () -> "changeit");
        registry.add("datum.pdf.signing.tsa.url", () -> "http://127.0.0.1:" + SERVER.getAddress().getPort() + "/tsa");
    }

    @AfterAll
    static void stop() {
        SERVER.stop(0);
    }

    @TestConfiguration(proxyBeanMethods = false)
    static class Wiring {

        /** Boot configures no RestClient.Builder on a reactive stack: the application opts in with a prototype bean. */
        @Bean
        @Scope("prototype")
        RestClient.Builder restClientBuilder() {
            return RestClient.builder().defaultHeader("X-Example", "seen");
        }

        /** Wraps the transport bean so each call records whether it ran on a Reactor non-blocking (event loop) thread. */
        @Bean
        static BeanPostProcessor recordingTransport() {
            return new BeanPostProcessor() {
                @Override
                public Object postProcessAfterInitialization(Object bean, String name) {
                    if (!(bean instanceof RestClientTsaTransport)) {
                        return bean;
                    }
                    DELEGATES.add(bean.getClass().getSimpleName());
                    TsaTransport delegate = (TsaTransport) bean;
                    return (TsaTransport) (url, query, headers, timeout) -> {
                        NON_BLOCKING.add(Schedulers.isInNonBlockingThread());
                        return delegate.post(url, query, headers, timeout);
                    };
                }
            };
        }
    }

    @LocalServerPort
    int port;

    @Test
    void aSealedReceiptReachesTheTimestampServerThroughTheRestClientOffTheEventLoop() throws Exception {
        String envelope = "{\"versionContext\":{\"form\":{\"id\":\"intake\",\"version\":\"1\"},"
            + "\"client\":{\"runtimeVersion\":\"x\",\"rendererVersion\":\"x\",\"schemaVersion\":\"1\"}},"
            + "\"submission\":{\"locale\":\"en\",\"values\":{\"name\":\"Ada Lovelace\",\"email\":\"ada@example.org\",\"request\":\"A copy of my file.\"}}}";
        HttpClient http = HttpClient.newHttpClient();
        HttpResponse<byte[]> accepted = http.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/submissions"))
            .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString("{\"document\":" + envelope + ",\"submissionKey\":\"" + UUID.randomUUID() + "\"}")).build(), HttpResponse.BodyHandlers.ofByteArray());
        assertThat(accepted.statusCode()).as(new String(accepted.body(), StandardCharsets.UTF_8)).isEqualTo(200);
        String id = JSON.readTree(accepted.body()).path("id").asString();

        HttpResponse<byte[]> receipt = http.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/receipts/" + id + ".pdf")).GET().build(),
            HttpResponse.BodyHandlers.ofByteArray());
        assertThat(receipt.statusCode()).isEqualTo(200);
        assertThat(receipt.headers().firstValue("X-Sealed")).hasValue("true");
        // The token came from the mock server (not the in-process authority), through the application's builder.
        assertThat(receipt.headers().firstValue("X-Timestamped")).hasValue("true");
        assertThat(SEEN).containsEntry("x-example", "seen");
        assertThat(DELEGATES).containsExactly("RestClientTsaTransport");
        assertThat(NON_BLOCKING).isNotEmpty().containsOnly(false);
    }
}
