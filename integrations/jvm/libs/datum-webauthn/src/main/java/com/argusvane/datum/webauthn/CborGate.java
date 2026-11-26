package com.argusvane.datum.webauthn;

import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;

/**
 * The structural pre-gate in front of webauthn4j: the CBOR (RFC 8949) of a registration's
 * attestation object and of the authenticator data's credential key and extensions must be the plain, definite CBOR a
 * WebAuthn authenticator writes (CTAP2 canonical CBOR, WebAuthn 6.5.1) before the library reads a byte of it.
 *
 * <p>webauthn4j reads CBOR with Jackson, which takes indefinite lengths, floats, simple values, integers past 64 bits,
 * map keys of any type and repeated keys (the last one wins), and names an integer key by its decimal text, so the
 * integer -2 and the text "-2" are one field to it (a COSE key's x read from the text label). None of those is in what
 * an authenticator sends, and a reader that takes them is one more parser an attacker can steer, so this gate refuses
 * each: nesting past {@value #MAX_DEPTH} levels, an item that runs past the end (or bytes after the attestation
 * object), floats and every simple value but false, true, null and undefined, the reserved and indefinite-length
 * argument encodings (and the break byte), an argument beyond a signed 64-bit integer, a text string that is not UTF-8,
 * a map key that is not an integer or text (tags read through), a text key that spells an integer as the library names
 * one (the decimal text of a 64-bit integer, {@code "1"} or {@code "-2"}: every WebAuthn and COSE label that is a
 * number is written as one), and a map that names one key twice (RFC 8949 5.6), keys compared by the name the library
 * reads them under. Tags are read through, as their content is what WebAuthn reads.
 *
 * <p>Built on: no library, because Jackson's CBOR parser (tools.jackson.dataformat:jackson-dataformat-cbor, the reader
 * webauthn4j uses) reports neither an indefinite length nor a key's CBOR major type through its token stream, and
 * webauthn4j has no strict mode for either, so the gate is this walk: it reads no value out and decides nothing about
 * WebAuthn, only whether the bytes are CBOR this site lets the library read. Every refusal is an
 * {@link IllegalArgumentException}; the verifier answers it as the {@code readable} check.
 */
public final class CborGate {

    /** How deep a structure may nest (the attestation object, its statement, the COSE key: three levels in practice). */
    public static final int MAX_DEPTH = 16;

    private CborGate() {
    }

    /**
     * Checks bytes that hold exactly one CBOR item (an attestation object).
     *
     * @throws IllegalArgumentException when they are not one item of the CBOR this site reads, or bytes follow it
     */
    public static void whole(byte[] bytes) {
        int end = item(bytes, 0, 0);
        if (end != bytes.length) {
            throw new IllegalArgumentException("CBOR: bytes after the item.");
        }
    }

    /**
     * Checks one CBOR map at an offset (the credential key, the extensions of authenticator data) and says where it ends;
     * the bytes after it are the caller's.
     *
     * @return the offset just after the map
     * @throws IllegalArgumentException when no map of the CBOR this site reads starts there
     */
    public static int map(byte[] bytes, int offset) {
        if (offset >= bytes.length) {
            throw new IllegalArgumentException("CBOR: ends early.");
        }
        if ((bytes[offset] & 0xff) >> 5 != 5) {
            throw new IllegalArgumentException("CBOR: a map is expected here.");
        }
        return item(bytes, offset, 0);
    }

    /** One item at an offset; the offset after it. */
    private static int item(byte[] bytes, int offset, int depth) {
        return item(bytes, offset, depth, null);
    }

    /**
     * One item at an offset; the offset after it. With {@code key} given, the item is a map key: the name the library
     * reads it under (an integer's decimal text, a text as it is) is added there, and an item of another kind, a text
     * that spells an integer, or a name seen before is refused.
     */
    private static int item(byte[] bytes, int offset, int depth, Set<String> key) {
        if (depth > MAX_DEPTH) {
            throw new IllegalArgumentException("CBOR: nested too deep.");
        }
        if (offset >= bytes.length) {
            throw new IllegalArgumentException("CBOR: ends early.");
        }
        int initial = bytes[offset] & 0xff;
        int major = initial >> 5;
        int info = initial & 0x1f;
        offset++;
        if (major == 7) {
            if (info < 20 || info > 23) {
                throw new IllegalArgumentException("CBOR: floats and other simple values are not read here.");
            }
            if (key != null) {
                throw new IllegalArgumentException("CBOR: a map key that is not an integer or text.");
            }
            return offset;
        }
        long argument = argument(bytes, offset, info);
        offset += size(info);
        switch (major) {
            case 0, 1 -> {
                if (key != null && !key.add(Long.toString(major == 0 ? argument : -1 - argument))) {
                    throw new IllegalArgumentException("CBOR: a map names one key twice.");
                }
                return offset;
            }
            case 2, 3 -> {
                if (argument > bytes.length - offset) {
                    throw new IllegalArgumentException("CBOR: a string runs past the end.");
                }
                int length = (int) argument;
                if (major == 3) {
                    String text = utf8(bytes, offset, length);
                    if (key != null && spellsAnInteger(text)) {
                        throw new IllegalArgumentException("CBOR: a text map key that spells an integer label.");
                    }
                    if (key != null && !key.add(text)) {
                        throw new IllegalArgumentException("CBOR: a map names one key twice.");
                    }
                } else if (key != null) {
                    throw new IllegalArgumentException("CBOR: a map key that is not an integer or text.");
                }
                return offset + length;
            }
            case 4, 5 -> {
                if (key != null) {
                    throw new IllegalArgumentException("CBOR: a map key that is not an integer or text.");
                }
                // Each member takes a byte at least: a count past what is left can only run past the end.
                long members = major == 5 ? argument * 2 : argument;
                if (argument > bytes.length - offset || members > bytes.length - offset) {
                    throw new IllegalArgumentException("CBOR: a structure runs past the end.");
                }
                Set<String> keys = major == 5 ? new HashSet<>() : null;
                for (long i = 0; i < argument; i++) {
                    if (major == 5) {
                        offset = item(bytes, offset, depth + 1, keys);
                    }
                    offset = item(bytes, offset, depth + 1);
                }
                return offset;
            }
            default -> {
                // A tag (major type 6): its content is what is read, as a key too.
                return item(bytes, offset, depth + 1, key);
            }
        }
    }

    /**
     * Whether a text is the name the library gives an integer key: the decimal text of a 64-bit integer, without a sign
     * for a positive one or a leading zero ({@code "01"}, {@code "+1"} and {@code "-0"} are names, never integers).
     */
    private static boolean spellsAnInteger(String text) {
        if (text.isEmpty() || text.length() > 20) {
            return false;
        }
        try {
            return Long.toString(Long.parseLong(text)).equals(text);
        } catch (NumberFormatException e) {
            return false;
        }
    }

    /** How many bytes follow the initial byte for its argument. */
    private static int size(int info) {
        return switch (info) {
            case 24 -> 1;
            case 25 -> 2;
            case 26 -> 4;
            case 27 -> 8;
            default -> 0;
        };
    }

    /** The argument of an initial byte, in it or in the 1, 2, 4 or 8 bytes after. */
    private static long argument(byte[] bytes, int offset, int info) {
        if (info < 24) {
            return info;
        }
        if (info > 27) {
            // 28 to 30 are reserved, 31 is an indefinite length (or, alone, the break byte).
            throw new IllegalArgumentException("CBOR: indefinite lengths are not read here.");
        }
        int size = size(info);
        if (size > bytes.length - offset) {
            throw new IllegalArgumentException("CBOR: ends early.");
        }
        if (size == 8 && (bytes[offset] & 0xff) >= 0x80) {
            // Beyond a signed 64-bit integer: no COSE or WebAuthn field needs one.
            throw new IllegalArgumentException("CBOR: an integer too large for a signed 64-bit integer.");
        }
        long value = 0;
        for (int i = 0; i < size; i++) {
            value = (value << 8) | (bytes[offset + i] & 0xff);
        }
        return value;
    }

    private static String utf8(byte[] bytes, int offset, int length) {
        try {
            return StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes, offset, length))
                .toString();
        } catch (CharacterCodingException e) {
            throw new IllegalArgumentException("CBOR: a text string is not UTF-8.", e);
        }
    }
}
