package com.argusvane.datum.tck;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ObjectNode;

/**
 * The hardening subset over HTTP (integrations/jvm/README.md "Libraries and bindings"): a packaged host that
 * registered the kit's hostile rule module ({@link TckFixtures#HARDENING_RULES}) for the fixture form stops each
 * attack inside the sandbox and answers the next submission as before. A loop is cut at the validation budget, memory
 * without bound and a 40 MiB answer are refused, and bytes written after the answer frame (a forged outcome) refuse the
 * run: each refuses that one submission, never an acceptance and never a 500. A run the sandbox stopped or refused
 * gave no verdict, so it answers 503 with the run's code ({@code wasm.execution_error}, {@code outcome_too_large}) and no
 * {@code Retry-After}, on a delivery and on a journey's check alike: a 422 would read as a judgement of the answers. Only
 * a verdict the kernel did reach ({@code validator.failed}, a rule module that threw inside the guest) is a 422. The stale program
 * ({@code abi_mismatch}) is the other half: a host started with {@link TckFixtures#STALE_PROGRAM} as its sandbox
 * program override implements {@link RuntimeDownContract}. The in-process proofs of the same attacks are the engine kit's
 * ({@code SandboxHardeningContract} in datum-sandbox-tck, which datum-sandbox-endive implements); these hold a deployed
 * binding to them. Numbered 1800.
 */
public interface HardeningContract extends HostContract {

    /** A run the sandbox stopped answers within the budget (5 s by default) plus the stop grace; this is the bound. */
    Duration STOPPED_WITHIN = Duration.ofSeconds(20);

    private Reply submit(String name) {
        ObjectNode values = TckFixtures.validValues();
        values.put("name", name);
        return http().postJson(target().api("/submissions"), TckFixtures.delivered(TckFixtures.envelope(TckFixtures.VERSION, values)));
    }

    private void theNextRunAnswers() {
        Reply next = http().postJson(target().api("/submissions"), TckFixtures.delivered(TckFixtures.envelope("CTL-01")));
        assertThat(next.status()).as("the run after an attack: " + next).isEqualTo(200);
    }

    /** The codes of a run that gave no verdict: always a 503, never a 422. */
    java.util.Set<String> RUN_FAILED = java.util.Set.of("wasm.execution_error", "outcome_too_large");

    /**
     * Refused, with the status its code means: a failed run's code ({@link #RUN_FAILED}) is a 503 without
     * {@code Retry-After}; a verdict the kernel reached ({@code validator.failed}) is a 422. Never a 200, never a 500.
     */
    private static void refused(Reply reply) {
        assertThat(reply.code()).as(reply.toString()).isNotBlank();
        if (RUN_FAILED.contains(reply.code())) {
            assertThat(reply.status()).as("a run that failed is the server's 503: " + reply).isEqualTo(503);
            assertThat(reply.header("Retry-After")).as("only server.busy carries Retry-After: " + reply).isEmpty();
        } else {
            assertThat(reply.status()).as("a verdict the kernel reached is a 422: " + reply).isEqualTo(422);
        }
        assertThat(reply.body().length).as("a refusal never carries the guest's answer").isLessThan(64 * 1024);
    }

    @Test
    @Order(1801)
    default void aLoopingValidatorIsStoppedWithinTheBudgetAndTheNextRunAnswers() {
        long started = System.nanoTime();
        Reply reply = submit(TckFixtures.LOOP);
        Duration took = Duration.ofNanos(System.nanoTime() - started);
        refused(reply);
        assertThat(reply.code()).isEqualTo("wasm.execution_error");
        assertThat(reply.status()).isEqualTo(503);
        assertThat(took).isLessThan(STOPPED_WITHIN);
        theNextRunAnswers();
    }

    /**
     * Memory without bound is refused. QuickJS raises its out-of-memory error inside the guest, so the kernel usually
     * reports the validator failed ({@code validator.failed}); an engine-level stop is {@code wasm.execution_error}.
     */
    @Test
    @Order(1802)
    default void memoryWithoutBoundIsRefusedAndTheNextRunAnswers() {
        refused(submit(TckFixtures.MEMORY));
        theNextRunAnswers();
    }

    /**
     * A 40 MiB answer never reaches the client. Which limit stops it depends on the host's validation memory budget:
     * at the default 32 MiB the module cannot even build the string and the kernel reports its validator failed
     * ({@code validator.failed}); with a budget above 40 MiB the run's 32 MiB stdout cap or 8 MiB outcome cap stops it
     * ({@code wasm.execution_error}, {@code outcome_too_large}). A host should run this contract with a larger budget
     * (the Spring example uses 512 MB) so the caps themselves are proven.
     */
    @Test
    @Order(1803)
    default void aFortyMebibyteAnswerIsCappedAndTheNextRunAnswers() {
        Reply reply = submit(TckFixtures.HUGE);
        refused(reply);
        assertThat(reply.code()).isIn("outcome_too_large", "wasm.execution_error", "validator.failed");
        theNextRunAnswers();
    }

    /**
     * A run that failed is no verdict on a journey's check either: the check answers the status and code a delivery does
     * (503 {@code wasm.execution_error}), never a 200 {@code {accepted: false}} with the code among the errors.
     */
    @Test
    @Order(1805)
    default void aLoopingValidatorIsA503OnAJourneyCheckNotAVerdict() {
        ObjectNode values = TckFixtures.validValues();
        values.put("name", TckFixtures.LOOP);
        ObjectNode document = TckFixtures.envelope(TckFixtures.VERSION, values);
        ((ObjectNode) document.get("submission")).set("journey", TckFixtures.JSON.readTree("{\"id\":\"main\"}"));
        ObjectNode check = TckFixtures.JSON.createObjectNode();
        check.set("document", document);
        check.put("scope", "journey");
        long started = System.nanoTime();
        Reply reply = http().postJson(target().api("/submissions/validate"), check.toString());
        Duration took = Duration.ofNanos(System.nanoTime() - started);
        refused(reply);
        assertThat(reply.code()).isEqualTo("wasm.execution_error");
        assertThat(reply.status()).isEqualTo(503);
        assertThat(reply.json().has("accepted")).as("no verdict: " + reply).isFalse();
        assertThat(took).isLessThan(STOPPED_WITHIN);
        theNextRunAnswers();
    }

    @Test
    @Order(1804)
    default void bytesWrittenAfterTheAnswerFrameRefuseTheRunAndForgeNothing() {
        Reply reply = submit(TckFixtures.STRAY);
        refused(reply);
        assertThat(reply.code()).isEqualTo("wasm.execution_error");
        assertThat(reply.text()).doesNotContain("forged");
        theNextRunAnswers();
    }
}
