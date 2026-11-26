package com.argusvane.datum.forms.web;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/**
 * The definition route on, the builder off: {@code ?public=false} answers as a route the host does not serve (404, no
 * body, no {@code form.notFound}), for a form that exists and one that does not, even for a caller the chain admits to the
 * builder's reads, and the server-secret rule is never in an answer; the refusal carries the definition answers'
 * {@code Cache-Control} ({@code no-store} by default). The public copy is served as before.
 */
public abstract class AuthorCopyWithheldContract {

    protected abstract Reply get(String path, String... headers);

    @Test
    void publicFalseIsNotServedWithTheBuilderOff() {
        for (String path : new String[] {"/api/forms/endpoint/definition?public=false", "/api/forms/endpoint@1/definition?public=false",
            "/api/forms/nope/definition?public=false", "/api/forms/endpoint/definition?public=false&sha256=" + FormsWebContract.FULL_SHA}) {
            Reply reply = get(path);
            assertThat(reply.status()).as(path).isEqualTo(404);
            assertThat(reply.text()).as(path).doesNotContain("server-secret", "ZZSECRETZZ", "form.notFound");
            assertThat(reply.headers().getFirst("ETag")).as(path).isNull();
            assertThat(reply.headers().getFirst("Cache-Control")).as(path + ": the definition answers' header").isEqualTo("no-store");
        }
        Reply publicCopy = get("/api/forms/endpoint/definition");
        assertThat(publicCopy.status()).isEqualTo(200);
        assertThat(publicCopy.text()).doesNotContain("server-secret");
        // The chain still runs first: a caller refused the builder's reads is refused before the gate.
        assertThat(get("/api/forms/endpoint/definition?public=false", "X-Deny", "build").status()).isEqualTo(403);
        // A value that is neither true nor false is the caller's 400, as with the builder on.
        assertThat(get("/api/forms/endpoint/definition?public=maybe").status()).isEqualTo(400);
    }
}
