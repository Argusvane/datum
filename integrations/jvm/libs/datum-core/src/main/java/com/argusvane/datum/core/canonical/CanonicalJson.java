package com.argusvane.datum.core.canonical;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HexFormat;
import java.util.List;
import java.util.regex.Pattern;
import tools.jackson.databind.JsonNode;

/**
 * The canonical serialization: the sandbox kernel's {@code kernelStableStringify}, ported, and held to the engine's
 * {@code serializeCanonicalSubmission} by the shared {@code canonical.json} fixture.
 *
 * <p>Object keys sorted by UTF-16 code unit, array order kept, no whitespace, strings and numbers written
 * the way {@code JSON.stringify} writes them. Two details follow JavaScript: array-index keys ("0", "12")
 * come first in ascending numeric order, as a JavaScript object orders them; and an integer beyond 2^53 is
 * written as the double JavaScript reads it as. {@link String#compareTo} compares UTF-16 code units, which is
 * the order the program uses (V8's {@code localeCompare} differs, and is not followed).
 *
 * <p>The browser, the program and this port write one document the same bytes, so a
 * digest taken here may be held to the program's.
 */
public final class CanonicalJson {

    private static final Pattern ARRAY_INDEX = Pattern.compile("^(0|[1-9][0-9]*)$");
    private static final long MAX_SAFE = 9007199254740992L;
    private static final long MAX_ARRAY_INDEX = 4294967294L;

    private CanonicalJson() {
    }

    /** Serializes a parsed JSON value canonically. */
    public static String serialize(JsonNode value) {
        return write(value, true);
    }

    /**
     * The shared writer. {@code jsMemberOrder} puts array-index keys first (the kernel's canonical form, which
     * writes a JavaScript object); false is RFC 8785's pure code-unit order, which also refuses a number with
     * no JSON form (see {@link Jcs}).
     */
    static String write(JsonNode value, boolean jsMemberOrder) {
        StringBuilder out = new StringBuilder();
        write(out, value, jsMemberOrder);
        return out.toString();
    }

    /** SHA-256, lowercase hex, over the UTF-8 bytes of the canonical serialization. */
    public static String digest(JsonNode value) {
        return sha256Hex(serialize(value));
    }

    /** SHA-256, lowercase hex, over the UTF-8 bytes of {@code text}. */
    public static String sha256Hex(String text) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is required of every Java platform", e);
        }
    }

    /**
     * An object's keys in JavaScript's own order once sorted: array-index keys first, ascending, then the
     * rest by UTF-16 code unit.
     */
    public static List<String> orderedKeys(Collection<String> keys) {
        List<String> indexes = new ArrayList<>();
        List<String> names = new ArrayList<>();
        for (String key : keys) {
            if (isArrayIndex(key)) {
                indexes.add(key);
            } else {
                names.add(key);
            }
        }
        indexes.sort((a, b) -> Long.compare(Long.parseLong(a), Long.parseLong(b)));
        names.sort(String::compareTo);
        List<String> ordered = new ArrayList<>(indexes);
        ordered.addAll(names);
        return ordered;
    }

    /** Keys by UTF-16 code unit alone (RFC 8785). */
    static List<String> codeUnitKeys(Collection<String> keys) {
        List<String> sorted = new ArrayList<>(keys);
        sorted.sort(String::compareTo);
        return sorted;
    }

    private static String checkedNumber(double value, boolean lenient) {
        if (!lenient && (Double.isNaN(value) || Double.isInfinite(value))) {
            throw new IllegalArgumentException("JCS has no form for a number that is not finite.");
        }
        return number(value);
    }

    private static boolean isArrayIndex(String key) {
        if (key.length() > 10 || !ARRAY_INDEX.matcher(key).matches()) {
            return false;
        }
        return Long.parseLong(key) <= MAX_ARRAY_INDEX;
    }

    private static void write(StringBuilder out, JsonNode value, boolean jsMemberOrder) {
        if (value == null || value.isNull() || value.isMissingNode()) {
            out.append("null");
        } else if (value.isBoolean()) {
            out.append(value.booleanValue() ? "true" : "false");
        } else if (value.isIntegralNumber()) {
            if (value.canConvertToLong() && value.longValue() >= -MAX_SAFE && value.longValue() <= MAX_SAFE) {
                out.append(value.longValue());
            } else {
                // JavaScript reads an integer beyond 2^53 as the nearest double.
                out.append(checkedNumber(value.numberValue().doubleValue(), jsMemberOrder));
            }
        } else if (value.isNumber()) {
            out.append(checkedNumber(value.numberValue().doubleValue(), jsMemberOrder));
        } else if (value.isString()) {
            quote(out, value.stringValue());
        } else if (value.isArray()) {
            out.append('[');
            boolean first = true;
            for (JsonNode item : value) {
                if (!first) {
                    out.append(',');
                }
                first = false;
                write(out, item, jsMemberOrder);
            }
            out.append(']');
        } else if (value.isObject()) {
            out.append('{');
            boolean first = true;
            for (String key : jsMemberOrder ? orderedKeys(value.propertyNames()) : codeUnitKeys(value.propertyNames())) {
                if (!first) {
                    out.append(',');
                }
                first = false;
                quote(out, key);
                out.append(':');
                write(out, value.get(key), jsMemberOrder);
            }
            out.append('}');
        } else {
            throw new IllegalArgumentException("A " + value.getNodeType() + " node has no JSON form.");
        }
    }

    /** A string as {@code JSON.stringify} writes it (well-formed: a lone surrogate is escaped). */
    private static void quote(StringBuilder out, String text) {
        out.append('"');
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\b' -> out.append("\\b");
                case '\f' -> out.append("\\f");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    boolean loneSurrogate = false;
                    if (Character.isHighSurrogate(c)) {
                        if (i + 1 < text.length() && Character.isLowSurrogate(text.charAt(i + 1))) {
                            out.append(c).append(text.charAt(++i));
                            continue;
                        }
                        loneSurrogate = true;
                    } else if (Character.isLowSurrogate(c)) {
                        loneSurrogate = true;
                    }
                    if (c < 0x20 || loneSurrogate) {
                        out.append("\\u").append(String.format("%04x", (int) c));
                    } else {
                        out.append(c);
                    }
                }
            }
        }
        out.append('"');
    }

    /** A double as ECMAScript's {@code Number::toString} writes it; see {@link EcmaNumber}. */
    static String number(double value) {
        return EcmaNumber.format(value);
    }
}
