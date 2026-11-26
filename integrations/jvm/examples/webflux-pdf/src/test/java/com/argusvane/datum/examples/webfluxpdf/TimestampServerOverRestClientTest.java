package com.argusvane.datum.examples.webfluxpdf;

import static org.assertj.core.api.Assertions.assertThat;

import com.sun.net.httpserver.HttpServer;
import com.argusvane.datum.pdf.PdfService;
import com.argusvane.datum.pdf.spring.RestClientTsaTransport;
import com.argusvane.datum.starter.test.AutoConfigureDatum;
import com.argusvane.datum.timestamp.InMemoryTsaLog;
import com.argusvane.datum.timestamp.SelfSignedTsaCertificate;
import com.argusvane.datum.timestamp.TimestampAuthority;
import com.argusvane.datum.timestamp.TimestampClient;
import com.argusvane.datum.timestamp.TimestampReply;
import com.argusvane.datum.timestamp.TsaKeyMaterial;
import com.argusvane.datum.timestamp.TsaTransport;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Scope;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.web.client.RestClient;
import org.springframework.test.context.DynamicPropertySource;

/**
 * The timestamp client's HTTP on the reactive stack: in this WebFlux application a named timestamp server
 * ({@code datum.pdf.signing.tsa.url}) is reached through the application's {@code RestClient.Builder} bean (Boot
 * auto-configures none on a reactive stack, so the application declares it), so what it sets is seen by the server. The PDF service seals on its blocking
 * pool, never on the event loop, so the blocking client is safe here. The server is a mock of the JDK's, on loopback.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
    "datum.pdf.signing.ssl-bundle=",
    "spring.ssl.bundle.jks.pdf-signer.keystore.location=",
    "spring.ssl.bundle.jks.pdf-signer.keystore.password=",
    "spring.ssl.bundle.jks.pdf-signer.keystore.type=",
    "datum.pdf.seal.enabled=false"})
@AutoConfigureDatum
class TimestampServerOverRestClientTest {

    private static final Map<String, String> SEEN = new ConcurrentHashMap<>();
    private static final HttpServer SERVER = server();

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

    @DynamicPropertySource
    static void timestampServer(DynamicPropertyRegistry registry) {
        registry.add("datum.pdf.signing.tsa.url", () -> "http://127.0.0.1:" + SERVER.getAddress().getPort() + "/tsa");
    }

    @AfterAll
    static void stop() {
        SERVER.stop(0);
    }

    /**
     * Boot configures no RestClient.Builder in a reactive application, so the application declares one (prototype, as
     * Boot's is) to carry the timestamp client's HTTP; what it sets on the builder reaches the server.
     */
    @TestConfiguration(proxyBeanMethods = false)
    static class RestClientBuilder {

        @Bean
        @Scope("prototype")
        RestClient.Builder restClientBuilder() {
            return RestClient.builder().defaultHeader("X-Example", "seen");
        }
    }

    @Autowired
    TsaTransport transport;

    @Autowired
    PdfService pdf;

    @Test
    void theReactiveApplicationsTimestampClientRidesTheRestClientBuilder() {
        assertThat(transport).isInstanceOf(RestClientTsaTransport.class);
        assertThat(pdf.timestampSource()).startsWith("http://127.0.0.1:");
        byte[] token = new TimestampClient(URI.create("http://127.0.0.1:" + SERVER.getAddress().getPort() + "/tsa"), Duration.ofSeconds(5), null, transport)
            .stamp("a signature value".getBytes(StandardCharsets.US_ASCII), "sealing");
        assertThat(TimestampClient.granted(token)).isTrue();
        assertThat(SEEN).containsEntry("x-example", "seen");
    }
}
