package com.argusvane.datum.ui.builder;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/**
 * With {@code datum.web.api.path=/v2} the writes move with the reads, on both stacks, and the {@code datum-ui}
 * document names the paths that exist (WebFlux operations are annotated at /api and rebased).
 */
public abstract class BuilderPathContract {

    @Autowired
    protected MemoryRepository repository;

    protected abstract Http.Reply send(String method, String path, byte[] body, String... headers);

    @Test
    void theWritesFollowTheApiPath() {
        repository.clear();
        repository.seed(BuilderFixtures.base());
        byte[] body = BuilderWebContract.bytes(BuilderFixtures.base());
        assertThat(send("PUT", "/v2/forms/" + BuilderFixtures.KEY, body, "Content-Type", "application/json").status()).isEqualTo(200);
        assertThat(send("PUT", "/api/forms/" + BuilderFixtures.KEY, body, "Content-Type", "application/json").status()).isEqualTo(404);
        var paths = send("GET", "/v3/api-docs/datum-ui", null).json().get("paths");
        assertThat(paths.has("/v2/forms/{key}")).isTrue();
        assertThat(paths.has("/v2/forms")).isTrue();
        assertThat(paths.has("/api/forms/{key}")).isFalse();
    }
}
