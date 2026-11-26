package com.argusvane.datum.examples.passkeys;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.springweb.mvc.DatumRequestMatchers;
import com.argusvane.datum.webauthn.PasskeySettings;
import com.argusvane.datum.webauthn.spring.DatumWebAuthnProperties;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Bean;
import org.springframework.mock.web.MockHttpServletRequest;

/**
 * An application's own {@link PasskeySettings} bean moves the passkey routes, and the {@link DatumRequestMatchers} this
 * application's Spring Security chain is built with follow them (end to end through the real passkey binding
 * and Spring Security's own matchers): {@code passkeys()} and {@code all()} name the base the binding mapped, not
 * {@code datum.webauthn.path}, so a rule on {@code datum.passkeys()} meets the routes rather than {@code anyRequest()}.
 * The wire shows only that the routes moved: this example permits both its passkey rule and {@code anyRequest()}, and a
 * single {@code defaultAccessDeniedHandlerFor} is Spring Security's handler for every request, so no answer here tells a
 * matched route from a missed one; the matcher assertions are the proof (they fail with the bindings' base ignored).
 */
@Tag("real-runtime")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {"datum.webauthn.origins=http://localhost",
    "datum.webauthn.path=/api/webauthn"})
class MovedPasskeyRoutesIT {

    /** The properties' settings with the routes under /keys, as a tenant store might choose. */
    @TestConfiguration(proxyBeanMethods = false)
    static class MovedRoutes {

        @Bean
        PasskeySettings applicationPasskeySettings(DatumWebAuthnProperties properties) {
            PasskeySettings s = properties.toSettings();
            return new PasskeySettings(s.enabled(), s.rpId(), s.rpName(), s.origins(), s.anonymous(), s.registerAtSubmit(), s.window(),
                s.challengeTtl(), "/keys", s.passkeys(), s.secret(), s.labelPath(), s.keepYears(), s.siteSigning(), s.forms(),
                s.allowMemoryStores(), s.residentKey(), s.challengeSkew(), s.signedAtSkew(), s.anonymousGrace());
        }
    }

    @LocalServerPort
    int port;

    @Autowired
    DatumRequestMatchers datum;

    private final HttpClient client = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build();

    private HttpResponse<String> send(String method, String path, String body) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://localhost:" + port + path)).header("Accept", "application/json");
        if (body != null) {
            request.header("Content-Type", "application/json");
        }
        request.method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8));
        return client.send(request.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    @Test
    void theMatchersFollowTheBeansBaseNotTheProperty() {
        assertThat(datum.passkeys().matches(new MockHttpServletRequest("POST", "/keys/challenge"))).isTrue();
        assertThat(datum.all().matches(new MockHttpServletRequest("POST", "/keys/register"))).isTrue();
        assertThat(datum.passkeys().matches(new MockHttpServletRequest("POST", "/api/webauthn/challenge")))
            .as("the property is not where the routes are").isFalse();
    }

    @Test
    void theRoutesAreMappedUnderTheBeansBase() throws Exception {
        assertThat(send("GET", "/keys/passkeys?form=petition", null).statusCode()).as("the routes are mapped under the bean's base").isEqualTo(200);
        assertThat(send("GET", "/api/webauthn/passkeys?form=petition", null).statusCode()).as("and not under the property's").isEqualTo(404);
    }
}
