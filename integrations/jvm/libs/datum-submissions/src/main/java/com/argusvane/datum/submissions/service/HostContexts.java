package com.argusvane.datum.submissions.service;

import com.argusvane.datum.core.DatumException;
import com.argusvane.datum.core.contracts.DatumJson;
import com.argusvane.datum.sandbox.protocol.DefinitionDepth;
import com.argusvane.datum.submissions.spi.HostContextProvider;
import com.argusvane.datum.submissions.spi.HostContextRequest;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Map;
import java.util.Optional;
import org.jspecify.annotations.Nullable;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

/**
 * A {@link HostContextProvider}'s answer as the run context's {@code hostContext} (sandbox ABI 4.1.0): asked
 * once, written as JSON, held to the bounds the ABI gives the key, and copied so nothing the provider keeps can change the
 * run. The submission service asks it for every run; the PDF facade asks it for the print of the same answers.
 *
 * <p>The bounds are the ABI's for {@code hostContext} (those of {@code externalData}): at most {@value #MAX_DEPTH} levels,
 * counted as the document's nesting is ({@link DefinitionDepth#jsonDepth}, so an object of plain values is 2), at most
 * {@value #MAX_VALUES} values, every number finite and every string strict JSON (no unpaired surrogate). The program
 * refuses such a context before the run too; checking here names the provider in the log rather than leaving a failed run
 * to explain. A breach is the host's fault, never the answers': {@link Failed}, which the callers answer with 503
 * {@code server.unavailable}: no run, the cause in the log at ERROR and the values never in it or in the answer.
 */
public final class HostContexts {

    /** The deepest context accepted (the ABI's 64 levels). */
    public static final int MAX_DEPTH = 64;

    /** The most values a context may hold, containers included (the ABI's 1,000,000). */
    public static final int MAX_VALUES = 1_000_000;

    private static final JsonMapper JSON = DatumJson.mapper();

    private HostContexts() {
    }

    /**
     * The provider's context for one run.
     *
     * @return the context as JSON, or null when the provider supplied none (or there is no provider)
     * @throws DatumException as the provider threw it
     * @throws Failed when the provider threw anything else, answered null, or answered a value outside the bounds
     */
    public static @Nullable ObjectNode ask(@Nullable HostContextProvider provider, HostContextRequest request) {
        if (provider == null) {
            return null;
        }
        Optional<? extends Map<String, ?>> answer;
        try {
            answer = provider.hostContext(request);
        } catch (DatumException e) {
            throw e;
        } catch (Exception e) {
            throw new Failed("The host context provider for " + request.formKey() + " threw: " + e.getMessage(), e);
        }
        if (answer == null) {
            // A provider that could not say is no "no context": that would judge more leniently than the application meant.
            throw new Failed("The host context provider for " + request.formKey() + " answered null; it answers Optional.empty() for no context.",
                null);
        }
        if (answer.isEmpty()) {
            return null;
        }
        return checked(answer.get(), request.formKey());
    }

    /** A context as JSON, held to the bounds; {@link Failed} otherwise. */
    static ObjectNode checked(Map<String, ?> context, String formKey) {
        JsonNode tree;
        try {
            tree = JSON.valueToTree(context);
        } catch (RuntimeException e) {
            throw new Failed("The host context for " + formKey + " is not JSON data: " + e.getMessage(), e);
        }
        if (tree == null || !tree.isObject()) {
            throw new Failed("The host context for " + formKey + " is not a JSON object.", null);
        }
        if (DefinitionDepth.jsonDepth(tree) > MAX_DEPTH) {
            throw new Failed("The host context for " + formKey + " nests more than " + MAX_DEPTH + " levels deep.", null);
        }
        if (count(tree) > MAX_VALUES) {
            throw new Failed("The host context for " + formKey + " holds more than " + MAX_VALUES + " values.", null);
        }
        if (SubmissionService.hasNonFiniteNumber(tree)) {
            throw new Failed("The host context for " + formKey + " holds a number that is not finite (NaN or an infinity).", null);
        }
        if (SubmissionService.holdsUnpairedSurrogate(tree)) {
            throw new Failed("The host context for " + formKey + " holds a string that is not strict JSON (an unpaired surrogate).", null);
        }
        return ((ObjectNode) tree).deepCopy();
    }

    /** Every value of the tree, containers included; stops counting past the cap. */
    private static long count(JsonNode tree) {
        long seen = 0;
        Deque<JsonNode> stack = new ArrayDeque<>();
        stack.push(tree);
        while (!stack.isEmpty() && seen <= MAX_VALUES) {
            JsonNode node = stack.pop();
            seen++;
            if (node.isContainer()) {
                for (JsonNode child : node.values()) {
                    stack.push(child);
                }
            }
        }
        return seen;
    }

    /**
     * The provider failed or answered a value the run cannot carry: the host's own fault, answered 503
     * {@code server.unavailable} by the callers, with this message in the log only (the cause is a stack trace, never
     * the context's values).
     */
    public static final class Failed extends RuntimeException {

        private static final long serialVersionUID = 1L;

        Failed(String message, @Nullable Throwable cause) {
            super(message, cause);
        }
    }
}
