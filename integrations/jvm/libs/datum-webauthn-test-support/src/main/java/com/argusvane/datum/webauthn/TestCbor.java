package com.argusvane.datum.webauthn;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;

/**
 * A CBOR (RFC 8949) writer for tests: the software authenticators' attestation objects and COSE keys, and the deliberately
 * malformed ones the refusal tests need (a COSE list where the map belongs, a short RSA modulus, a repeated key). Test
 * scope only: the site reads CBOR through {@link CborGate} and webauthn4j, and writes none of its own.
 *
 * <p>Writes integers (Long, Integer), text, {@link Bytes}, {@link Raw} bytes as they are, booleans, null, lists and maps, in definite lengths and the
 * shortest argument. An empty list is written as an empty map (the shape the test authenticators' fixtures were made
 * with).
 */
final class TestCbor {

    private TestCbor() {
    }

    /** A CBOR byte string, kept apart from text (major type 2 against 3). */
    record Bytes(byte[] bytes) {

        Bytes {
            bytes = bytes.clone();
        }

        @Override
        public byte[] bytes() {
            return bytes.clone();
        }

        int length() {
            return bytes.length;
        }

        @Override
        public boolean equals(Object other) {
            return other instanceof Bytes that && Arrays.equals(bytes, that.bytes);
        }

        @Override
        public int hashCode() {
            return Arrays.hashCode(bytes);
        }

        @Override
        public String toString() {
            return "Bytes[" + HexFormat.of().formatHex(bytes) + "]";
        }
    }

    /** Bytes written as they are: a deliberately malformed item (a repeated key, say) where an item belongs. */
    record Raw(byte[] bytes) {
    }

    static byte[] encode(Object value) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        encode(out, value);
        return out.toByteArray();
    }

    private static void encode(ByteArrayOutputStream out, Object value) {
        if (value instanceof Long || value instanceof Integer) {
            long number = ((Number) value).longValue();
            if (number >= 0) {
                head(out, 0, number);
            } else {
                head(out, 1, -1 - number);
            }
        } else if (value instanceof Raw raw) {
            out.writeBytes(raw.bytes());
        } else if (value instanceof Bytes bytes) {
            head(out, 2, bytes.length());
            out.writeBytes(bytes.bytes());
        } else if (value instanceof String text) {
            byte[] utf8 = text.getBytes(StandardCharsets.UTF_8);
            head(out, 3, utf8.length);
            out.writeBytes(utf8);
        } else if (value instanceof Boolean flag) {
            out.write(flag ? 0xf5 : 0xf4);
        } else if (value == null) {
            out.write(0xf6);
        } else if (value instanceof List<?> list && !list.isEmpty()) {
            head(out, 4, list.size());
            for (Object member : list) {
                encode(out, member);
            }
        } else if (value instanceof List<?>) {
            head(out, 5, 0);
        } else if (value instanceof Map<?, ?> map) {
            head(out, 5, map.size());
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                encode(out, entry.getKey());
                encode(out, entry.getValue());
            }
        } else {
            throw new IllegalArgumentException("CBOR: a " + value.getClass().getSimpleName() + " is not encoded here.");
        }
    }

    private static void head(ByteArrayOutputStream out, int major, long argument) {
        int type = major << 5;
        if (argument < 24) {
            out.write(type | (int) argument);
        } else if (argument < 0x100) {
            out.write(type | 24);
            out.write((int) argument);
        } else if (argument < 0x10000) {
            out.write(type | 25);
            out.writeBytes(ByteBuffer.allocate(2).putShort((short) argument).array());
        } else if (argument < 0x100000000L) {
            out.write(type | 26);
            out.writeBytes(ByteBuffer.allocate(4).putInt((int) argument).array());
        } else {
            out.write(type | 27);
            out.writeBytes(ByteBuffer.allocate(8).putLong(argument).array());
        }
    }
}
