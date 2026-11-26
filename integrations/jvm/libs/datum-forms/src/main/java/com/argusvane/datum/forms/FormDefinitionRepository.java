package com.argusvane.datum.forms;

import com.argusvane.datum.core.canonical.CanonicalJson;
import java.util.Optional;
import tools.jackson.databind.node.ObjectNode;

/**
 * Where form definitions live. The application decides: the shipped {@link ResourceFormDefinitionRepository}
 * reads classpath or file resources and is read-only; an application with a database or a git checkout
 * provides its own bean.
 *
 * <p>Implementations return copies a caller may change, and are safe to call from several threads.
 */
public interface FormDefinitionRepository {

    /** The stored definition, or empty when no form has the key. */
    Optional<ObjectNode> find(String key);

    /**
     * Stores a definition under its {@code id}.
     *
     * @return the key and the hash of what was stored
     * @throws FormStoreReadOnlyException when this repository cannot save (501)
     */
    SavedForm save(ObjectNode definition);

    /**
     * Stores a definition that builds on a known version: the conditional save a database repository uses to
     * refuse a write across instances. The builder checks {@code If-Match} under a lock of its own, which
     * closes the race inside one JVM only; two instances can both pass that check, so it hands the hash it
     * checked to the repository, which can make the check part of its write (a conditional {@code UPDATE}, a
     * version column, a row lock).
     *
     * <p>The repository throws {@link FormOutdatedException} (carrying the hash that is current) when the stored
     * definition no longer has {@code expectedSha256}. A repository that cannot check the hash in its write (a single
     * process, a file store) compares it before it saves; one that cannot save throws {@link FormStoreReadOnlyException}.
     *
     * @param expectedSha256 the hash of the stored definition this one replaces, or null when the form is new
     *     (the repository then refuses if it already exists, with {@link FormOutdatedException})
     * @throws FormOutdatedException when the stored definition is not the one the caller built on
     * @throws FormStoreReadOnlyException when this repository cannot save (501)
     */
    SavedForm save(ObjectNode definition, String expectedSha256);

    /**
     * The definition and its hash, as a submission names it. The default hashes {@link #find}; a repository
     * that keeps the hash may answer without recomputing.
     *
     * @throws FormNotFoundException when no form has the key
     */
    default CurrentDefinition current(String key) {
        ObjectNode definition = find(key).orElseThrow(() -> new FormNotFoundException(key));
        return new CurrentDefinition(definition, CanonicalJson.digest(definition));
    }
}
