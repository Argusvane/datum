package com.argusvane.datum.forms.snapshot;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.canonical.CanonicalJson;
import com.argusvane.datum.forms.Fixtures;
import tools.jackson.databind.node.ObjectNode;

/**
 * What every {@link DefinitionSnapshotStore} keeps: what is recorded, by key and hash, recorded idempotently, a copy
 * handed back. The library's in-memory store and the Spring binding's SQL store (through
 * datum-forms-test-support) are both held to it.
 */
public final class DefinitionSnapshotStoreContract {

    private DefinitionSnapshotStoreContract() {
    }

    /** The endpoint fixture with its {@code version} set. */
    public static ObjectNode definition(String version) {
        ObjectNode definition = Fixtures.endpointFixture();
        definition.put("version", version);
        return definition;
    }

    public static void check(DefinitionSnapshotStore store) {
        ObjectNode one = definition("1");
        ObjectNode two = definition("2");
        String shaOne = CanonicalJson.digest(one);
        String shaTwo = CanonicalJson.digest(two);

        store.record("contact", shaOne, one);
        store.record("contact", shaOne, one);
        store.record("contact", shaTwo, two);

        assertThat(store.find("contact", shaOne)).hasValue(one);
        assertThat(store.find("contact", shaTwo).orElseThrow().path("version").asString()).isEqualTo("2");
        assertThat(store.find("contact", "0".repeat(64))).isEmpty();
        assertThat(store.find("other", shaOne)).as("the key is part of the name").isEmpty();
        store.find("contact", shaOne).orElseThrow().put("version", "tampered");
        assertThat(store.find("contact", shaOne).orElseThrow().path("version").asString()).as("a copy comes back").isEqualTo("1");
    }
}
