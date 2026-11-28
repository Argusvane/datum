package com.argusvane.datum.sandbox.protocol;

import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Map;
import tools.jackson.core.JacksonException;
import tools.jackson.core.StreamReadConstraints;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * JSON in and out of a run, read and written strictly: Datum's rule, which the host kits and the security suite
 * hold every host to.
 *
 * <p>Reading refuses invalid UTF-8, an empty text, a byte order mark, trailing tokens, a key repeated in one object,
 * nesting past {@link #MAX_DEPTH} (a Jackson {@code StreamReadConstraints} limit) and an unpaired UTF-16 surrogate
 * escape, where Jackson's defaults would accept some of them (an empty text reads as nothing, trailing tokens may be
 * ignored, a repeated key keeps its last value, a lone surrogate escape is a string). A repeated key is refused
 * because two readers of the same answer could disagree on it: one keeping the first value, another the last. A key that starts with NUL is read like any other: nothing on the
 * wire needs the refusal, and the suite's CAN-07 row for it is advisory. A refusal is "not JSON" and the run gives
 * no verdict.
 *
 * <p>Writing is compact JSON with slashes and non-ASCII text as they are: a number JSON cannot write (NaN, an
 * infinity) or a string with an unpaired surrogate (no UTF-8 form) refuses the input rather than reach the guest as
 * {@code "NaN"} or a {@code ?} (REC-02; the receiver refuses those bodies first, this is the
 * backstop).
 */
public final class StrictJson {

    /**
     * The deepest nesting a run reads, 512 levels (the innermost value counts as one, so at most 511 arrays and
     * objects nest; Jackson counts containers only). Datum's limit, above the program's own request bound (RES-06:
     * a request past 320 levels is refused), so the answer to any request the program accepts can be read.
     */
    public static final int MAX_DEPTH = 512;

    private static final JsonMapper MAPPER = JsonMapper.builder(JsonFactory.builder()
            .streamReadConstraints(StreamReadConstraints.builder()
                .maxNestingDepth(MAX_DEPTH - 1)
                // What is read here is bounded by the run's stdout cap already (32 MiB for the sandbox, the
                // memory budget for a PDF, whose base64 bytes are one string); Jackson's own defaults are
                // smaller than a run legitimately answers (a PDF's base64 is one long string).
                .maxStringLength(Integer.MAX_VALUE)
                .maxNameLength(Integer.MAX_VALUE)
                .build())
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .build())
        .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
        .build();

    private StrictJson() {
    }

    /** The mapper behind this class: strict reading, plain writing. */
    public static JsonMapper mapper() {
        return MAPPER;
    }

    /** A text that is not strict JSON. */
    public static final class NotJsonException extends Exception {

        private static final long serialVersionUID = 1L;

        NotJsonException(String message) {
            super(message);
        }
    }

    /**
     * Reads UTF-8 bytes.
     *
     * @throws NotJsonException when they are not strict JSON
     */
    public static JsonNode decode(byte[] utf8) throws NotJsonException {
        String text;
        try {
            text = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(utf8))
                .toString();
        } catch (CharacterCodingException e) {
            throw new NotJsonException("Malformed UTF-8.");
        }
        return decode(text);
    }

    /**
     * Reads a text.
     *
     * @throws NotJsonException when it is not strict JSON
     */
    public static JsonNode decode(String text) throws NotJsonException {
        if (text.isEmpty() || text.charAt(0) == '﻿') {
            throw new NotJsonException(text.isEmpty() ? "Empty text." : "A byte order mark.");
        }
        JsonNode node;
        try {
            node = MAPPER.readTree(text);
        } catch (JacksonException e) {
            throw new NotJsonException("Syntax error.");
        }
        if (node == null || node.isMissingNode()) {
            throw new NotJsonException("No value.");
        }
        String refused = firstRefused(node);
        if (refused != null) {
            throw new NotJsonException(refused);
        }
        return node;
    }

    /**
     * Writes a value as compact JSON.
     *
     * @throws IllegalArgumentException when the value has no JSON form (a non-finite number, an unpaired surrogate)
     */
    public static String encode(JsonNode node) {
        String problem = unwritable(node);
        if (problem != null) {
            throw new IllegalArgumentException(problem);
        }
        return MAPPER.writeValueAsString(node);
    }

    /** Why a value cannot be written as JSON, or null when it can. */
    static String unwritable(JsonNode root) {
        Deque<JsonNode> stack = new ArrayDeque<>();
        stack.push(root);
        while (!stack.isEmpty()) {
            JsonNode node = stack.pop();
            if (node.isNumber() && (node.isDouble() || node.isFloat()) && !Double.isFinite(node.numberValue().doubleValue())) {
                return "A number that is not finite (NaN or an infinity) has no JSON form.";
            }
            if (node.isString() && unpaired(node.stringValue())) {
                return "A string with an unpaired UTF-16 surrogate has no UTF-8 form.";
            }
            if (node.isObject()) {
                for (Map.Entry<String, JsonNode> entry : node.properties()) {
                    if (unpaired(entry.getKey())) {
                        return "A key with an unpaired UTF-16 surrogate has no UTF-8 form.";
                    }
                    stack.push(entry.getValue());
                }
            } else if (node.isArray()) {
                for (JsonNode child : node.values()) {
                    stack.push(child);
                }
            }
        }
        return null;
    }

    /** What the parser read that Datum refuses (an unpaired surrogate), or null. */
    private static String firstRefused(JsonNode root) {
        Deque<JsonNode> stack = new ArrayDeque<>();
        stack.push(root);
        while (!stack.isEmpty()) {
            JsonNode node = stack.pop();
            if (node.isString() && unpaired(node.stringValue())) {
                return "Single unpaired UTF-16 surrogate in a string.";
            }
            if (node.isObject()) {
                for (Map.Entry<String, JsonNode> entry : node.properties()) {
                    if (unpaired(entry.getKey())) {
                        return "Single unpaired UTF-16 surrogate in a key.";
                    }
                    stack.push(entry.getValue());
                }
            } else if (node.isArray()) {
                for (JsonNode child : node.values()) {
                    stack.push(child);
                }
            }
        }
        return null;
    }

    static boolean unpaired(String text) {
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (Character.isHighSurrogate(c)) {
                if (i + 1 < text.length() && Character.isLowSurrogate(text.charAt(i + 1))) {
                    i++;
                    continue;
                }
                return true;
            }
            if (Character.isLowSurrogate(c)) {
                return true;
            }
        }
        return false;
    }
}
