package com.argusvane.datum.webauthn;

import com.argusvane.datum.core.canonical.Jcs;
import java.nio.charset.StandardCharsets;
import java.util.HexFormat;
import java.util.Map;
import org.jspecify.annotations.Nullable;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.NullNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The text a passkey signature covers (the engine's {@code signedCanonicalOf}, held to by the
 * shared {@code webauthn-engine.json}).
 *
 * <p>The envelope without its signatures; the part the scope names (the envelope, its submission, or the
 * submission's values); wrapped as {@code {document, statement}} when there is a statement; in RFC 8785. Its
 * SHA-256 is the WebAuthn challenge the engine signed.
 *
 * <p>JCS is datum-core's {@link Jcs}, which formats numbers exactly as ECMAScript's Number::toString does (one
 * formatter shared with {@code CanonicalJson}, held to a node-generated oracle of more than 340,000 doubles and to
 * java-json-canonicalization over a further 2.25 million). Doubles just above a power of two get the shortest
 * spelling the browser uses (2^-24 is 5.960464477539063e-8, not a 17-digit form); the library is only a test-scope
 * check, where {@code JcsTest} holds every vector to it. {@code Jcs} works on the
 * parsed node the receiver already holds, so nothing is written to text and read back. Anything JSON text would
 * not carry faithfully (a node that is not JSON, an unpaired surrogate) is refused before, and a number with no
 * JSON form (not finite, or past a double's range) is refused by {@code Jcs}.
 */
public final class SignedText {

    private SignedText() {
    }

    /**
     * The signed text.
     *
     * @param envelope the envelope as delivered (under the wrapper placement, the payload)
     * @param scope the format's scope: envelope, submission or values (anything else reads as envelope, as
     *     the engine's {@code signedCanonicalOf} reads an unknown scope)
     * @param statement the signing statement, or null for none
     * @throws IllegalArgumentException when the part has no canonical form: a number JSON cannot hold (not
     *     finite, or past a double's range), a value that is not JSON, or a string with an unpaired UTF-16
     *     surrogate (RFC 8785 calls such input invalid)
     */
    public static String text(JsonNode envelope, @Nullable String scope, @Nullable String statement) {
        if (envelope == null || !envelope.isObject()) {
            throw new IllegalArgumentException("The envelope is not an object.");
        }
        ObjectNode unsigned = JsonNodeFactory.instance.objectNode();
        for (Map.Entry<String, JsonNode> member : envelope.properties()) {
            if (!member.getKey().equals("signatures")) {
                unsigned.set(member.getKey(), member.getValue());
            }
        }
        JsonNode part = switch (scope == null ? "" : scope) {
            case "values" -> member(member(unsigned, "submission"), "values");
            case "submission" -> member(unsigned, "submission");
            default -> unsigned;
        };
        JsonNode signed = part;
        if (statement != null) {
            ObjectNode wrapped = JsonNodeFactory.instance.objectNode();
            wrapped.set("document", part);
            wrapped.put("statement", statement);
            signed = wrapped;
        }
        return canonicalize(signed);
    }

    /**
     * RFC 8785 text of a JSON value, by datum-core's {@link Jcs}.
     *
     * @throws IllegalArgumentException when the value has no canonical form (see {@link #text})
     */
    public static String canonicalize(JsonNode value) {
        refuseWithoutCanonicalForm(value);
        try {
            return Jcs.canonicalize(value);
        } catch (IllegalArgumentException e) {
            throw e;
        } catch (RuntimeException e) {
            throw new IllegalArgumentException("The value has no canonical form: " + e.getMessage(), e);
        }
    }

    /** SHA-256 of the text's UTF-8 bytes: the challenge the engine signed. */
    public static byte[] digest(String text) {
        return WebAuthnVerifier.sha256(text.getBytes(StandardCharsets.UTF_8));
    }

    /** {@link #digest} as lowercase hex, as the use store keeps it. */
    public static String digestHex(String text) {
        return HexFormat.of().formatHex(digest(text));
    }

    /** A member of an object, or null when the node is not an object or has no such member. */
    private static JsonNode member(JsonNode node, String name) {
        if (node == null || !node.isObject()) {
            return NullNode.getInstance();
        }
        JsonNode value = node.get(name);
        return value == null ? NullNode.getInstance() : value;
    }

    /**
     * Refuses what JSON text would not carry as it is: an unpaired surrogate (JSON text would replace it), a
     * floating number that is not finite, and any node that is not JSON (binary, a Java object, missing).
     */
    private static void refuseWithoutCanonicalForm(JsonNode node) {
        if (node == null) {
            throw new IllegalArgumentException("There is no value.");
        }
        if (node.isString()) {
            check(node.asString());
        } else if (node.isObject()) {
            for (Map.Entry<String, JsonNode> member : node.properties()) {
                check(member.getKey());
                refuseWithoutCanonicalForm(member.getValue());
            }
        } else if (node.isArray()) {
            for (JsonNode item : node) {
                refuseWithoutCanonicalForm(item);
            }
        } else if (node.isNumber()) {
            if ((node.isDouble() || node.isFloat()) && !Double.isFinite(node.doubleValue())) {
                throw new IllegalArgumentException("JCS has no form for a number that is not finite.");
            }
        } else if (!node.isNull() && !node.isBoolean()) {
            throw new IllegalArgumentException("A " + node.getNodeType() + " node has no JSON form.");
        }
    }

    private static void check(String text) {
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (Character.isHighSurrogate(c) && i + 1 < text.length() && Character.isLowSurrogate(text.charAt(i + 1))) {
                i++;
            } else if (Character.isSurrogate(c)) {
                throw new IllegalArgumentException("A string with an unpaired UTF-16 surrogate has no canonical form.");
            }
        }
    }
}
