package com.argusvane.datum.webauthn;

import java.util.Map;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The software authenticator for tests outside this package (the web and Spring layers): a platform
 * authenticator that answers a registration challenge's options as the engine's {@code registerCredential()}
 * would, and signs envelopes as the glue does. Wraps the package-private {@link SoftwareAuthenticator}.
 */
public final class WebAuthnTestKit {

    /** A software passkey: ES256, origin {@code http://localhost}, relying party {@code localhost}. */
    public static final class Authenticator {

        private final SoftwareAuthenticator inner;

        public Authenticator() {
            this.inner = new SoftwareAuthenticator();
        }

        public Authenticator(int algorithm) {
            this.inner = new SoftwareAuthenticator(algorithm);
        }

        /** The credential id, base64url. */
        public String credentialId() {
            return Base64Url.encode(inner.credentialId);
        }

        /** The counter the next assertion carries minus one. */
        public long counter() {
            return inner.counter;
        }

        public void setCounter(long counter) {
            inner.counter = counter;
        }

        /** The SPKI of the key. */
        public byte[] spki() {
            return inner.spki.clone();
        }

        /** The same key under another credential id (a key read off a signature). */
        public Authenticator withCredentialId(byte[] id) {
            return new Authenticator(inner.copyWithCredentialId(id));
        }

        private Authenticator(SoftwareAuthenticator inner) {
            this.inner = inner;
        }

        /**
         * What registerCredential() returns for the options a challenge endpoint answered ({@code challenge},
         * {@code user.id}): the credential object the register endpoint takes.
         */
        public ObjectNode credentialFor(JsonNode options) {
            String handle = options.get("user").get("id").asString();
            inner.userHandle = Base64Url.decode(handle);
            return inner.register(options.get("challenge").asString(), Map.of("userHandle", handle));
        }

        /** The same, with the negative-test overrides {@link SoftwareAuthenticator#register} knows. */
        public ObjectNode credentialFor(JsonNode options, Map<String, Object> overrides) {
            String handle = options.get("user").get("id").asString();
            inner.userHandle = Base64Url.decode(handle);
            java.util.Map<String, Object> all = new java.util.LinkedHashMap<>(overrides);
            all.putIfAbsent("userHandle", handle);
            return inner.register(options.get("challenge").asString(), all);
        }

        /** The assertion a get() ceremony makes for the options a check-challenge endpoint answered. */
        public ObjectNode assertionFor(JsonNode options) {
            return inner.assertion(Base64Url.decode(options.get("challenge").asString()));
        }

        public ObjectNode assertionFor(JsonNode options, Map<String, Object> overrides) {
            return inner.assertion(Base64Url.decode(options.get("challenge").asString()), overrides);
        }

        /** An envelope signed as the glue signs it. */
        public ObjectNode sign(String formId, Map<String, Object> values, Map<String, Object> options) {
            return inner.signSubmission(SoftwareAuthenticator.envelope(formId, values), options);
        }
    }

    private WebAuthnTestKit() {
    }

    /** A submission envelope of the shape the browser sends (the signed document). */
    public static ObjectNode envelope(String formId, Map<String, Object> values) {
        return SoftwareAuthenticator.envelope(formId, values);
    }
}
