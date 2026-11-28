package com.argusvane.datum.webauthn;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.hooks.HookRefusedException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ObjectNode;

/**
 * The signing ceremony's hook: {@link SignatureCheckCustomizer}s run in order before the assertion is
 * verified, may refuse or check more strictly (user verification, a shorter window), never more leniently, and are not
 * asked about a signature an earlier step refused or this site does not judge.
 */
class SignatureCheckCustomizerTest {

    private static final PasskeySubject VISITOR = PasskeySubject.anonymous();
    private static final FormSigning PREFERRED = FormSigning.builder().mode(FormSigning.Mode.REQUIRED).build();
    private static final FormSigning REQUIRES_UV = FormSigning.builder().mode(FormSigning.Mode.REQUIRED).userVerification("required").build();

    private final Passkeys site = new Passkeys();

    private SignatureVerification verify(ObjectNode body, FormSigning form, String channel) {
        return site.signatures.verify("petition", form, body, body, VISITOR, channel);
    }

    /** In order, each over what the one before left; the draft names the form, the passkey and the channel. */
    @Test
    void theCustomizersRunInOrderOverOneDraft() {
        SoftwareAuthenticator authenticator = new SoftwareAuthenticator();
        PasskeyRecord passkey = site.register(authenticator);
        List<String> seen = new ArrayList<>();
        site.signatureCustomizers(List.of(
            draft -> {
                seen.add("first " + draft.formKey() + " " + draft.channel() + " " + draft.passkey().credentialId().equals(passkey.credentialId())
                    + " " + draft.userVerificationRequired() + " " + draft.window().getSeconds());
                draft.userVerificationRequired(true);
                draft.window(Duration.ofSeconds(300));
            },
            draft -> seen.add("second " + draft.userVerificationRequired() + " " + draft.window().getSeconds())));
        SignatureVerification valid = verify(site.signed(authenticator, Map.of("fullName", "Ada")), PREFERRED, "bus");
        assertThat(valid.status()).as(String.valueOf(valid.reason())).isEqualTo(SignatureVerification.Status.VALID);
        assertThat(seen).containsExactly("first petition bus true false 600", "second true 300");
        // The five-argument verify is the HTTP route's.
        seen.clear();
        site.signatures.verify("petition", PREFERRED, site.signed(authenticator, Map.of("fullName", "Bo")),
            site.signed(authenticator, Map.of("fullName", "Bo")), VISITOR);
        assertThat(seen.get(0)).contains(" http ");
    }

    /** Stricter: user verification for this form, and a shorter signing window. */
    @Test
    void aCustomizerChecksMoreStrictly() {
        SoftwareAuthenticator authenticator = new SoftwareAuthenticator();
        site.register(authenticator);
        ObjectNode noUv = site.signed(authenticator, Map.of("fullName", "Ada"), Map.of("uv", false));
        assertThat(verify(noUv, PREFERRED, "http").status()).isEqualTo(SignatureVerification.Status.VALID);
        site.signatureCustomizers(List.of(draft -> draft.userVerificationRequired(true)));
        assertThat(verify(noUv, PREFERRED, "http").code()).isEqualTo("userVerified");

        site.signatureCustomizers(List.of(draft -> draft.window(Duration.ofSeconds(60))));
        ObjectNode body = site.signed(authenticator, Map.of("fullName", "Bo"));
        site.clock.advance(Duration.ofSeconds(61));
        assertThat(verify(body, PREFERRED, "http").code()).isEqualTo("window");
        site.signatureCustomizers(List.of());
        assertThat(verify(body, PREFERRED, "http").status()).isEqualTo(SignatureVerification.Status.VALID);
    }

    /** Never weaker: a value weaker than the form's or the site's fails the request as the customizer's error. */
    @Test
    void aWeakerValueIsTheCustomizersError() {
        SoftwareAuthenticator authenticator = new SoftwareAuthenticator();
        site.register(authenticator);
        ObjectNode body = site.signed(authenticator, Map.of("fullName", "Ada"));
        site.signatureCustomizers(List.of(draft -> draft.userVerificationRequired(false)));
        assertThatThrownBy(() -> verify(body, REQUIRES_UV, "http")).isInstanceOf(IllegalArgumentException.class);
        site.signatureCustomizers(List.of(draft -> draft.window(Duration.ofSeconds(601))));
        assertThatThrownBy(() -> verify(body, PREFERRED, "http")).isInstanceOf(IllegalArgumentException.class);
        site.signatureCustomizers(List.of(draft -> draft.window(Duration.ZERO)));
        assertThatThrownBy(() -> verify(body, PREFERRED, "http")).isInstanceOf(IllegalArgumentException.class);
        site.signatureCustomizers(List.of(draft -> draft.window(null)));
        assertThatThrownBy(() -> verify(body, PREFERRED, "http")).isInstanceOf(IllegalArgumentException.class);
        // A form that requires it may be required again.
        site.signatureCustomizers(List.of(draft -> draft.userVerificationRequired(true)));
        assertThat(verify(body, REQUIRES_UV, "http").status()).isEqualTo(SignatureVerification.Status.VALID);
    }

    /**
     * Never weaker than an earlier customizer either: the draft only tightens, so a later hook (another starter's, say)
     * cannot undo what one before it required.
     */
    @Test
    void aLaterCustomizerCannotUndoAnEarlierOne() {
        SoftwareAuthenticator authenticator = new SoftwareAuthenticator();
        site.register(authenticator);
        ObjectNode body = site.signed(authenticator, Map.of("fullName", "Ada"));
        site.signatureCustomizers(List.of(
            draft -> draft.userVerificationRequired(true),
            draft -> draft.userVerificationRequired(false)));
        assertThatThrownBy(() -> verify(body, PREFERRED, "http")).isInstanceOf(IllegalArgumentException.class);
        site.signatureCustomizers(List.of(
            draft -> draft.window(Duration.ofSeconds(60)),
            draft -> draft.window(Duration.ofSeconds(600))));
        assertThatThrownBy(() -> verify(body, PREFERRED, "http")).isInstanceOf(IllegalArgumentException.class);
        // The same value again, or a stricter one, is fine; so is false where nothing required verification yet.
        List<String> seen = new ArrayList<>();
        site.signatureCustomizers(List.of(
            draft -> {
                draft.userVerificationRequired(false);
                draft.window(Duration.ofSeconds(300));
            },
            draft -> {
                draft.userVerificationRequired(true);
                draft.userVerificationRequired(true);
                draft.window(Duration.ofSeconds(300));
                draft.window(Duration.ofSeconds(120));
                seen.add(draft.userVerificationRequired() + " " + draft.window().getSeconds());
            }));
        assertThat(verify(body, PREFERRED, "http").status()).isEqualTo(SignatureVerification.Status.VALID);
        assertThat(seen).containsExactly("true 120");
    }

    /** A refusal propagates as the hook's own, before the assertion is checked, and nothing is recorded. */
    @Test
    void aRefusalPropagatesAndRecordsNothing() {
        SoftwareAuthenticator authenticator = new SoftwareAuthenticator();
        PasskeyRecord passkey = site.register(authenticator);
        site.signatureCustomizers(List.of(draft -> {
            if (draft.passkey().aaguid().equals("00000000-0000-0000-0000-000000000000")) {
                throw HookRefusedException.forbidden("signature.policy", "This form takes passkeys of known makes only.");
            }
        }));
        ObjectNode body = site.signed(authenticator, Map.of("fullName", "Ada"));
        assertThatThrownBy(() -> verify(body, PREFERRED, "http"))
            .isInstanceOfSatisfying(HookRefusedException.class, e -> {
                assertThat(e.kind()).isEqualTo(HookRefusedException.Kind.FORBIDDEN);
                assertThat(e.code()).isEqualTo("signature.policy");
            });
        assertThat(site.repository.find(passkey.credentialId()).orElseThrow().lastUsed()).isNull();
        // Anything else a customizer throws fails the request as thrown.
        site.signatureCustomizers(List.of(draft -> {
            throw new IllegalStateException("the policy service is down");
        }));
        assertThatThrownBy(() -> verify(body, PREFERRED, "http")).isInstanceOf(IllegalStateException.class);
    }

    /** Not asked about a signature an earlier step refused, nor one this site does not judge. */
    @Test
    void notAskedAboutWhatEarlierStepsRefuseOrNobodyJudges() {
        site.signatureCustomizers(List.of(draft -> {
            throw new AssertionError("asked about " + draft.passkey().credentialId());
        }));
        SoftwareAuthenticator unregistered = new SoftwareAuthenticator();
        assertThat(verify(site.signed(unregistered, Map.of("fullName", "Ada")), PREFERRED, "http").code()).isEqualTo("unknown");
        SoftwareAuthenticator authenticator = new SoftwareAuthenticator();
        PasskeyRecord passkey = site.register(authenticator);
        FormSigning stated = FormSigning.builder().mode(FormSigning.Mode.REQUIRED).statement("I confirm.").build();
        assertThat(verify(site.signed(authenticator, Map.of("fullName", "Ada")), stated, "http").code()).isEqualTo("statement");
        site.repository.revoke(passkey.id(), "1", site.clock.instant());
        assertThat(verify(site.signed(authenticator, Map.of("fullName", "Bo")), PREFERRED, "http").code()).isEqualTo("revoked");

        // Visitors may not sign here: their signature is never judged (the seam answers signature.sign_in).
        Passkeys closed = new Passkeys(new WebAuthnSettings("localhost", "Petition", List.of("http://localhost"), null, false, false, null, null, null, null));
        SoftwareAuthenticator visitor = new SoftwareAuthenticator();
        closed.register(visitor);
        closed.signatureCustomizers(List.of(draft -> {
            throw new AssertionError("asked about a visitor's signature");
        }));
        ObjectNode body = closed.signed(visitor, Map.of("fullName", "Cy"));
        assertThat(closed.signatures.verify("petition", PREFERRED, body, body, VISITOR, "http").status()).isNotNull();
    }
}
