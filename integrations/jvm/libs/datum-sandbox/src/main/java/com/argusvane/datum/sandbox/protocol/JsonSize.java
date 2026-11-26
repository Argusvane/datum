package com.argusvane.datum.sandbox.protocol;

import java.math.BigInteger;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Map;
import tools.jackson.databind.JsonNode;

/**
 * How large a parsed JSON tree is, for a size cap applied where there are no bytes to count: a
 * document or a definition handed to a service by a queue consumer, a batch or a sync job rather than read off a request.
 *
 * <p>The measure is a lower bound: the fewest bytes any UTF-8 JSON text that reads as this tree can take. Strings and keys
 * count their UTF-8 bytes and their quotes, structure its brackets, colons and commas, literals their letters, an integer
 * its digits and sign, a decimal the digits of its unscaled value, a double one byte (and its sign); whitespace, escapes, a
 * repeated key and a long spelling of a number count nothing. So a body a route read under its byte cap always measures
 * within that cap here, and a route's caller is never refused twice for one body, while a tree built by any other caller
 * is held to the same cap. The bound is exact for compact ASCII text without escapes, floats or decimals.
 *
 * <p>The walk is iterative and stops as soon as the count passes the caller's limit; every node counts at least one byte,
 * so a tree of any size, a cyclic one included, costs work bounded by the limit.
 */
public final class JsonSize {

    /** Just under log10(2), so the digits counted for an integer's bit length never exceed its real digits. */
    private static final long LOG10_2_E5 = 30_102;

    private JsonSize() {
    }

    /** Whether the tree takes more than {@code maxBytes} as JSON text, by {@link #atLeast}. */
    public static boolean exceeds(JsonNode value, long maxBytes) {
        return atLeast(value, maxBytes) > maxBytes;
    }

    /**
     * The fewest bytes a UTF-8 JSON text of this tree takes, or, once the count passes {@code stopAbove}, the count so far
     * (already more than {@code stopAbove}).
     */
    public static long atLeast(JsonNode value, long stopAbove) {
        long total = 0;
        Deque<JsonNode> stack = new ArrayDeque<>();
        stack.push(value);
        while (!stack.isEmpty()) {
            JsonNode node = stack.pop();
            if (node.isObject()) {
                total += 2;
                boolean first = true;
                for (Map.Entry<String, JsonNode> entry : node.properties()) {
                    // The comma before it, the key with its quotes, the colon; the value when it is popped.
                    total += (first ? 0 : 1) + string(entry.getKey(), stopAbove - total) + 1;
                    first = false;
                    if (total > stopAbove) {
                        return total;
                    }
                    stack.push(entry.getValue());
                }
            } else if (node.isArray()) {
                total += 2;
                boolean first = true;
                for (JsonNode child : node.values()) {
                    total += first ? 0 : 1;
                    first = false;
                    if (total > stopAbove) {
                        return total;
                    }
                    stack.push(child);
                }
            } else if (node.isString()) {
                total += string(node.stringValue(), stopAbove - total);
            } else if (node.isNumber()) {
                total += number(node);
            } else if (node.isBoolean()) {
                total += node.booleanValue() ? 4 : 5;
            } else if (node.isNull()) {
                total += 4;
            } else if (node.isBinary()) {
                // Written as a base64 string.
                total += 2 + ((node.binaryValue().length + 2L) / 3) * 4;
            } else {
                // A node no JSON text reads as (a POJO, a missing node): at least one byte, so the walk always advances.
                total += 1;
            }
            if (total > stopAbove) {
                return total;
            }
        }
        return total;
    }

    /** A string with its quotes: its UTF-8 bytes, a surrogate two (four for a pair, as UTF-8 writes one). */
    private static long string(String text, long budget) {
        long quoted = 2L + text.length();
        if (quoted > budget) {
            // Every UTF-16 unit takes at least one byte: past the budget already, without walking the string.
            return quoted;
        }
        long bytes = 2;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            bytes += c < 0x80 ? 1 : c < 0x800 || Character.isSurrogate(c) ? 2 : 3;
        }
        return bytes;
    }

    private static long number(JsonNode number) {
        if (number.isBigInteger()) {
            return digits(number.bigIntegerValue());
        }
        if (number.isIntegralNumber()) {
            return Long.toString(number.longValue()).length();
        }
        if (number.isBigDecimal()) {
            // The text spells at least the unscaled digits (an exponent only drops zeros).
            return digits(number.decimalValue().unscaledValue());
        }
        // A double or a float: one digit at least, and its sign.
        return number.doubleValue() < 0 ? 2 : 1;
    }

    /**
     * The decimal digits of an integer and its sign, from its bit length (no conversion to text, which costs the square of
     * a long one): a value of b bits has at least floor((b - 1) log10 2) + 1 digits.
     */
    private static long digits(BigInteger value) {
        int bits = value.bitLength();
        long digits = bits <= 1 ? 1 : (bits - 1L) * LOG10_2_E5 / 100_000 + 1;
        return digits + (value.signum() < 0 ? 1 : 0);
    }
}
