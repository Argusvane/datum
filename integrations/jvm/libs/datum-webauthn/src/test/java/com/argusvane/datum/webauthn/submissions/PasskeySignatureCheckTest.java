package com.argusvane.datum.webauthn.submissions;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.DatumException;
import com.argusvane.datum.submissions.spi.AcceptedSubmission;
import com.argusvane.datum.submissions.spi.CandidateSubmission;
import com.argusvane.datum.submissions.spi.SignatureVerdict;
import com.argusvane.datum.submissions.spi.SubmissionMode;
import com.argusvane.datum.submissions.spi.SubmissionRequest;
import com.argusvane.datum.submissions.spi.ValidationScope;
import com.argusvane.datum.webauthn.FormSigning;
import com.argusvane.datum.webauthn.PasskeySubjectResolver;
import com.argusvane.datum.webauthn.TestSite;
import com.argusvane.datum.webauthn.WebAuthnSettings;
import java.security.Principal;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * The receiver's signature policy at {@link PasskeySignatureCheck}, codes and words included: a required signature,
 * the optional fallback and its switch, no passkey domain, and a kept rejection that claims its digest (replay).
 */
class PasskeySignatureCheckTest {

    private static final String CONFIRM = "I confirm these answers.";

    private final TestSite site = new TestSite();
    private FormSigning form = FormSigning.builder().mode(FormSigning.Mode.REQUIRED).statement(CONFIRM).build();

    private PasskeySignatureCheck check() {
        return new PasskeySignatureCheck(site.signatures(), site.settings(), key -> form, PasskeySubjectResolver.byPrincipalName());
    }

    private static CandidateSubmission candidate(ObjectNode document, SubmissionMode mode, Map<String, List<String>> headers, Principal principal) {
        ObjectNode envelope = document.has("payload") ? (ObjectNode) document.get("payload") : document;
        ObjectNode definition = JsonNodeFactory.instance.objectNode().put("id", "petition");
        ObjectNode values = envelope.has("submission") ? (ObjectNode) envelope.get("submission").get("values") : JsonNodeFactory.instance.objectNode();
        return new CandidateSubmission("petition", mode, definition, "0".repeat(64), document.deepCopy(), envelope.deepCopy(), values, "en",
            new ValidationScope("submission", null, null, null, mode == SubmissionMode.TEST), JsonNodeFactory.instance.objectNode(),
            new SubmissionRequest("application/json", headers, null, principal).toContext(null));
    }

    private static CandidateSubmission candidate(ObjectNode document) {
        return candidate(document, SubmissionMode.SUBMIT, Map.of(), null);
    }

    private static AcceptedSubmission accepted(SignatureVerdict verdict) {
        return new AcceptedSubmission("petition", "0".repeat(64), "0".repeat(64), "{}", JsonNodeFactory.instance.objectNode(), List.of(),
            JsonNodeFactory.instance.arrayNode(), List.of(), List.of(), List.of(), List.of(), null, null, verdict, "en", null,
            JsonNodeFactory.instance.arrayNode(), null, "http", "attempt-1");
    }

    private static String code(SignatureVerdict verdict) {
        return verdict.refusalErrors().isEmpty() ? null : verdict.refusalErrors().get(0).code();
    }

    private static DatumException thrown(Runnable call) {
        try {
            call.run();
        } catch (DatumException e) {
            return e;
        }
        throw new AssertionError("Expected a DatumException.");
    }

    /** A required signature at the receiver: valid, missing, replayed, stale, counter, unknown, revoked. */
    @Test
    void required() {
        PasskeySignatureCheck check = check();
        var authenticator = site.authenticator();
        var passkey = site.register(authenticator);

        ObjectNode body = site.signed(authenticator, Map.of("fullName", "Ada"), Map.of("statement", CONFIRM));
        SignatureVerdict valid = check.check(candidate(body));
        assertThat(valid.status()).isEqualTo(SignatureVerdict.Status.VALID);
        assertThat(valid.refuses()).isFalse();
        assertThat(valid.details()).containsEntry("status", "valid").containsEntry("passkeyId", passkey.id()).containsEntry("scope", "envelope")
            .containsEntry("statement", CONFIRM).containsKey("digest").containsKey("signedAt");
        check.recordUse(accepted(valid));
        assertThat(site.passkey(passkey.credentialId()).signCount()).as("The counter moves in the store.").isEqualTo(authenticator.counter());

        // The same signed document again: refused, with the wire's words.
        SignatureVerdict replay = check.check(candidate(body));
        assertThat(replay.refuses()).isTrue();
        assertThat(code(replay)).isEqualTo("signature.invalid");
        assertThat(replay.refusalErrors().get(0).message()).startsWith("This signed submission was already received.");
        // Unsigned: refused.
        SignatureVerdict unsigned = check.check(candidate(site.envelope(Map.of("fullName", "Ada"))));
        assertThat(code(unsigned)).isEqualTo("signature.required");
        assertThat(unsigned.status()).isEqualTo(SignatureVerdict.Status.ABSENT);
        // Another statement, or none: the page signed with settings the form no longer has (409 stale).
        DatumException stale = thrown(() -> check.check(candidate(site.signed(authenticator, Map.of("fullName", "Bo"), Map.of("statement", "Something else.")))));
        assertThat(List.of(stale.httpStatus(), stale.code())).containsExactly(409, "signature.stale");
        assertThat(stale.getMessage()).startsWith("This form's signing settings changed while you had it open");
        assertThat(thrown(() -> check.check(candidate(site.signed(authenticator, Map.of("fullName", "Bo"))))).code()).isEqualTo("signature.stale");
        // A counter that did not go up.
        SignatureVerdict counter = check.check(candidate(site.signed(authenticator, Map.of("fullName", "Cy"), Map.of("statement", CONFIRM, "counter", 1L))));
        assertThat(code(counter)).isEqualTo("signature.invalid");
        assertThat(counter.refusalErrors().get(0).message()).startsWith("Your passkey reported a signature count that did not go up");
        assertThat(counter.status()).isEqualTo(SignatureVerdict.Status.INVALID);
        // A passkey this site never registered: its own code, so the page can offer a new one.
        SignatureVerdict unknown = check.check(candidate(site.signed(site.authenticator(), Map.of("fullName", "Gus"), Map.of("statement", CONFIRM))));
        assertThat(code(unknown)).isEqualTo("signature.unknown");
        assertThat(unknown.refusalErrors().get(0).message()).isEqualTo(
            "The passkey you chose is not registered on this site. Make a new passkey for this site when offered, or send the form again and choose another of yours.");
        // A format that does not name "jcs", or no format at all: refused, never stored (a reload gives the form's).
        assertThat(thrown(() -> check.check(candidate(site.signed(authenticator, Map.of("fullName", "Hal"),
            Map.of("statement", CONFIRM, "canonicalization", "sorted-keys"))))).code()).isEqualTo("signature.stale");
        ObjectNode formatless = site.signed(authenticator, Map.of("fullName", "Dot"), Map.of("statement", CONFIRM));
        ((ObjectNode) formatless.get("signatures").get(0)).remove("format");
        assertThat(thrown(() -> check.check(candidate(formatless))).code()).isEqualTo("signature.stale");
        // Revoked: signs nothing new.
        site.revoke(passkey.id());
        assertThat(code(check.check(candidate(site.signed(authenticator, Map.of("fullName", "Kim"), Map.of("statement", CONFIRM))))))
            .isEqualTo("signature.unusable");
    }

    /** An optional form, the fallback for browsers without passkeys, and signing off. */
    @Test
    void optionalFallbackAndOff() {
        form = FormSigning.builder().mode(FormSigning.Mode.OPTIONAL).build();
        PasskeySignatureCheck check = check();
        var authenticator = site.authenticator();
        site.register(authenticator);

        // Unsigned: accepted, status none.
        SignatureVerdict plain = check.check(candidate(site.envelope(Map.of("fullName", "Ada"))));
        assertThat(plain.refuses()).isFalse();
        assertThat(plain.details()).containsEntry("status", "none");
        // An empty statement is none, as the engine reads it.
        ObjectNode empty = site.signed(authenticator, Map.of("fullName", "Al"));
        ((ObjectNode) empty.get("signatures").get(0)).put("statement", "");
        assertThat(check.check(candidate(empty)).status()).isEqualTo(SignatureVerdict.Status.VALID);
        // A stranger's signature on an optional form that verifies: refused.
        assertThat(code(check.check(candidate(site.signed(site.authenticator(), Map.of("fullName", "Di")))))).isEqualTo("signature.unknown");
        // Deviation (fail closed): verify off still refuses an invalid signature.
        form = FormSigning.builder().mode(FormSigning.Mode.OPTIONAL).verify(false).build();
        SignatureVerdict unverified = check.check(candidate(site.signed(site.authenticator(), Map.of("fullName", "Bo"))));
        assertThat(unverified.refuses()).isTrue();
        assertThat(unverified.status()).isEqualTo(SignatureVerdict.Status.INVALID);
        // With the check's own code and words, not the receiver's generic signature.invalid.
        assertThat(code(unverified)).isEqualTo("signature.unknown");
        // And a stale one is still a 409.
        DatumException stale = thrown(() -> check.check(candidate(site.signed(authenticator, Map.of("fullName", "Bo"), Map.of("statement", "Old.")))));
        assertThat(List.of(stale.httpStatus(), stale.code())).containsExactly(409, "signature.stale");

        // Required, a browser without passkeys: refused, or accepted and marked.
        form = FormSigning.builder().mode(FormSigning.Mode.REQUIRED).build();
        Map<String, List<String>> header = Map.of(PasskeySignatureCheck.UNAVAILABLE_HEADER, List.of("unavailable"));
        assertThat(code(check.check(candidate(site.envelope(Map.of("fullName", "Eve")), SubmissionMode.SUBMIT, header, null))))
            .isEqualTo("signature.required");
        form = FormSigning.builder().mode(FormSigning.Mode.REQUIRED).unavailable("accept").build();
        SignatureVerdict fallback = check.check(candidate(site.envelope(Map.of("fullName", "Eve")), SubmissionMode.SUBMIT, header, null));
        assertThat(fallback.refuses()).isFalse();
        assertThat(fallback.details()).containsEntry("status", "unavailable");
        assertThat(code(check.check(candidate(site.envelope(Map.of("fullName", "Fay")))))).as("Without the header, still required.")
            .isEqualTo("signature.required");

        // Signing off: nothing is judged.
        form = FormSigning.OFF;
        assertThat(check.check(candidate(site.signed(site.authenticator(), Map.of("fullName", "Gus"))))).isEqualTo(SignatureVerdict.absent());
    }

    /** A site with no passkey domain: a required form follows its policy for browsers without passkeys. */
    @Test
    void noPasskeyDomain() {
        site.configure(new WebAuthnSettings("", "Petition", List.of(), null, true, false, null, null, null, null));
        form = FormSigning.builder().mode(FormSigning.Mode.REQUIRED).build();
        PasskeySignatureCheck check = check();
        SignatureVerdict refused = check.check(candidate(site.envelope(Map.of("fullName", "Ada"))));
        assertThat(code(refused)).isEqualTo("signature.unavailable");
        assertThat(refused.refusalErrors().get(0).message()).startsWith("This form must be signed with a passkey, and passkeys are not set up");
        form = FormSigning.builder().mode(FormSigning.Mode.REQUIRED).unavailable("accept").build();
        SignatureVerdict accepted = check.check(candidate(site.signed(site.authenticator(), Map.of("fullName", "Ada"))));
        assertThat(accepted.refuses()).isFalse();
        assertThat(accepted.details()).containsEntry("status", "unavailable");
        // An optional form with a signature it cannot check: unverifiable; refused when it verifies on arrival.
        form = FormSigning.builder().mode(FormSigning.Mode.OPTIONAL).build();
        SignatureVerdict unverifiable = check.check(candidate(site.signed(site.authenticator(), Map.of("fullName", "Bo"))));
        assertThat(code(unverifiable)).isEqualTo("signature.unavailable");
        form = FormSigning.builder().mode(FormSigning.Mode.OPTIONAL).verify(false).build();
        SignatureVerdict kept = check.check(candidate(site.signed(site.authenticator(), Map.of("fullName", "Bo"))));
        assertThat(kept.refuses()).isFalse();
        assertThat(kept.status()).isEqualTo(SignatureVerdict.Status.UNVERIFIABLE);
    }

    /** Anonymous visitors while visitors may not sign. */
    @Test
    void anonymousVisitorsWhileTheyMayNotSign() {
        site.configure(new WebAuthnSettings("localhost", "Petition", List.of("http://localhost"), null, false, false, null, null, null, null));
        PasskeySignatureCheck check = check();
        SignatureVerdict required = check.check(candidate(site.envelope(Map.of("fullName", "Ada"))));
        assertThat(code(required)).isEqualTo("signature.sign_in");
        assertThat(required.refusalErrors().get(0).message()).startsWith("Sign in to send this form");
        form = FormSigning.builder().mode(FormSigning.Mode.OPTIONAL).build();
        assertThat(check.check(candidate(site.envelope(Map.of("fullName", "Ada")))).refuses()).isFalse();
        SignatureVerdict signedAnyway = check.check(candidate(site.signed(site.authenticator(), Map.of("fullName", "Ada"))));
        assertThat(code(signedAnyway)).isEqualTo("signature.sign_in");
        assertThat(signedAnyway.refusalErrors().get(0).message()).startsWith("Only people who are signed in can sign on this site.");
        // Signed in: judged.
        Principal ada = () -> "7";
        form = FormSigning.builder().mode(FormSigning.Mode.REQUIRED).build();
        assertThat(code(check.check(candidate(site.envelope(Map.of("fullName", "Ada")), SubmissionMode.SUBMIT, Map.of(), ada))))
            .isEqualTo("signature.required");
    }

    /** recordUse claims the digest just before the handler; a concurrent claim refuses; releaseUse gives it back. */
    @Test
    void recordAndReleaseUse() {
        form = FormSigning.builder().mode(FormSigning.Mode.REQUIRED).build();
        PasskeySignatureCheck check = check();
        var authenticator = site.authenticator();
        var passkey = site.register(authenticator);
        ObjectNode body = site.signed(authenticator, Map.of("fullName", "Ada"));
        SignatureVerdict first = check.check(candidate(body));
        SignatureVerdict second = check.check(candidate(body));
        assertThat(List.of(first.status(), second.status())).containsOnly(SignatureVerdict.Status.VALID);
        check.recordUse(accepted(first));
        DatumException replay = thrown(() -> check.recordUse(accepted(second)));
        assertThat(List.of(replay.httpStatus(), replay.code())).containsExactly(422, "signature.invalid");
        assertThat(replay.getMessage()).startsWith("This signed submission was already received.");

        // The handler did not store it: the use is given back, and the same document goes through again.
        check.releaseUse(accepted(first));
        assertThat(site.passkey(passkey.credentialId()).signCount()).isEqualTo(passkey.signCount());
        SignatureVerdict again = check.check(candidate(body));
        assertThat(again.status()).isEqualTo(SignatureVerdict.Status.VALID);
        check.recordUse(accepted(again));

        // Revoked between the check and the store.
        SignatureVerdict pending = check.check(candidate(site.signed(authenticator, Map.of("fullName", "Bo"))));
        site.revoke(passkey.id());
        assertThat(thrown(() -> check.recordUse(accepted(pending))).code()).isEqualTo("signature.unusable");

        // Nothing to record for a verdict that is not valid, or none.
        check.recordUse(accepted(SignatureVerdict.absent()));
        check.recordUse(accepted(null));
        check.releaseUse(accepted(null));
    }

    /** A dry run reports a stale signature in its verdict (its 200 report), never as a 409. */
    @Test
    void aDryRunReportsAStaleSignature() {
        PasskeySignatureCheck check = check();
        var authenticator = site.authenticator();
        site.register(authenticator);
        ObjectNode body = site.signed(authenticator, Map.of("fullName", "Bo"), Map.of("statement", "Something else."));
        SignatureVerdict reported = check.check(candidate(body, SubmissionMode.TEST, Map.of(), null));
        assertThat(reported.refuses()).isTrue();
        assertThat(reported.status()).isEqualTo(SignatureVerdict.Status.INVALID);
        assertThat(code(reported)).isEqualTo("signature.stale");
        assertThat(reported.refusalErrors().get(0).message()).startsWith("This form's signing settings changed while you had it open");
        // The delivery of the same body is still the 409.
        assertThat(thrown(() -> check.check(candidate(body))).httpStatus()).isEqualTo(409);
    }

    /** A valid verdict whose details do not name its use refuses (503), never accepts with the digest unclaimed. */
    @Test
    void aValidVerdictWithoutItsUseFailsClosed() {
        form = FormSigning.builder().mode(FormSigning.Mode.REQUIRED).build();
        PasskeySignatureCheck check = check();
        var authenticator = site.authenticator();
        var passkey = site.register(authenticator);
        SignatureVerdict valid = check.check(candidate(site.signed(authenticator, Map.of("fullName", "Ada"))));
        for (String lost : List.of("keySha256", "digest", "passkeyId", "signCount", "judgedAt")) {
            Map<String, Object> details = new java.util.LinkedHashMap<>(valid.details());
            details.remove(lost);
            DatumException refused = thrown(() -> check.recordUse(accepted(new SignatureVerdict(SignatureVerdict.Status.VALID, List.of(), details))));
            assertThat(List.of(refused.httpStatus(), refused.code())).as(lost).containsExactly(503, "server.unavailable");
        }
        Map<String, Object> text = new java.util.LinkedHashMap<>(valid.details());
        text.put("signCount", "3");
        assertThat(thrown(() -> check.recordUse(accepted(new SignatureVerdict(SignatureVerdict.Status.VALID, List.of(), text)))).httpStatus())
            .isEqualTo(503);
        assertThat(site.passkey(passkey.credentialId()).signCount()).as("Nothing moved.").isZero();
        // A copy whose whole numbers became Integers still records.
        Map<String, Object> copied = new java.util.LinkedHashMap<>(valid.details());
        copied.put("passkeyId", ((Number) copied.get("passkeyId")).intValue());
        copied.put("signCount", ((Number) copied.get("signCount")).intValue());
        check.recordUse(accepted(new SignatureVerdict(SignatureVerdict.Status.VALID, List.of(), copied)));
        assertThat(site.passkey(passkey.credentialId()).signCount()).isEqualTo(authenticator.counter());
    }

    /** A dry run judges the same way, and claims nothing. */
    @Test
    void aDryRunClaimsNothing() {
        form = FormSigning.builder().mode(FormSigning.Mode.REQUIRED).build();
        PasskeySignatureCheck check = check();
        var authenticator = site.authenticator();
        site.register(authenticator);
        ObjectNode body = site.signed(authenticator, Map.of("fullName", "Cy"));
        assertThat(check.check(candidate(body, SubmissionMode.TEST, Map.of(), null)).status()).isEqualTo(SignatureVerdict.Status.VALID);
        assertThat(check.check(candidate(body)).status()).as("A test claims no digest: the real submit still goes through.")
            .isEqualTo(SignatureVerdict.Status.VALID);
    }
}
