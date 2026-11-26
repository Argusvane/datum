package com.argusvane.datum.forms.web;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.forms.DefinitionService;
import org.junit.jupiter.api.Test;

/**
 * The application's {@code DefinitionCustomizer} beans on the wire, the same on both stacks: collected in their
 * {@code @Order}, handed the framework's locale, a refusal answered by its kind with the errors body, a throwing customizer
 * a 500, the author's copy untouched.
 */
public abstract class DefinitionCustomizerContract {

    protected abstract Reply get(String path, String... headers);

    /**
     * The locale the stack hands a customizer for a request with no {@code Accept-Language}: the servlet request's locale
     * on MVC (the JVM default on a container, {@code en} on MockMvc's request), the JVM default on WebFlux (whose default
     * resolver answers none, which the handler replaces). Never null on either stack.
     */
    protected abstract java.util.Locale noHeaderLocale();

    @Test
    void aRequestWithNoAcceptLanguageHandsTheCustomizerTheStacksDefaultLocaleNeverNone() {
        // WebFlux's resolver answers null here, so a customizer branching on the locale would serve the
        // same request two copies (and two ETags) on the two stacks.
        Reply reply = get("/api/forms/endpoint/definition");

        assertThat(reply.status()).as(reply.text()).isEqualTo(200);
        assertThat(reply.json().get("locale").asString()).isNotEmpty().isEqualTo(noHeaderLocale().toLanguageTag());
    }

    @Test
    void theCustomizersRunInTheirOrderWithTheFrameworksLocaleAndTheTagNamesWhatWasServed() {
        Reply reply = get("/api/forms/endpoint/definition", "Accept-Language", "fr-CA");

        assertThat(reply.status()).as(reply.text()).isEqualTo(200);
        assertThat(reply.json().get("stamp").asString()).isEqualTo("first,second");
        assertThat(reply.json().get("locale").asString()).isEqualTo("fr-CA");
        assertThat(reply.text()).doesNotContain("server-secret");
        assertThat(reply.headers().getFirst("ETag")).isEqualTo("\"" + DefinitionService.hash(reply.json()) + "\"");

        Reply full = get("/api/forms/endpoint/definition?public=false", "Accept-Language", "fr-CA");
        assertThat(full.json().has("stamp")).as("the author's copy is never customized").isFalse();
    }

    @Test
    void aRefusalIsItsKindsStatusWithTheErrorsBodyAndAThrowingCustomizerIsA500() {
        Reply refused = get("/api/forms/endpoint/definition", "Accept-Language", "xx");
        assertThat(refused.status()).isEqualTo(403);
        assertThat(refused.code()).isEqualTo("tenant.closed");
        assertThat(refused.json().get("errors").get(0).get("message").asString()).isEqualTo("This form is closed for your organization.");

        Reply failed = get("/api/forms/endpoint/definition", "Accept-Language", "yy");
        assertThat(failed.status()).isEqualTo(500);
        assertThat(failed.code()).isEqualTo("internal");
        assertThat(failed.text()).doesNotContain("tenant directory");
    }
}
