package com.argusvane.datum.webauthn;

import java.util.Map;
import tools.jackson.databind.node.ObjectNode;

/**
 * The tests' passkey site ({@link Passkeys}) for tests in other packages: the receiver seam's.
 */
public final class TestSite {

    private final Passkeys site = new Passkeys();

    /** A software passkey a test outside this package can hold. */
    public static final class Signer {
        private final SoftwareAuthenticator authenticator;

        private Signer(SoftwareAuthenticator authenticator) {
            this.authenticator = authenticator;
        }

        public long counter() {
            return authenticator.counter;
        }
    }

    public void configure(WebAuthnSettings settings) {
        site.configure(settings);
    }

    public WebAuthnSettings settings() {
        return site.settings;
    }

    public SubmissionSignatureVerifier signatures() {
        return site.signatures;
    }

    public Signer authenticator() {
        return new Signer(new SoftwareAuthenticator());
    }

    public PasskeyRecord register(Signer signer) {
        return site.register(signer.authenticator);
    }

    public ObjectNode signed(Signer signer, Map<String, Object> values, Map<String, Object> options) {
        return site.signed(signer.authenticator, values, options);
    }

    public ObjectNode signed(Signer signer, Map<String, Object> values) {
        return site.signed(signer.authenticator, values);
    }

    public ObjectNode envelope(Map<String, Object> values) {
        return SoftwareAuthenticator.envelope("petition", values);
    }

    public PasskeyRecord passkey(String credentialId) {
        return site.repository.find(credentialId).orElseThrow();
    }

    public void revoke(long id) {
        site.repository.revoke(id, "1", site.clock.instant());
    }
}
