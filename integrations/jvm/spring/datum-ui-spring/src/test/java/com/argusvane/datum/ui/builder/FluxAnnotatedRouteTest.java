package com.argusvane.datum.ui.builder;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Import;

/**
 * On WebFlux an application's annotated controller on a builder path
 * is reached, because Datum's 405 answer is a handler mapping ordered after the controllers and router functions,
 * not a path-wide router route (router functions are consulted before annotated controllers, so such a route took the
 * path away). Its own test class: an annotated mapping on a path also makes Spring answer its own 405 (naming only
 * its methods) for the other methods, which the shared contract's Allow assertions do not expect.
 */
@SpringBootTest(classes = BuilderTestApp.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
    "spring.main.web-application-type=reactive",
    "datum.builder.enabled=true", "datum.web.api.endpoints.definition=true"})
@Import(AppPatchController.class)
class FluxAnnotatedRouteTest {

    @LocalServerPort
    int port;

    @Test
    void anAnnotatedControllerOnABuilderPathIsTheApplicationsOwn() {
        Http.Reply patched = Http.server(port, "PATCH", BuilderWebContract.FORM, null);
        assertThat(patched.status()).isEqualTo(204);
        assertThat(patched.header("X-App")).isEqualTo("patched");
    }

    @Test
    void theBuildersOwnRoutesStillAnswerBesideIt() {
        assertThat(Http.server(port, "PUT", BuilderWebContract.FORM, new byte[0], "Content-Type", "application/json").status())
            .as("the save route is reached (a refusal of the empty body, not a 405)").isNotEqualTo(405);
        assertThat(Http.server(port, "GET", BuilderWebContract.FORM + "/translations", null).status()).isEqualTo(200);
    }
}
