package com.argusvane.datum.pdf.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import com.sun.net.httpserver.HttpsConfigurator;
import com.sun.net.httpserver.HttpsServer;
import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.pdf.PdfRuntime;
import com.argusvane.datum.pdf.ScriptedPdfRuntime;
import com.argusvane.datum.pdf.TestAssets;
import com.argusvane.datum.timestamp.InMemoryTsaLog;
import com.argusvane.datum.timestamp.JdkTsaTransport;
import com.argusvane.datum.timestamp.TimestampAuthority;
import com.argusvane.datum.timestamp.TimestampClient;
import com.argusvane.datum.timestamp.TimestampClientException;
import com.argusvane.datum.timestamp.TimestampReply;
import com.argusvane.datum.timestamp.TsaKeyMaterial;
import com.argusvane.datum.timestamp.TsaTransport;
import java.io.IOException;
import java.io.OutputStream;
import java.math.BigInteger;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.cert.X509Certificate;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Date;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.asn1.x509.Extension;
import org.bouncycastle.asn1.x509.GeneralName;
import org.bouncycastle.asn1.x509.GeneralNames;
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter;
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder;
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.ssl.SslAutoConfiguration;
import org.springframework.boot.http.client.autoconfigure.HttpClientAutoConfiguration;
import org.springframework.boot.http.client.autoconfigure.imperative.ImperativeHttpClientAutoConfiguration;
import org.springframework.boot.restclient.RestClientCustomizer;
import org.springframework.boot.restclient.autoconfigure.RestClientAutoConfiguration;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

/**
 * The timestamp client's HTTP: with Boot's REST client support the transport rides
 * {@code RestClient.Builder}, so a customiser's header reaches the server and {@code datum.pdf.signing.tsa.ssl-bundle}
 * decides whom TLS trusts; without it the JDK's client carries the request (with the same bundle); an application's own
 * {@link TsaTransport} replaces both; and no transport follows a redirect. The servers are the JDK's, on loopback.
 */
class TsaTransportWiringTest {

    @TempDir
    Path dir;

    private HttpServer plain;
    private HttpsServer tls;
    private final Map<String, String> seen = new ConcurrentHashMap<>();
    private TimestampAuthority authority;
    private X509Certificate serverCertificate;
    private Path trusting;
    private Path distrusting;

    @BeforeEach
    void start() throws Exception {
        authority = new TimestampAuthority(TsaKeyMaterial.of(TestAssets.identity("tsa")), null, null, Clock.systemUTC(),
            new InMemoryTsaLog(Clock.systemUTC()));
        plain = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        routes(plain);
        plain.start();

        KeyPair pair = KeyPairGenerator.getInstance("EC").generateKeyPair();
        serverCertificate = localhostCertificate(pair);
        KeyStore serverStore = KeyStore.getInstance("PKCS12");
        serverStore.load(null, null);
        serverStore.setKeyEntry("server", pair.getPrivate(), "pw".toCharArray(), new java.security.cert.Certificate[] {serverCertificate});
        KeyManagerFactory keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        keys.init(serverStore, "pw".toCharArray());
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(keys.getKeyManagers(), null, null);
        tls = HttpsServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        tls.setHttpsConfigurator(new HttpsConfigurator(context));
        routes(tls);
        tls.start();

        // A trust store that holds the server's certificate, and one that holds only somebody else's.
        trusting = trustStore("trusting.p12", serverCertificate);
        KeyPair other = KeyPairGenerator.getInstance("EC").generateKeyPair();
        distrusting = trustStore("distrusting.p12", localhostCertificate(other));
    }

    @AfterEach
    void stop() {
        plain.stop(0);
        tls.stop(0);
    }

    private void routes(HttpServer server) {
        server.createContext("/tsa", exchange -> {
            seen.put("x-observed", String.valueOf(exchange.getRequestHeaders().getFirst("X-Observed")));
            seen.put("content-type", String.valueOf(exchange.getRequestHeaders().getFirst("Content-Type")));
            seen.put("authorization", String.valueOf(exchange.getRequestHeaders().getFirst("Authorization")));
            TimestampReply reply = authority.respond(exchange.getRequestBody().readAllBytes(), null);
            send(exchange, reply.status(), reply.body());
        });
        server.createContext("/policy", exchange -> {
            byte[] query = exchange.getRequestBody().readAllBytes();
            seen.put("policy", String.valueOf(com.argusvane.datum.timestamp.TimestampQuery.parse(query).policy()));
            TimestampReply reply = authority.respond(query, null);
            send(exchange, reply.status(), reply.body());
        });
        server.createContext("/moved", exchange -> {
            seen.put("moved-authorization", String.valueOf(exchange.getRequestHeaders().getFirst("Authorization")));
            exchange.getResponseHeaders().add("Location", "/tsa");
            send(exchange, 302, new byte[0]);
        });
    }

    private static void send(HttpExchange exchange, int status, byte[] body) throws IOException {
        exchange.sendResponseHeaders(status, body.length == 0 ? -1 : body.length);
        if (body.length > 0) {
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        }
        exchange.close();
    }

    private static X509Certificate localhostCertificate(KeyPair pair) throws Exception {
        X500Name name = new X500Name("CN=localhost");
        Instant now = Instant.now();
        JcaX509v3CertificateBuilder builder = new JcaX509v3CertificateBuilder(name, BigInteger.valueOf(System.nanoTime()),
            Date.from(now.minus(Duration.ofDays(1))), Date.from(now.plus(Duration.ofDays(1))), name, pair.getPublic());
        builder.addExtension(Extension.subjectAlternativeName, false, new GeneralNames(new GeneralName[] {
            new GeneralName(GeneralName.dNSName, "localhost"), new GeneralName(GeneralName.iPAddress, "127.0.0.1")}));
        return new JcaX509CertificateConverter().getCertificate(builder.build(new JcaContentSignerBuilder("SHA256withECDSA").build(pair.getPrivate())));
    }

    private Path trustStore(String file, X509Certificate certificate) throws Exception {
        KeyStore store = KeyStore.getInstance("PKCS12");
        store.load(null, null);
        store.setCertificateEntry("anchor", certificate);
        Path path = dir.resolve(file);
        try (OutputStream out = Files.newOutputStream(path)) {
            store.store(out, "changeit".toCharArray());
        }
        return path;
    }

    private static ApplicationContextRunner runner(boolean withRestClient) {
        ApplicationContextRunner runner = new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(SslAutoConfiguration.class, DatumPdfAutoConfiguration.class))
            .withBean(PdfRuntime.class, () -> new ScriptedPdfRuntime().pdfRuntime())
            .withBean(ProgramLimits.class, ProgramLimits::defaults)
            .withUserConfiguration(com.argusvane.datum.pdf.MonitoringRegistries.class);
        return withRestClient ? runner.withConfiguration(AutoConfigurations.of(HttpClientAutoConfiguration.class,
            ImperativeHttpClientAutoConfiguration.class, RestClientAutoConfiguration.class)) : runner;
    }

    private String bundle(String name, Path trustStore) {
        return "spring.ssl.bundle.jks." + name + ".truststore.location=file:" + trustStore;
    }

    private static byte[] stampThrough(TsaTransport transport, String url) {
        return new TimestampClient(URI.create(url), Duration.ofSeconds(5), new TimestampClient.Bearer("sekret"), transport)
            .stamp("a signature value".getBytes(), "sealing");
    }

    @Test
    void aRestClientCustomizerReachesTheTimestampServer() {
        runner(true).withBean(RestClientCustomizer.class, () -> builder -> builder.defaultHeader("X-Observed", "yes"))
            .withPropertyValues("datum.pdf.signing.tsa.url=http://127.0.0.1:" + plain.getAddress().getPort() + "/tsa").run(context -> {
                assertThat(context).hasNotFailed();
                TsaTransport transport = context.getBean(TsaTransport.class);
                assertThat(transport).isInstanceOf(RestClientTsaTransport.class);
                byte[] token = stampThrough(transport, "http://127.0.0.1:" + plain.getAddress().getPort() + "/tsa");
                assertThat(TimestampClient.granted(token)).isTrue();
                assertThat(seen).containsEntry("x-observed", "yes").containsEntry("content-type", "application/timestamp-query")
                    .containsEntry("authorization", "Bearer sekret");
            });
    }

    @Test
    void anSslBundleDecidesWhomTheTimestampServersCertificateMustSatisfy() {
        String url = "https://localhost:" + tls.getAddress().getPort() + "/tsa";
        for (boolean restClient : new boolean[] {true, false}) {
            // The bundle trusts the server: the stamp is granted.
            runner(restClient).withPropertyValues("datum.pdf.signing.tsa.url=" + url, "datum.pdf.signing.tsa.ssl-bundle=ok",
                bundle("ok", trusting), "spring.ssl.bundle.jks.ok.truststore.password=changeit").run(context -> {
                    assertThat(context).hasNotFailed();
                    TsaTransport transport = context.getBean(TsaTransport.class);
                    assertThat(transport).isInstanceOf(restClient ? RestClientTsaTransport.class : JdkTsaTransport.class);
                    assertThat(TimestampClient.granted(stampThrough(transport, url))).as("restClient=" + restClient).isTrue();
                });
            // The bundle trusts somebody else: the TLS handshake fails and so does the stamp.
            runner(restClient).withPropertyValues("datum.pdf.signing.tsa.url=" + url, "datum.pdf.signing.tsa.ssl-bundle=bad",
                bundle("bad", distrusting), "spring.ssl.bundle.jks.bad.truststore.password=changeit").run(context -> {
                    assertThat(context).hasNotFailed();
                    TsaTransport transport = context.getBean(TsaTransport.class);
                    assertThatThrownBy(() -> stampThrough(transport, url)).as("restClient=" + restClient)
                        .isInstanceOf(TimestampClientException.class).hasMessageStartingWith("No timestamp from " + url);
                });
        }
    }

    @Test
    void anUnknownSslBundleStopsTheStartNamingTheProperty() {
        runner(true).withPropertyValues("datum.pdf.signing.tsa.url=https://tsa.example/tsa", "datum.pdf.signing.tsa.ssl-bundle=nowhere")
            .run(context -> assertThat(context).hasFailed().getFailure().hasStackTraceContaining("datum.pdf.signing.tsa.ssl-bundle"));
    }

    @Test
    void noTransportFollowsARedirect() {
        for (boolean restClient : new boolean[] {true, false}) {
            runner(restClient).withPropertyValues("datum.pdf.signing.tsa.url=http://127.0.0.1:" + plain.getAddress().getPort() + "/moved",
                "spring.http.client.redirects=follow").run(context -> {
                    TsaTransport transport = context.getBean(TsaTransport.class);
                    seen.clear();
                    assertThatThrownBy(() -> stampThrough(transport, "http://127.0.0.1:" + plain.getAddress().getPort() + "/moved"))
                        .as("restClient=" + restClient).isInstanceOf(TimestampClientException.class).hasMessageContaining("it answered HTTP 302");
                    // The credential went to the URL named, and the redirect target never saw a request.
                    assertThat(seen).containsEntry("moved-authorization", "Bearer sekret").doesNotContainKey("authorization");
                });
        }
    }

    @Test
    void anApplicationTransportReplacesBoth() {
        TsaTransport mine = (url, query, headers, timeout) -> new TsaTransport.Reply(503, null, new byte[0]);
        runner(true).withBean(TsaTransport.class, () -> mine).withPropertyValues("datum.pdf.signing.tsa.url=http://127.0.0.1:1/tsa")
            .run(context -> assertThat(context.getBean(TsaTransport.class)).isSameAs(mine));
    }

    /** The JDK client carries the request when the REST client's classes are not on the class path, and the report says so. */
    @Test
    void withoutSpringWebsRestClientClassTheJdkTransportIsChosen() {
        runner(true).withClassLoader(new org.springframework.boot.test.context.FilteredClassLoader(org.springframework.web.client.RestClient.class))
            .withPropertyValues("datum.pdf.signing.tsa.url=http://127.0.0.1:" + plain.getAddress().getPort() + "/tsa").run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(context.getBean(TsaTransport.class)).isInstanceOf(JdkTsaTransport.class);
                assertThat(TimestampClient.granted(stampThrough(context.getBean(TsaTransport.class),
                    "http://127.0.0.1:" + plain.getAddress().getPort() + "/tsa"))).isTrue();
            });
    }

    @Test
    void withoutBootsRequestFactoryBuilderTheJdkTransportIsChosen() {
        runner(true).withClassLoader(new org.springframework.boot.test.context.FilteredClassLoader(
                org.springframework.boot.http.client.ClientHttpRequestFactoryBuilder.class))
            .withPropertyValues("datum.pdf.signing.tsa.url=http://127.0.0.1:" + plain.getAddress().getPort() + "/tsa")
            .run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(context.getBean(TsaTransport.class)).isInstanceOf(JdkTsaTransport.class);
            });
    }

    /** No RestClient.Builder bean (a reactive application that did not opt in): the JDK client, not a failed start. */
    @Test
    void withoutARestClientBuilderBeanTheJdkTransportIsChosen() {
        runner(false).withPropertyValues("datum.pdf.signing.tsa.url=http://127.0.0.1:1/tsa")
            .run(context -> assertThat(context.getBean(TsaTransport.class)).isInstanceOf(JdkTsaTransport.class));
    }

    @Test
    void withoutATimestampServerNamedThereIsNoTransport() {
        runner(true).run(context -> assertThat(context).doesNotHaveBean(TsaTransport.class));
    }

    /** A reactive application has no Boot-configured RestClient.Builder: its own bean opts in, and the factory is detected. */
    @Test
    void anApplicationsOwnRestClientBuilderCarriesTheRequestWhereBootConfiguresNone() {
        String url = "https://localhost:" + tls.getAddress().getPort() + "/tsa";
        runner(false).withBean(org.springframework.web.client.RestClient.Builder.class,
                () -> org.springframework.web.client.RestClient.builder().defaultHeader("X-Observed", "mine"),
                definition -> definition.setScope("prototype"))
            .withPropertyValues("datum.pdf.signing.tsa.url=" + url, "datum.pdf.signing.tsa.ssl-bundle=ok", bundle("ok", trusting),
                "spring.ssl.bundle.jks.ok.truststore.password=changeit").run(context -> {
                    assertThat(context).hasNotFailed();
                    TsaTransport transport = context.getBean(TsaTransport.class);
                    assertThat(transport).isInstanceOf(RestClientTsaTransport.class);
                    assertThat(TimestampClient.granted(stampThrough(transport, url))).isTrue();
                    assertThat(seen).containsEntry("x-observed", "mine");
                });
    }

    /**
     * The call runs on a transport thread of its own that carries the caller's MDC and current observation, so
     * RestClient's {@code http.client.requests} observation of the call is a child of the seal that asked (under the HTTP
     * request's trace) instead of a trace of its own, and an application's {@code TaskDecorator} bean runs around it.
     */
    @Test
    void theCallCarriesTheCallersMdcAndObservationToItsThread() {
        com.argusvane.datum.core.observation.RecordingObservations recording = new com.argusvane.datum.core.observation.RecordingObservations();
        Map<String, String> onTheWire = new ConcurrentHashMap<>();
        java.util.concurrent.atomic.AtomicInteger decorated = new java.util.concurrent.atomic.AtomicInteger();
        String url = "http://127.0.0.1:" + plain.getAddress().getPort() + "/tsa";
        runner(true).withBean(io.micrometer.observation.ObservationRegistry.class, recording::registry)
            .withBean(RestClientCustomizer.class, () -> builder -> builder.observationRegistry(recording.registry())
                .requestInterceptor((request, body, execution) -> {
                    onTheWire.put("thread", Thread.currentThread().getName());
                    onTheWire.put("mdc", String.valueOf(org.slf4j.MDC.get("requestId")));
                    return execution.execute(request, body);
                }))
            .withBean(org.springframework.core.task.TaskDecorator.class, () -> runnable -> {
                decorated.incrementAndGet();
                return runnable;
            })
            .withPropertyValues("datum.pdf.signing.tsa.url=" + url).run(context -> {
                assertThat(context).hasNotFailed();
                TsaTransport transport = context.getBean(TsaTransport.class);
                io.micrometer.observation.Observation seal = io.micrometer.observation.Observation.start("datum.pdf", recording.registry());
                org.slf4j.MDC.put("requestId", "r-7");
                try (io.micrometer.observation.Observation.Scope ignored = seal.openScope()) {
                    assertThat(TimestampClient.granted(stampThrough(transport, url))).isTrue();
                } finally {
                    org.slf4j.MDC.remove("requestId");
                    seal.stop();
                }
                assertThat(onTheWire.get("thread")).startsWith("datum-tsa-transport-").isNotEqualTo(Thread.currentThread().getName());
                assertThat(onTheWire).containsEntry("mdc", "r-7");
                assertThat(recording.named("http.client.requests")).singleElement()
                    .satisfies(call -> assertThat(call.parent()).as("a child of the seal, not a trace of its own").isEqualTo("datum.pdf"));
                assertThat(decorated).as("the application's TaskDecorator ran").hasValue(1);
            });
    }

    /**
     * Spring Boot's executor builder gives the thread (virtual threads under spring.threads.virtual.enabled),
     * and Datum's deadline contract is re-applied after its settings: a concurrency limit an application set for its own
     * simple executors never makes a TSA call queue behind another.
     */
    @Test
    void bootsExecutorBuilderGivesTheThreadAndNoLimitHoldsACallBack() throws Exception {
        org.springframework.core.task.SimpleAsyncTaskExecutor limited = DatumPdfAutoConfiguration.TsaTransportConfiguration.transportExecutor(
            new org.springframework.boot.task.SimpleAsyncTaskExecutorBuilder().concurrencyLimit(1).threadNamePrefix("app-"), java.util.List.of(), null);
        assertThat(limited.getConcurrencyLimit()).isEqualTo(org.springframework.util.ConcurrencyThrottleSupport.UNBOUNDED_CONCURRENCY);
        assertThat(limited.getThreadNamePrefix()).isEqualTo("datum-tsa-transport-");
        assertThat(limited.isDaemon()).isTrue();
        java.util.concurrent.CountDownLatch both = new java.util.concurrent.CountDownLatch(2);
        java.util.concurrent.CountDownLatch release = new java.util.concurrent.CountDownLatch(1);
        for (int i = 0; i < 2; i++) {
            limited.execute(() -> {
                both.countDown();
                try {
                    release.await();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            });
        }
        assertThat(both.await(5, java.util.concurrent.TimeUnit.SECONDS)).as("two calls at once, neither queued").isTrue();
        release.countDown();

        // Virtual threads exist from JDK 21 (the libraries also run on 17).
        org.junit.jupiter.api.Assumptions.assumeTrue(Runtime.version().feature() >= 21, "virtual threads need JDK 21");
        org.springframework.core.task.SimpleAsyncTaskExecutor virtual = DatumPdfAutoConfiguration.TsaTransportConfiguration.transportExecutor(
            new org.springframework.boot.task.SimpleAsyncTaskExecutorBuilder().virtualThreads(true), java.util.List.of(), null);
        java.util.concurrent.CompletableFuture<Boolean> isVirtual = new java.util.concurrent.CompletableFuture<>();
        virtual.execute(() -> isVirtual.complete(Thread.currentThread().getClass().getName().contains("Virtual")));
        assertThat(isVirtual.get(5, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
    }

    /**
     * A server that takes the connection and never answers: the call fails at the TSA timeout, and the factory's read
     * timeout (set from that timeout by the binding) ends the worker thread, so stalled servers cannot pile up threads or
     * pooled connections.
     */
    @Test
    void aStalledTimestampServerEndsTheWorkerThreadShortlyAfterTheDeadline() throws Exception {
        try (java.net.ServerSocket stall = new java.net.ServerSocket(0, 50, InetAddress.getLoopbackAddress())) {
            java.util.List<java.net.Socket> held = new java.util.concurrent.CopyOnWriteArrayList<>();
            Thread acceptor = new Thread(() -> {
                try {
                    while (true) {
                        held.add(stall.accept());
                    }
                } catch (IOException ignored) {
                    // closed at the end of the test
                }
            });
            acceptor.setDaemon(true);
            acceptor.start();
            String url = "http://127.0.0.1:" + stall.getLocalPort() + "/tsa";
            for (String factory : new String[] {"", "spring.http.client.factory=simple", "spring.http.client.factory=jdk",
                "spring.http.client.read-timeout=60s"}) {
                runner(true).withPropertyValues("datum.pdf.signing.tsa.url=" + url, "datum.pdf.signing.tsa.timeout=1s", factory.isEmpty() ? "x=y" : factory)
                    .run(context -> {
                        TsaTransport transport = context.getBean(TsaTransport.class);
                        assertThatThrownBy(() -> stampThrough(transport, url)).as(factory).isInstanceOf(TimestampClientException.class);
                        long end = System.nanoTime() + Duration.ofSeconds(6).toNanos();
                        while (workers() > 0 && System.nanoTime() < end) {
                            Thread.sleep(50);
                        }
                        assertThat(workers()).as("worker threads left after " + factory).isZero();
                    });
            }
            held.forEach(socket -> {
                try {
                    socket.close();
                } catch (IOException ignored) {
                    // best effort
                }
            });
        }
    }

    private static long workers() {
        return Thread.getAllStackTraces().keySet().stream().filter(t -> t.getName().startsWith("datum-tsa-transport") && t.isAlive()).count();
    }

    @Test
    void aTimeoutUnderASecondStopsTheStartNamingTheProperty() {
        runner(false).withPropertyValues("datum.pdf.signing.tsa.url=http://127.0.0.1:1/tsa", "datum.pdf.signing.tsa.timeout=500ms")
            .run(context -> assertThat(context).hasFailed().getFailure().hasStackTraceContaining("datum.pdf.signing.tsa.timeout"));
    }

    /** {@code datum.pdf.signing.tsa.policy} on the wire: the server sees the reqPolicy the property names (and none when unset). */
    @Test
    void theConfiguredPolicyIsOnTheRequestTheServerSees() {
        String url = "http://127.0.0.1:" + plain.getAddress().getPort() + "/policy";
        runner(false).withPropertyValues("datum.pdf.signing.tsa.url=" + url, "datum.pdf.signing.tsa.policy=" + TimestampAuthority.DEFAULT_POLICY).run(context -> {
            assertThat(context).hasNotFailed();
            TimestampClient client = (TimestampClient) org.springframework.test.util.ReflectionTestUtils.getField(
                context.getBean(com.argusvane.datum.pdf.PdfService.class), "timestamper");
            assertThat(TimestampClient.granted(client.stamp("a signature value".getBytes(), "sealing"))).isTrue();
            assertThat(seen).containsEntry("policy", TimestampAuthority.DEFAULT_POLICY);
        });
        runner(false).withPropertyValues("datum.pdf.signing.tsa.url=" + url).run(context -> {
            TimestampClient client = (TimestampClient) org.springframework.test.util.ReflectionTestUtils.getField(
                context.getBean(com.argusvane.datum.pdf.PdfService.class), "timestamper");
            client.stamp("a signature value".getBytes(), "sealing");
            assertThat(seen).containsEntry("policy", "null");
        });
    }
}
