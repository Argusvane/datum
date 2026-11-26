package com.argusvane.datum.sandbox.protocol;

import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.Objects;
import org.jspecify.annotations.Nullable;

/**
 * A run's marker nonce and the stdin that carries it.
 *
 * <p>A fresh nonce per run, sent on stdin: the guest has no file to read it from, and a rule module cannot
 * print the markers without it: 16 random bytes as 32 lowercase hex characters, a line feed, then the input. run.js takes the first 32 characters, requires a line feed after them and
 * lowercase hex in them, and throws "no run nonce" otherwise.
 */
public final class Nonce {

    /** The number of hex characters in a nonce. */
    public static final int LENGTH = 32;

    private static final SecureRandom RANDOM = new SecureRandom();

    private Nonce() {
    }

    /** 16 bytes from {@link SecureRandom}, as 32 lowercase hex characters. */
    public static String generate() {
        return generate(RANDOM);
    }

    /** 16 bytes from the given source, as 32 lowercase hex characters. */
    public static String generate(SecureRandom random) {
        byte[] bytes = new byte[16];
        random.nextBytes(bytes);
        return HexFormat.of().formatHex(bytes);
    }

    /** Whether a text is a nonce run.js accepts: exactly 32 lowercase hex characters. */
    public static boolean isValid(@Nullable String nonce) {
        return nonce != null && nonce.matches("[0-9a-f]{32}");
    }

    /**
     * The stdin of a sandbox run: the nonce, a line feed, then the input JSON, UTF-8.
     *
     * @throws IllegalArgumentException when the nonce is not one run.js accepts
     */
    public static byte[] stdin(String nonce, String json) {
        if (!isValid(nonce)) {
            throw new IllegalArgumentException("A run nonce is 32 lowercase hex characters.");
        }
        Objects.requireNonNull(json, "json");
        return (nonce + "\n" + json).getBytes(StandardCharsets.UTF_8);
    }
}
