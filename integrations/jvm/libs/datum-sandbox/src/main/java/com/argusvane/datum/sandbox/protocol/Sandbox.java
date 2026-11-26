package com.argusvane.datum.sandbox.protocol;

import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The sandbox program's operations as its callers see them: the receiver's validations, the definition
 * service's public copies and save checks, the kernel inspection and the runtime's own ABI proof and warm-up runs.
 *
 * <p>{@link SandboxService} is the one implementation that runs the protocol (the depth guard, the slot, the ABI gate,
 * the nonce, the frame, the strict answer), and it stays final: the protocol is not something a host changes. This
 * interface is what a host wraps instead, through a {@link SandboxDecorator} (several compose in order), so a
 * decorator (tracing, metrics, an audit of every run) sits in front of every caller: a decorator delegates each call
 * to the sandbox it was given and never answers in its place. A decorator that answered for the program (a cached verdict, a skipped check) would take the sandbox out of the
 * decision; nothing here can stop that, so the contract is stated instead: delegate, observe, rethrow.
 *
 * <p>The methods and their refusals are {@link SandboxService}'s; see there for the order of the checks.
 */
public interface Sandbox {

    /** What {@link #smoke()} found. */
    record Smoke(boolean ok, double ms, String message) {
    }

    /** The program this sandbox runs. */
    Program program();

    /**
     * Runs one validation ({@link SandboxService#validate}).
     *
     * @param real whether this is a real submission, whose run log is relayed to the {@link RunLog}
     */
    SandboxResult validate(ObjectNode context, List<RuleModule> rules, boolean real);

    /** Asks the program about a definition, {@code __datum_inspect} ({@link SandboxService#inspect(String, ObjectNode, String, Map, List)}). */
    ObjectNode inspect(String op, ObjectNode definition, @Nullable String formulaErrors, @Nullable Map<String, JsonNode> extra, List<RuleModule> rules);

    /** {@link #inspect(String, ObjectNode, String, Map, List)} with no policy, no extra members and no rules. */
    default ObjectNode inspect(String op, ObjectNode definition) {
        return inspect(op, definition, null, null, List.of());
    }

    /** Whether a definition may be saved: the {@code check} op ({@link SandboxService#check}). */
    ObjectNode check(ObjectNode definition, List<String> types, List<RuleModule> rules);

    /** The definition a browser may be served: the {@code public} op ({@link SandboxService#publicCopy}). */
    ObjectNode publicCopy(ObjectNode definition);

    /** A tiny run proving the runtime works ({@link SandboxService#smoke}). */
    Smoke smoke();

    /** Proves the program answers for {@link SandboxAbi#MIN}, once per program ({@link SandboxService#proveAbi}). */
    void proveAbi();
}
