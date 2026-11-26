package com.argusvane.datum.ui.builder;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.ApplicationContext;

/**
 * With {@code datum.builder.enabled} left off, the write endpoints do not exist: nothing is mapped, no body is read,
 * nothing is stored, and the {@code datum-ui} group is absent. The paths answer as the application leaves them:
 * 404, or 405 beside the forms module's GET of the translations.
 */
public abstract class BuilderOffContract {

    @Autowired
    protected MemoryRepository repository;

    @Autowired
    protected ApplicationContext context;

    protected abstract Http.Reply send(String method, String path, byte[] body, String... headers);

    @Test
    void theWritesAreNotMapped() {
        byte[] body = BuilderWebContract.bytes(BuilderFixtures.base());
        assertThat(send("PUT", BuilderWebContract.FORM, body, "Content-Type", "application/json").status()).isEqualTo(404);
        assertThat(send("POST", "/api/forms", body, "Content-Type", "application/json").status()).isEqualTo(404);
        assertThat(send("PUT", BuilderWebContract.FORM + "/translations", "{}".getBytes(), "Content-Type", "application/json").status())
            .isIn(404, 405);
        assertThat(repository.saves()).isZero();
        assertThat(context.getBeanNamesForType(BuilderApi.class)).isEmpty();
        assertThat(send("GET", "/v3/api-docs/datum-ui", null).status()).isEqualTo(404);
    }

    /**
     * The author's copy is the builder's read: with the builder off and the definition route on, {@code public=false}
     * answers as a route the host does not serve (404, no body), while the route itself is mapped (a bad value is its 400).
     */
    @Test
    void theAuthorsCopyIsNotServed() {
        assertThat(context.getBeanNamesForType(com.argusvane.datum.forms.web.AuthorCopy.class)).isEmpty();
        Http.Reply full = send("GET", BuilderWebContract.FORM + "/definition?public=false", null);
        assertThat(full.status()).isEqualTo(404);
        assertThat(full.header("ETag")).isNull();
        assertThat(full.body() == null ? new byte[0] : full.body()).isEmpty();
        assertThat(send("GET", BuilderWebContract.FORM + "/definition?public=maybe", null).status()).isEqualTo(400);
    }
}
