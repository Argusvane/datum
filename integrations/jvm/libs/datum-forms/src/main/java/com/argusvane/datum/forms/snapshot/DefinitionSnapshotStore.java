package com.argusvane.datum.forms.snapshot;

import java.util.Optional;
import tools.jackson.databind.node.ObjectNode;

/**
 * Every definition a form has had, by its hash (the shared SQL's V100 {@code datum_definition_snapshot} table): a
 * submission's {@code definitionSha256} must always resolve to the exact schema it was judged against, for
 * re-validation, amendment and export, after the form has moved on.
 *
 * <p>{@link #record} is idempotent: recording a hash twice changes nothing. Implementations must be safe to
 * call from several threads.
 */
public interface DefinitionSnapshotStore {

    /** Remembers the definition under {@code (key, sha256)} unless it is already there. */
    void record(String key, String sha256, ObjectNode definition);

    /** The definition recorded under the hash, or empty. A copy a caller may change. */
    Optional<ObjectNode> find(String key, String sha256);
}
