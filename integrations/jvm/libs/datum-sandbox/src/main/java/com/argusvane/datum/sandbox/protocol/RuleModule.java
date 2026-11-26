package com.argusvane.datum.sandbox.protocol;

import java.util.Objects;

/**
 * A rule module registered before a run: an ES2020 program whose completion value is
 * {@code { validators: [...] }}, with the id and version that label it in {@code run.js}.
 *
 * <p>Rule modules are host-trusted code: they come from the host's own configuration, never from a
 * request. What a module can still do is bounded by the frame, the nonce and the runtime's limits.
 */
public record RuleModule(String id, String version, String source) {

    public RuleModule {
        Objects.requireNonNull(id, "id");
        Objects.requireNonNull(version, "version");
        Objects.requireNonNull(source, "source");
    }
}
