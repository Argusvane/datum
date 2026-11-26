package com.argusvane.datum.tck;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * {@code datum.tck.csrf=cookie:<cookie>:<header>}: the Java kit's CLI follows the Node kit's {@code --csrf} recipe, so a
 * host that guards its writes with Spring Security's cookie token can be judged by {@code HostTck}. The host here is a JDK server
 * that hands each caller (a caller is whoever sends the same {@code X-Person} header) its own token cookie on a GET and refuses a
 * POST that does not echo that caller's token as the header and the cookie.
 */
class CsrfRecipeTest {

    private HttpServer server;
    private final AtomicInteger issued = new AtomicInteger();
    private final java.util.Map<String, String> tokenOfCaller = new java.util.concurrent.ConcurrentHashMap<>();

    @BeforeEach
    void host() throws IOException {
        server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        server.createContext("/", exchange -> {
            String caller = exchange.getRequestHeaders().getFirst("X-Person") == null ? "visitor" : exchange.getRequestHeaders().getFirst("X-Person");
            int status = 200;
            if (exchange.getRequestMethod().equals("GET")) {
                String token = tokenOfCaller.computeIfAbsent(caller, key -> "tok" + issued.incrementAndGet());
                exchange.getResponseHeaders().add("Set-Cookie", "XSRF-TOKEN=" + token + "; Path=/; SameSite=Lax");
            } else {
                String token = tokenOfCaller.get(caller);
                String header = exchange.getRequestHeaders().getFirst("X-XSRF-TOKEN");
                String cookie = String.join(";", exchange.getRequestHeaders().getOrDefault("Cookie", List.of()));
                status = token != null && token.equals(header) && cookie.contains("XSRF-TOKEN=" + token) ? 200 : 403;
            }
            byte[] body = "{}".getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(status, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
    }

    @AfterEach
    void stop() {
        server.stop(0);
    }

    private HostTarget target(String csrf) {
        Properties properties = new Properties();
        properties.setProperty("datum.tck.base-url", "http://127.0.0.1:" + server.getAddress().getPort());
        properties.setProperty("datum.tck.capabilities", "submissions");
        properties.setProperty("datum.tck.person.header.X-Person", "ada");
        properties.setProperty("datum.tck.other-person.header.X-Person", "grace");
        if (csrf != null) {
            properties.setProperty("datum.tck.csrf", csrf);
        }
        return HostTck.target(properties);
    }

    @Test
    void withoutTheRecipeAWriteIsRefusedByTheHost() {
        assertThat(new HostHttp(target(null)).postJson("/anything", "{}").status()).isEqualTo(403);
    }

    @Test
    void theRecipeFetchesTheTokenOnceAndEchoesItOnEveryWrite() {
        HostHttp http = new HostHttp(target("cookie:XSRF-TOKEN:X-XSRF-TOKEN"));
        // The first write finds no token held, reads the cookie of GET <base>/, and echoes it as the header and the cookie.
        assertThat(http.postJson("/anything", "{}").status()).isEqualTo(200);
        assertThat(http.postJson("/anything", "{}").status()).isEqualTo(200);
        assertThat(issued.get()).as("one token for the visitor").isEqualTo(1);
    }

    @Test
    void eachPersonHasATokenOfHisOwn() {
        HostTarget target = target("cookie:XSRF-TOKEN:X-XSRF-TOKEN");
        HostHttp http = new HostHttp(target);
        assertThat(http.send("POST", "/a", "application/json", "{}".getBytes(StandardCharsets.UTF_8), HostTarget.Who.PERSON, Map.of()).status())
            .isEqualTo(200);
        assertThat(http.send("POST", "/a", "application/json", "{}".getBytes(StandardCharsets.UTF_8), HostTarget.Who.OTHER_PERSON, Map.of())
            .status()).isEqualTo(200);
        assertThat(issued.get()).isEqualTo(2);
        assertThat(target.csrf().token(HostTarget.Who.PERSON)).isNotEqualTo(target.csrf().token(HostTarget.Who.OTHER_PERSON));
    }

    @Test
    void aTokenAnEarlierReplySetIsTheOneEchoed() {
        HostTarget target = target("cookie:XSRF-TOKEN:X-XSRF-TOKEN");
        HostHttp http = new HostHttp(target);
        http.get("/page");
        assertThat(target.csrf().token(HostTarget.Who.VISITOR)).isEqualTo("tok1");
        assertThat(http.postJson("/anything", "{}").status()).isEqualTo(200);
        assertThat(issued.get()).as("no second fetch").isEqualTo(1);
    }

    @Test
    void aHostThatHandsOutNoTokenIsNamedInTheFailure() {
        server.removeContext("/");
        server.createContext("/", exchange -> {
            exchange.sendResponseHeaders(200, -1);
            exchange.close();
        });
        assertThatThrownBy(() -> new HostHttp(target("cookie:XSRF-TOKEN:X-XSRF-TOKEN")).postJson("/anything", "{}"))
            .isInstanceOf(AssertionError.class).hasMessageContaining("no XSRF-TOKEN cookie on GET");
    }

    @Test
    void theRecipeIsRefusedWhenItIsNotCookieColonNameColonHeader() {
        for (String bad : List.of("header:X:Y", "cookie:XSRF-TOKEN", "cookie:A B:C", "cookie:A:B:C", "XSRF-TOKEN")) {
            assertThatThrownBy(() -> target(bad)).as(bad).isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("datum.tck.csrf takes cookie:<cookie-name>:<header-name>");
        }
    }
}
