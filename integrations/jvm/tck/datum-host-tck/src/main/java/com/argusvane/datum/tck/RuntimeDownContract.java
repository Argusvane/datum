package com.argusvane.datum.tck;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ObjectNode;

/**
 * A runtime that could not prove its program (fail-fast off, the program unreadable, or a program below the host's ABI
 * floor such as the kit's {@link TckFixtures#STALE_PROGRAM}, refused with {@code abi_mismatch}): the host still starts,
 * and every submission is answered 503, never accepted unchecked. Moved here from the Spring submissions example.
 */
public interface RuntimeDownContract extends HostContract {

    @Test
    @Order(1900)
    default void aRuntimeThatCannotProveItsProgramAnswers503ToEverySubmission() {
        Reply reply = http().postJson(target().api("/submissions"), TckFixtures.delivered(TckFixtures.envelope("CTL-01")));
        assertThat(reply.status()).as(reply.toString()).isEqualTo(503);
        assertThat(reply.code()).isIn("server.unavailable", "validator_unavailable");
    }

    /** The check is no verdict either: a runtime that is down answers it 503, never a 200 with a code in the errors. */
    @Test
    @Order(1901)
    default void aRuntimeThatCannotProveItsProgramAnswers503ToAJourneyCheck() {
        ObjectNode check = TckFixtures.JSON.createObjectNode();
        check.set("document", TckFixtures.envelope("CTL-01"));
        check.put("scope", "journey");
        Reply reply = http().postJson(target().api("/submissions/validate"), check.toString());
        assertThat(reply.status()).as(reply.toString()).isEqualTo(503);
        assertThat(reply.code()).isIn("server.unavailable", "validator_unavailable");
        assertThat(reply.json().has("accepted")).isFalse();
    }
}
