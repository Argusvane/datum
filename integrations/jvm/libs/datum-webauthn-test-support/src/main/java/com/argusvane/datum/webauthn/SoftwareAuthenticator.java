package com.argusvane.datum.webauthn;

import com.argusvane.datum.core.canonical.Jcs;
import java.io.ByteArrayOutputStream;
import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * A software passkey for tests: creates and asserts as a platform would (on the JCA; the engine's own software
 * authenticator, engine/tests/webauthn-fixture.ts, has the same options).
 *
 * <p>A P-256 (ES256) or RSA 2048 (RS256) key pair, a random credential id, attestation "none".
 * {@link #register} answers what the engine's {@code registerCredential()} posts (its record with the raw
 * ceremony outputs under {@code response}); {@link #assertion} answers a WebAuthnAssertion,
 * and {@link #signSubmission} the delivered document a signed submission is.
 */
final class SoftwareAuthenticator {

    static final JsonMapper JSON = JsonMapper.builder().build();
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final DateTimeFormatter SIGNED_AT = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'.000Z'").withZone(ZoneOffset.UTC);

    final KeyPair keys;
    byte[] credentialId;
    final byte[] spki;
    /** The signature counter; 0 keeps none. */
    long counter;
    final String rpId;
    final String origin;
    final int algorithm;
    byte[] userHandle;
    Clock clock = Clock.systemUTC();

    SoftwareAuthenticator() {
        this(CoseKey.ES256);
    }

    SoftwareAuthenticator(int algorithm) {
        this("localhost", "http://localhost", algorithm, "handle".getBytes(StandardCharsets.UTF_8), true);
    }

    SoftwareAuthenticator(String rpId, String origin, int algorithm, byte[] userHandle, boolean counts) {
        this.rpId = rpId;
        this.origin = origin;
        this.algorithm = algorithm;
        this.userHandle = userHandle;
        try {
            if (algorithm == CoseKey.RS256) {
                KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
                generator.initialize(2048);
                keys = generator.generateKeyPair();
            } else {
                KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
                generator.initialize(new ECGenParameterSpec("secp256r1"));
                keys = generator.generateKeyPair();
            }
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
        credentialId = random(16);
        spki = keys.getPublic().getEncoded();
        counter = counts ? 1 : 0;
    }

    private SoftwareAuthenticator(SoftwareAuthenticator other) {
        this.rpId = other.rpId;
        this.origin = other.origin;
        this.algorithm = other.algorithm;
        this.userHandle = other.userHandle.clone();
        this.keys = other.keys;
        this.credentialId = other.credentialId.clone();
        this.spki = other.spki.clone();
        this.counter = other.counter;
        this.clock = other.clock;
    }

    /** The same key under another credential id: a key read off a signature. */
    SoftwareAuthenticator copyWithCredentialId(byte[] id) {
        SoftwareAuthenticator copy = new SoftwareAuthenticator(this);
        copy.credentialId = id;
        return copy;
    }

    static byte[] random(int length) {
        byte[] bytes = new byte[length];
        RANDOM.nextBytes(bytes);
        return bytes;
    }

    static byte[] sha256(byte[] bytes) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(bytes);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    static byte[] sha256(String text) {
        return sha256(text.getBytes(StandardCharsets.UTF_8));
    }

    /** The COSE key of the credential. */
    Map<Object, Object> cose() {
        Map<Object, Object> cose = new LinkedHashMap<>();
        if (algorithm == CoseKey.RS256) {
            RSAPublicKey key = (RSAPublicKey) keys.getPublic();
            cose.put(1L, 3L);
            cose.put(3L, (long) CoseKey.RS256);
            cose.put(-1L, new TestCbor.Bytes(unsigned(key.getModulus())));
            cose.put(-2L, new TestCbor.Bytes(unsigned(key.getPublicExponent())));
            return cose;
        }
        ECPublicKey key = (ECPublicKey) keys.getPublic();
        cose.put(1L, 2L);
        cose.put(3L, (long) CoseKey.ES256);
        cose.put(-1L, 1L);
        cose.put(-2L, new TestCbor.Bytes(pad(unsigned(key.getW().getAffineX()), 32)));
        cose.put(-3L, new TestCbor.Bytes(pad(unsigned(key.getW().getAffineY()), 32)));
        return cose;
    }

    private static byte[] unsigned(BigInteger value) {
        byte[] bytes = value.toByteArray();
        int start = 0;
        while (start < bytes.length - 1 && bytes[start] == 0) {
            start++;
        }
        return Arrays.copyOfRange(bytes, start, bytes.length);
    }

    private static byte[] pad(byte[] bytes, int size) {
        if (bytes.length >= size) {
            return bytes;
        }
        byte[] out = new byte[size];
        System.arraycopy(bytes, 0, out, size - bytes.length, bytes.length);
        return out;
    }

    private static byte[] concat(byte[]... parts) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (byte[] part : parts) {
            out.writeBytes(part);
        }
        return out.toByteArray();
    }

    private static byte[] u32(long value) {
        return ByteBuffer.allocate(4).putInt((int) value).array();
    }

    private static byte[] u16(int value) {
        return new byte[] {(byte) (value >> 8), (byte) value};
    }

    /**
     * What registerCredential() returns for a create() with this challenge.
     *
     * @param challenge the challenge, base64url, as the server handed it out
     * @param options overrides for negative tests: uv (Boolean), type, origin, rpId (String), flags (Integer),
     *     userHandle (base64url String, reported as the engine reports it), aaguid (16 raw bytes), cose (a
     *     COSE key, a map or anything else {@link TestCbor} writes, instead of the credential's own), bare (Boolean:
     *     authenticator data of 37 bytes, no attested credential data)
     */
    ObjectNode register(String challenge, Map<String, Object> options) {
        int flags = options.containsKey("flags")
            ? (Integer) options.get("flags")
            : 0x01 | 0x40 | (bool(options, "uv", true) ? 0x04 : 0) | 0x08 | 0x10;
        byte[] authData = bool(options, "bare", false)
            ? concat(sha256(text(options, "rpId", rpId)), new byte[] {(byte) flags}, u32(0))
            : concat(
                sha256(text(options, "rpId", rpId)),
                new byte[] {(byte) flags},
                u32(0),
                options.containsKey("aaguid") ? (byte[]) options.get("aaguid") : new byte[16],
                u16(credentialId.length),
                credentialId,
                TestCbor.encode(options.containsKey("cose") ? options.get("cose") : cose()));
        ObjectNode clientData = JSON.createObjectNode();
        clientData.put("type", text(options, "type", "webauthn.create"));
        clientData.put("challenge", challenge);
        clientData.put("origin", text(options, "origin", origin));
        clientData.put("crossOrigin", false);
        Map<Object, Object> attestation = new LinkedHashMap<>();
        attestation.put("fmt", "none");
        attestation.put("attStmt", new LinkedHashMap<>());
        attestation.put("authData", new TestCbor.Bytes(authData));
        ObjectNode record = JSON.createObjectNode();
        record.put("id", Base64Url.encode(credentialId));
        record.put("name", "Test key");
        record.put("publicKey", Base64.getEncoder().encodeToString(spki));
        record.put("algorithm", algorithm);
        record.set("transports", JSON.createArrayNode().add("internal").add("hybrid"));
        record.put("signCount", 0);
        ObjectNode recordFlags = record.putObject("flags");
        recordFlags.put("userVerified", true);
        recordFlags.put("backupEligible", true);
        recordFlags.put("backedUp", true);
        record.put("createdAt", Instant.now(clock).toString());
        if (options.containsKey("userHandle")) {
            record.put("userHandle", (String) options.get("userHandle"));
        }
        ObjectNode response = record.putObject("response");
        response.put("clientDataJSON", Base64Url.encode(JSON.writeValueAsString(clientData).getBytes(StandardCharsets.UTF_8)));
        response.put("authenticatorData", Base64Url.encode(authData));
        response.put("attestationObject", Base64Url.encode(TestCbor.encode(attestation)));
        response.set("transports", JSON.createArrayNode().add("internal").add("hybrid"));
        return record;
    }

    ObjectNode register(String challenge) {
        return register(challenge, Map.of());
    }

    /**
     * An assertion over a raw challenge: what requestAssertion() archives.
     *
     * @param options overrides: uv (Boolean), type, origin, rpId (String), counter (Long); and also
     *     crossOrigin (Boolean, the client data's member), topOrigin (String), flags (Integer, the whole byte) and
     *     clientData (a Map of further client data members, signed as they are)
     */
    ObjectNode assertion(byte[] challenge, Map<String, Object> options) {
        if (counter > 0) {
            counter++;
        }
        long count = options.containsKey("counter") ? ((Number) options.get("counter")).longValue() : counter;
        byte[] authData = concat(
            sha256(text(options, "rpId", rpId)),
            new byte[] {(byte) (options.containsKey("flags")
                ? (Integer) options.get("flags")
                : 0x01 | (bool(options, "uv", true) ? 0x04 : 0) | 0x08 | 0x10)},
            u32(count));
        ObjectNode clientData = JSON.createObjectNode();
        clientData.put("type", text(options, "type", "webauthn.get"));
        clientData.put("challenge", Base64Url.encode(challenge));
        clientData.put("origin", text(options, "origin", origin));
        clientData.put("crossOrigin", bool(options, "crossOrigin", false));
        if (options.containsKey("topOrigin")) {
            clientData.put("topOrigin", (String) options.get("topOrigin"));
        }
        if (options.containsKey("clientData")) {
            clientData.setAll((ObjectNode) JSON.valueToTree(options.get("clientData")));
        }
        byte[] clientJson = JSON.writeValueAsString(clientData).getBytes(StandardCharsets.UTF_8);
        byte[] signature;
        try {
            Signature signer = Signature.getInstance(algorithm == CoseKey.RS256 ? "SHA256withRSA" : "SHA256withECDSA");
            signer.initSign(keys.getPrivate());
            signer.update(concat(authData, sha256(clientJson)));
            signature = signer.sign();
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
        ObjectNode assertion = JSON.createObjectNode();
        assertion.put("credentialId", Base64Url.encode(credentialId));
        assertion.put("authenticatorData", Base64Url.encode(authData));
        assertion.put("clientDataJSON", Base64Url.encode(clientJson));
        assertion.put("signature", Base64Url.encode(signature));
        assertion.put("userHandle", Base64Url.encode(userHandle));
        assertion.put("publicKey", Base64.getEncoder().encodeToString(spki));
        assertion.put("algorithm", algorithm);
        assertion.put("rpId", text(options, "rpId", rpId));
        assertion.put("origin", text(options, "origin", origin));
        assertion.put("signedAt", SIGNED_AT.format(Instant.now(clock)));
        return assertion;
    }

    ObjectNode assertion(byte[] challenge) {
        return assertion(challenge, Map.of());
    }

    /**
     * Signs a submission envelope the way the page glue does: JCS of the scoped part, or of
     * {document, statement}; the result embedded in the envelope or around it in a wrapper.
     *
     * @param options scope, placement, statement, canonicalization (String), signedAt (Long, ms), and the
     *     assertion's uv, origin, counter, crossOrigin
     */
    ObjectNode signSubmission(ObjectNode envelope, Map<String, Object> options) {
        ObjectNode format = JSON.createObjectNode();
        format.put("scope", text(options, "scope", "envelope"));
        format.put("placement", text(options, "placement", "embedded"));
        format.put("digest", "sha-256");
        format.put("canonicalization", text(options, "canonicalization", "jcs"));
        JsonNode part = switch (format.get("scope").asString()) {
            case "values" -> envelope.get("submission").get("values");
            case "submission" -> envelope.get("submission");
            default -> envelope;
        };
        String statement = (String) options.get("statement");
        String text;
        if (statement != null) {
            ObjectNode wrapped = JSON.createObjectNode();
            wrapped.set("document", part);
            wrapped.put("statement", statement);
            text = jcs(wrapped);
        } else {
            text = jcs(part);
        }
        Map<String, Object> overrides = new LinkedHashMap<>();
        for (String key : List.of("uv", "origin", "counter", "crossOrigin")) {
            if (options.containsKey(key)) {
                overrides.put(key, options.get(key));
            }
        }
        ObjectNode assertion = assertion(sha256(text), overrides);
        ObjectNode signature = JSON.createObjectNode();
        signature.put("participantId", "submitter");
        signature.put("algorithm", algorithm == CoseKey.RS256 ? "webauthn-rs256" : "webauthn-es256");
        signature.put("signature", assertion.get("signature").asString());
        signature.put("signedAt", options.containsKey("signedAt") ? ((Number) options.get("signedAt")).longValue() : Instant.now(clock).toEpochMilli());
        signature.set("format", format);
        signature.set("webauthn", assertion);
        if (statement != null) {
            signature.put("statement", statement);
        }
        if ("wrapper".equals(format.get("placement").asString())) {
            ObjectNode wrapper = JSON.createObjectNode();
            wrapper.set("format", format.deepCopy());
            wrapper.set("payload", envelope.deepCopy());
            wrapper.set("signatures", JSON.createArrayNode().add(signature));
            return wrapper;
        }
        ObjectNode signed = envelope.deepCopy();
        ArrayNode signatures = signed.putArray("signatures");
        signatures.add(signature);
        return signed;
    }

    /**
     * The text the engine signs: RFC 8785 by java-json-canonicalization, which spells numbers as ECMAScript does
     * (so a test over an answer such as 2^-24 proves the server rebuilds the browser's text, not its own). A part
     * the library cannot take (a lone surrogate, which JSON.stringify writes escaped) falls back to datum-core's
     * writer, so the verifier's own refusal is what such a test sees.
     */
    static String jcs(JsonNode part) {
        try {
            return new org.erdtman.jcs.JsonCanonicalizer(JSON.writeValueAsString(part)).getEncodedString();
        } catch (java.io.IOException | RuntimeException e) {
            return Jcs.canonicalize(part);
        }
    }

    ObjectNode signSubmission(ObjectNode envelope) {
        return signSubmission(envelope, Map.of());
    }

    /** A submission envelope of the shape the browser sends. */
    static ObjectNode envelope(String formId, Map<String, Object> values) {
        ObjectNode envelope = JSON.createObjectNode();
        ObjectNode context = envelope.putObject("versionContext");
        ObjectNode form = context.putObject("form");
        form.put("id", formId);
        form.put("version", "1.0.0");
        ObjectNode client = context.putObject("client");
        client.put("runtimeVersion", "1.0.0");
        client.put("rendererVersion", "1.0.0");
        client.put("schemaVersion", "1");
        ObjectNode submission = envelope.putObject("submission");
        submission.put("locale", "en");
        submission.set("values", JSON.valueToTree(values));
        return envelope;
    }

    private static boolean bool(Map<String, Object> options, String key, boolean fallback) {
        Object value = options.get(key);
        return value == null ? fallback : (Boolean) value;
    }

    private static String text(Map<String, Object> options, String key, String fallback) {
        Object value = options.get(key);
        return value == null ? fallback : (String) value;
    }
}
