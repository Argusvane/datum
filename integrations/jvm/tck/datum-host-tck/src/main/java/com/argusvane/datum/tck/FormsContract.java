package com.argusvane.datum.tck;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;

/**
 * The definition reads of the fixture form: the public copy (never the server-secret rule) under the plain key and
 * the catalog key {@code id@version} (as the security suite's SEC-02 asks), its {@code ETag} and the 304 it earns,
 * and 404 {@code form.notFound} for a version that is not current and for a form that does not exist. With the builder off
 * ({@link HostTarget#builderEnabled()} false) the author's copy, {@code ?public=false}, is not served: 404, never the
 * server-secret rule.
 */
public interface FormsContract extends HostContract {

    private String definition(String key) {
        return target().api("/forms/" + key + "/definition");
    }

    @Test
    @Order(1201)
    default void thePublicCopyOfTheFormAnswers200WithoutTheServerSecretRule() {
        String form = TckFixtures.FORM;
        for (String key : new String[] {form + "%40" + TckFixtures.VERSION, form, form + "@" + TckFixtures.VERSION}) {
            Reply reply = http().get(definition(key));
            assertThat(reply.status()).as(key + " " + reply).isEqualTo(200);
            assertThat(reply.mediaType()).endsWith("json");
            assertThat(reply.text()).as(key).doesNotContain("server-secret").doesNotContain(TckFixtures.SECRET_MARKER);
            assertThat(reply.json().path("id").asString()).isEqualTo(form);
        }
        Reply otherVersion = http().get(definition(form + "%402"));
        assertThat(otherVersion.status()).as(otherVersion.toString()).isEqualTo(404);
        assertThat(otherVersion.code()).isEqualTo("form.notFound");
    }

    @Test
    @Order(1202)
    default void theDefinitionCarriesAnETagThatEarnsA304() {
        Reply reply = http().get(definition(TckFixtures.FORM));
        assertThat(reply.status()).isEqualTo(200);
        String etag = reply.header("ETag").orElseThrow(() -> new AssertionError("no ETag: " + reply.headers().map()));
        assertThat(etag).matches("\"[0-9a-f]{64}\"");
        Reply again = http().get(definition(TckFixtures.FORM), HostTarget.Who.VISITOR, Map.of("If-None-Match", etag));
        assertThat(again.status()).as(again.toString()).isEqualTo(304);
        assertThat(again.header("ETag")).hasValue(etag);
        assertThat(again.body()).isEmpty();
    }

    @Test
    @Order(1203)
    default void aFormThatDoesNotExistIs404() {
        Reply reply = http().get(definition("datum-tck-no-such-form"));
        assertThat(reply.status()).as(reply.toString()).isEqualTo(404);
        assertThat(reply.code()).isEqualTo("form.notFound");
    }

    @Test
    @Order(1204)
    default void theAuthorsCopyIsNotServedWithTheBuilderOff() {
        Assumptions.assumeFalse(target().builderEnabled(), "the builder is on: the builder contract reads the author's copy");
        for (String key : new String[] {TckFixtures.FORM, TckFixtures.FORM + "@" + TckFixtures.VERSION, "datum-tck-no-such-form"}) {
            Reply reply = http().get(definition(key) + "?public=false");
            assertThat(reply.status()).as(key + " " + reply).isEqualTo(404);
            assertThat(reply.text()).as(key).doesNotContain(TckFixtures.SECRET_MARKER).doesNotContain("server-secret");
            assertThat(reply.header("ETag")).as(key).isEmpty();
        }
    }
}
