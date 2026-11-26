package com.argusvane.datum.webauthn;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import tools.jackson.databind.node.ObjectNode;

/**
 * A site with passkeys for the tests, in memory: the ceremony, the submission verifier and the stores over one
 * clock.
 */
final class Passkeys {

    static final byte[] SECRET = "the test site's secret: 32 bytes or more".getBytes(StandardCharsets.UTF_8);

    final MutableClock clock = MutableClock.now();
    WebAuthnSettings settings;
    final InMemoryPasskeyRepository repository = new InMemoryPasskeyRepository();
    final InMemoryPasskeyUseStore uses = new InMemoryPasskeyUseStore(repository);
    final InMemoryChallengeClaims claims = new InMemoryChallengeClaims();
    final WebAuthnVerifier verifier = new WebAuthnVerifier();
    final PasskeyChallenges challenges = new PasskeyChallenges(SECRET, clock, claims);
    RegistrationCeremony ceremony;
    SubmissionSignatureVerifier signatures;

    Passkeys() {
        this(new WebAuthnSettings("localhost", "Petition", List.of("http://localhost"), null, true));
    }

    Passkeys(WebAuthnSettings settings) {
        configure(settings);
    }

    void configure(WebAuthnSettings settings) {
        this.settings = settings;
        ceremony = new RegistrationCeremony(settings, challenges, repository, verifier, clock);
        signatures = new SubmissionSignatureVerifier(settings, repository, uses, verifier, clock);
    }

    /** The submission verifier with the application's signature-check hooks, in this order. */
    void signatureCustomizers(List<SignatureCheckCustomizer> customizers) {
        signatures = new SubmissionSignatureVerifier(settings, repository, uses, verifier, clock, customizers);
    }

    /** The form's context for a form's submit. */
    PasskeyContext context(PasskeySubject account, FormSigning form) {
        return PasskeyContext.forForm("petition", account, "submit", settings.perForm(), form,
            account.isAnonymous() ? "Petition signer" : "Passkey for Petition");
    }

    /** Registers a passkey for an account through the ceremony's path. */
    PasskeyRecord register(SoftwareAuthenticator authenticator, String label, PasskeySubject account) {
        PasskeyContext context = context(account, FormSigning.builder().mode(FormSigning.Mode.REQUIRED).build());
        RegistrationOptions options = ceremony.challenge(context, account, label);
        assertThat(options.rp().id()).isEqualTo("localhost");
        assertThat(options.user().name()).isEqualTo(label);
        authenticator.userHandle = Base64Url.decode(options.user().id());
        authenticator.clock = clock;
        PasskeyRecord passkey = ceremony.register(context, account, posted(options.token(), label,
            authenticator.register(options.challenge(), Map.of("userHandle", options.user().id()))), "Chrome on macOS");
        assertThat(repository.find(passkey.credentialId())).isPresent();
        return passkey;
    }

    PasskeyRecord register(SoftwareAuthenticator authenticator) {
        return register(authenticator, "Ada Lovelace", PasskeySubject.anonymous());
    }

    /** A registration as the glue posts it. */
    static ObjectNode posted(String token, String label, ObjectNode credential) {
        ObjectNode posted = SoftwareAuthenticator.JSON.createObjectNode();
        posted.put("token", token);
        if (label != null) {
            posted.put("label", label);
        }
        posted.set("credential", credential);
        return posted;
    }

    /** A signed envelope. */
    ObjectNode signed(SoftwareAuthenticator authenticator, Map<String, Object> values, Map<String, Object> options) {
        authenticator.clock = clock;
        return authenticator.signSubmission(SoftwareAuthenticator.envelope("petition", values), options);
    }

    ObjectNode signed(SoftwareAuthenticator authenticator, Map<String, Object> values) {
        return signed(authenticator, values, Map.of());
    }

    /** The verdict on a delivered document, as the receiver asks for it. */
    SignatureVerification verify(ObjectNode document, FormSigning form, PasskeySubject submitter) {
        ObjectNode envelope = document.has("payload") ? (ObjectNode) document.get("payload") : document;
        return signatures.verify("petition", form, document, envelope, submitter);
    }
}
