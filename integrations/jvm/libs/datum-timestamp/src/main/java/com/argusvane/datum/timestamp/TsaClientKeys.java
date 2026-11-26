package com.argusvane.datum.timestamp;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HexFormat;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Timestamp client keys, in Datum's format: {@code dtsa_} followed by
 * 32 random bytes in base64url (no padding); stored as the SHA-256 (lowercase hex) of the whole key, with its
 * first characters as a hint to tell keys apart.
 */
public final class TsaClientKeys {

    /** What every key starts with. */
    public static final String PREFIX = "dtsa_";

    private static final SecureRandom RANDOM = new SecureRandom();
    private static final Pattern BEARER = Pattern.compile("^Bearer\\s+(\\S+)\\s*$", Pattern.CASE_INSENSITIVE);
    private static final Pattern BASIC = Pattern.compile("^Basic\\s+(\\S+)\\s*$", Pattern.CASE_INSENSITIVE);

    private TsaClientKeys() {
    }

    /** A new key, to be shown once. */
    public static String generate() {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        return PREFIX + Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    /** What a store keeps of a key: its SHA-256, lowercase hex. */
    public static String hash(String key) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(key.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is required of every Java platform", e);
        }
    }

    /** The key's first characters, to tell keys apart: the prefix and six more. */
    public static String hint(String key) {
        return key.substring(0, Math.min(key.length(), PREFIX.length() + 6));
    }

    /** Whether a key hashes to a stored hash, compared in constant time. */
    public static boolean matches(String key, String storedHash) {
        if (key == null || storedHash == null) {
            return false;
        }
        return MessageDigest.isEqual(hash(key).getBytes(StandardCharsets.US_ASCII), storedHash.toLowerCase(java.util.Locale.ROOT).getBytes(StandardCharsets.US_ASCII));
    }

    /**
     * The key a request carries: a bearer token, or the password of HTTP Basic authentication (any user name).
     *
     * @param authorization the Authorization header, or {@code null}
     * @return the key, or {@code null} when there is none
     */
    public static String keyOf(String authorization) {
        if (authorization == null) {
            return null;
        }
        Matcher bearer = BEARER.matcher(authorization);
        if (bearer.matches()) {
            return bearer.group(1);
        }
        Matcher basic = BASIC.matcher(authorization.trim());
        if (basic.matches()) {
            try {
                String decoded = new String(Base64.getDecoder().decode(basic.group(1)), StandardCharsets.UTF_8);
                int colon = decoded.indexOf(':');
                String password = colon < 0 ? "" : decoded.substring(colon + 1);
                return password.isEmpty() ? null : password;
            } catch (IllegalArgumentException e) {
                return null;
            }
        }
        return null;
    }

    /**
     * Whether a request carries credentials at all (a key, right or wrong). An empty Authorization header is none:
     * some proxies forward an empty one when the client sent none.
     */
    public static boolean hasCredentials(String authorization) {
        return authorization != null && !authorization.trim().isEmpty();
    }
}
