package com.argusvane.datum.webauthn.submissions;

import com.argusvane.datum.core.DatumException;
import com.argusvane.datum.submissions.spi.AcceptedSubmission;
import com.argusvane.datum.submissions.spi.CandidateSubmission;
import com.argusvane.datum.submissions.spi.SignatureVerdict;
import com.argusvane.datum.submissions.spi.SubmissionError;
import com.argusvane.datum.submissions.spi.SubmissionMode;
import com.argusvane.datum.submissions.spi.SubmissionSignatureCheck;
import com.argusvane.datum.webauthn.FormSigning;
import com.argusvane.datum.webauthn.FormSigningSource;
import com.argusvane.datum.webauthn.PasskeySubject;
import com.argusvane.datum.webauthn.PasskeySubjectResolver;
import com.argusvane.datum.webauthn.PasskeyUseStore;
import com.argusvane.datum.webauthn.SignatureReplayException;
import com.argusvane.datum.webauthn.SignatureVerification;
import com.argusvane.datum.webauthn.SubmissionSignatureVerifier;
import com.argusvane.datum.webauthn.WebAuthnSettings;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The passkey signature seam of the submission receiver: the verdict, its refusals and the replay guard over
 * {@link SubmissionSignatureVerifier}. It is wired as the {@link SubmissionSignatureCheck} bean.
 *
 * <p>Off (the form's mode): nothing is judged, status absent. Otherwise the verifier judges it, and:
 * <ul>
 *   <li>an anonymous visitor while visitors may not sign: a required form refuses them (422
 *       {@code signature.sign_in}), and so does an optional one they sent a signature to anyway; an optional
 *       one they sent unsigned passes;</li>
 *   <li>a valid signature passes;</li>
 *   <li>while the site's passkeys are not set up, a required form follows its policy for browsers without
 *       passkeys whatever arrives (accepted as unavailable, or 422 {@code signature.unavailable});</li>
 *   <li>no signature passes an optional form; a required one refuses it (422 {@code signature.required}) unless
 *       the browser said it has no passkeys ({@code X-Datum-Signing: unavailable}) and the form accepts that;</li>
 *   <li>an invalid one refuses: 409 {@code signature.stale} when the page signed with settings the form no
 *       longer has (its statement or scope, or an older format), thrown as a {@link DatumException} on a
 *       delivery so the receiver answers that status, and in a dry run ({@link SubmissionMode#dryRun()}: a test or a PDF request) given
 *       as the verdict's error so it lands in the 200 report (a dry run reports every check rather than answering
 *       409); 422 {@code signature.unknown} for a passkey not registered here; 422
 *       {@code signature.unusable} for one that may not sign here (revoked, another account's or another form's,
 *       another user handle); else 422 {@code signature.invalid}. Each code's words are a fixed sentence, never
 *       the English reason, which goes to the log.</li>
 * </ul>
 *
 * <p>The application's {@code SignatureCheckCustomizer}s run inside the verifier with the submission's channel;
 * their {@code HookRefusedException} propagates as the hook's own refusal (403, 409 or 422 with the errors body).
 *
 * <p>Fail closed: datum-submissions' {@link SignatureVerdict} always refuses an INVALID signature, so {@code verify}
 * off only lets an unverifiable one through. A replay is refused whatever the form says.
 *
 * <p>{@link #recordUse} claims the digest and moves the counter just before the handler; {@link #releaseUse}
 * gives both back when the handler did not store the submission. The verdict's details carry what that needs,
 * as plain values. A valid verdict whose details do not name the use fails closed (503
 * {@code server.unavailable}): it is never accepted with its digest unclaimed.
 */
public final class PasskeySignatureCheck implements SubmissionSignatureCheck {

    /** The header the glue sends when the browser has no passkeys. */
    public static final String UNAVAILABLE_HEADER = "X-Datum-Signing";

    private static final Logger LOG = LoggerFactory.getLogger(PasskeySignatureCheck.class);

    private final SubmissionSignatureVerifier verifier;
    private final WebAuthnSettings settings;
    private final FormSigningSource forms;
    private final PasskeySubjectResolver subjects;

    /**
     * @param verifier the verifier
     * @param settings the site's passkey settings
     * @param forms each form's signing settings
     * @param subjects who a request is
     */
    public PasskeySignatureCheck(SubmissionSignatureVerifier verifier, WebAuthnSettings settings,
                                 FormSigningSource forms, PasskeySubjectResolver subjects) {
        this.verifier = Objects.requireNonNull(verifier, "verifier");
        this.settings = Objects.requireNonNull(settings, "settings");
        this.forms = Objects.requireNonNull(forms, "forms");
        this.subjects = Objects.requireNonNull(subjects, "subjects");
    }

    @Override
    public SignatureVerdict check(CandidateSubmission submission) {
        FormSigning form = forms.forForm(submission.formKey());
        if (form == null || form.mode() == FormSigning.Mode.OFF) {
            return SignatureVerdict.absent();
        }
        boolean real = submission.mode() == SubmissionMode.SUBMIT;
        PasskeySubject subject = subjects.resolve(submission.submissionContext().principal());
        SignatureVerification verification = verifier.verify(submission.formKey(), form,
            submission.document() != null ? submission.document() : submission.envelope(), submission.envelope(), subject,
            submission.submissionContext().channel());
        if (!settings.maySign(subject)) {
            // An anonymous visitor while visitors' passkeys are off: an optional form takes their submission
            // unsigned, a required one asks them to sign in, and a signature they send anyway is never judged.
            if (form.mode() != FormSigning.Mode.REQUIRED && verification.status() == SignatureVerification.Status.NONE) {
                return verdict(SignatureVerdict.Status.ABSENT, verification, "none", List.of());
            }
            return verdict(SignatureVerdict.Status.ABSENT, verification, "none", List.of(SubmissionError.error(null, "signature.sign_in",
                form.mode() == FormSigning.Mode.REQUIRED
                    ? "Sign in to send this form: it must be signed with a passkey, and only people who are signed in can sign on this site."
                    : "Only people who are signed in can sign on this site. Sign in to sign this form, or send it without signing.")));
        }
        if (verification.status() == SignatureVerification.Status.VALID) {
            return verdict(SignatureVerdict.Status.VALID, verification, "valid", List.of());
        }
        boolean unavailable = "unavailable".equals(submission.submissionContext().header(UNAVAILABLE_HEADER));
        if (form.mode() == FormSigning.Mode.REQUIRED && !settings.ready()) {
            // Nothing can be signed or checked here: the form's policy for a browser without passkeys decides.
            if (form.unavailable().equals("accept")) {
                return verdict(SignatureVerdict.Status.ABSENT, verification, "unavailable", List.of());
            }
            return verdict(status(verification), verification, verification.status().wire(), List.of(SubmissionError.error(null,
                "signature.unavailable",
                "This form must be signed with a passkey, and passkeys are not set up on this site, so it cannot be sent now. Contact us.")));
        }
        if (verification.status() == SignatureVerification.Status.NONE) {
            if (form.mode() != FormSigning.Mode.REQUIRED) {
                return verdict(SignatureVerdict.Status.ABSENT, verification, "none", List.of());
            }
            if (unavailable && form.unavailable().equals("accept")) {
                return verdict(SignatureVerdict.Status.ABSENT, verification, "unavailable", List.of());
            }
            return verdict(SignatureVerdict.Status.ABSENT, verification, "none", List.of(SubmissionError.error(null, "signature.required",
                "This form must be signed with a passkey: send it again, and approve the passkey prompt.")));
        }
        String code = verification.code() == null ? "" : verification.code();
        // A signed document sent again is refused whatever the form says; an invalid one always is (fail closed).
        boolean refuse = form.verify() || code.equals("replay") || verification.status() == SignatureVerification.Status.INVALID;
        if (real) {
            LOG.atInfo().addKeyValue("form", submission.formKey()).addKeyValue("key", verification.credentialId())
                .log("signature.{} form={} key={} detail={}{}", verification.status().wire(), submission.formKey(), verification.credentialId(),
                verification.reason(), refuse ? "" : " (accepted unverified: the form does not verify signatures on arrival)");
        }
        if (!refuse) {
            return verdict(status(verification), verification, verification.status().wire(), List.of());
        }
        Refusal refusal = refusal(code);
        if (refusal.status() != 422 && !submission.mode().dryRun()) {
            // signature.stale is a 409 on the wire; the verdict carries 422 only, so a delivery's is thrown for the
            // receiver to answer as it is. A dry run reports it in its 200 report instead (below).
            throw new DatumException(refusal.code(), refusal.status(), refusal.message());
        }
        return verdict(status(verification), verification, verification.status().wire(), List.of(SubmissionError.error(null, refusal.code(),
            refusal.message())));
    }

    @Override
    public void recordUse(AcceptedSubmission submission) {
        PasskeyUseStore.PasskeyUse use = useOf(submission);
        if (use == null) {
            return;
        }
        try {
            verifier.recordUse(use);
        } catch (SignatureReplayException e) {
            String code = List.of("replay", "revoked", "counter").contains(e.reason()) ? e.reason() : "replay";
            Map<String, Object> details = submission.signature().details();
            LOG.atInfo().addKeyValue("form", submission.formKey()).addKeyValue("key", details.get("credentialId"))
                .log("signature.invalid form={} key={} detail={}", submission.formKey(), details.get("credentialId"),
                SubmissionSignatureVerifier.REASONS.get(code));
            Refusal refusal = refusal(code);
            throw new DatumException(refusal.code(), refusal.status(), refusal.message(), e);
        }
    }

    @Override
    public void releaseUse(AcceptedSubmission submission) {
        verifier.releaseUse(useOf(submission));
    }

    /**
     * The use a valid verdict's details stand for; null for any other verdict.
     *
     * @throws DatumException 503 {@code server.unavailable} when the verdict is valid but its details do not name
     *     the use (a check or a copy that lost them): fail closed, so the replay guard is never silently off
     */
    private static PasskeyUseStore.PasskeyUse useOf(AcceptedSubmission submission) {
        SignatureVerdict verdict = submission.signature();
        if (verdict == null || verdict.status() != SignatureVerdict.Status.VALID) {
            return null;
        }
        Map<String, Object> details = verdict.details();
        // Whole numbers of any boxed type (a copy of the details may have turned a Long into an Integer).
        if (!(details.get("keySha256") instanceof String key) || !(details.get("digest") instanceof String digest)
            || !(details.get("passkeyId") instanceof Number passkeyId) || !whole(passkeyId)
            || !(details.get("signCount") instanceof Number signCount) || !whole(signCount)
            || !(details.get("judgedAt") instanceof Instant judgedAt)) {
            LOG.error("A valid signature for {} carries no use to record (keySha256, digest, passkeyId, signCount, judgedAt): refused.",
                submission.formKey());
            throw new DatumException("server.unavailable", 503,
                "The signature's use could not be recorded, so the submission was not taken. Try again later.");
        }
        return new PasskeyUseStore.PasskeyUse(key, digest, passkeyId.longValue(), "", signCount.longValue(), judgedAt);
    }

    private static boolean whole(Number number) {
        return number instanceof Long || number instanceof Integer || number instanceof Short || number instanceof Byte;
    }

    /** The receiver's status for a verdict the verifier gave. */
    private static SignatureVerdict.Status status(SignatureVerification verification) {
        return switch (verification.status()) {
            case VALID -> SignatureVerdict.Status.VALID;
            case INVALID -> SignatureVerdict.Status.INVALID;
            case UNVERIFIABLE -> SignatureVerdict.Status.UNVERIFIABLE;
            case NONE -> SignatureVerdict.Status.ABSENT;
        };
    }

    private SignatureVerdict verdict(SignatureVerdict.Status status, SignatureVerification verification, String recorded,
                                     List<SubmissionError> errors) {
        Map<String, Object> details = new LinkedHashMap<>();
        // What a record keeps of the signature: its status (none, valid, invalid, unverifiable, unavailable) and the rest.
        details.put("status", recorded);
        put(details, "code", verification.code());
        put(details, "reason", verification.reason());
        put(details, "credentialId", verification.credentialId());
        put(details, "signedAt", verification.signedAt());
        put(details, "scope", verification.scope());
        put(details, "statement", verification.statement());
        put(details, "digest", verification.digest());
        details.put("signCount", verification.signCount());
        if (!verification.checks().isEmpty()) {
            details.put("checks", verification.checks());
        }
        if (verification.passkey() != null && verification.passkey().id() != null) {
            details.put("passkeyId", verification.passkey().id());
            details.put("passkeyLabel", verification.passkey().label());
            if (status == SignatureVerdict.Status.VALID) {
                details.put("keySha256", verification.passkey().publicKeyHash());
                details.put("judgedAt", verifier.now());
            }
        }
        return new SignatureVerdict(status, errors, details);
    }

    private static void put(Map<String, Object> details, String key, Object value) {
        if (value != null) {
            details.put(key, value);
        }
    }

    private record Refusal(int status, String code, String message) {
    }

    /** The refusal for a signature that is not valid, by its reason's code (the wire's codes and statuses). */
    static Refusal refusal(String code) {
        return switch (code) {
            case "scope", "statement", "format" -> new Refusal(409, "signature.stale",
                "This form's signing settings changed while you had it open, so it cannot be signed as it is. Reload it to sign: your answers are kept.");
            case "unknown" -> new Refusal(422, "signature.unknown",
                "The passkey you chose is not registered on this site. Make a new passkey for this site when offered, or send the form again and choose another of yours.");
            case "revoked", "form", "owner", "handle" -> new Refusal(422, "signature.unusable",
                "The passkey you chose cannot sign this form. Make a new passkey for this site when offered, or send the form again and choose another of yours.");
            case "userVerified" -> new Refusal(422, "signature.invalid",
                "This form needs your device to check it is you (fingerprint, face or PIN) when you sign. Send the form again, and allow the check.");
            case "window" -> new Refusal(422, "signature.invalid",
                "The signature arrived too long after it was made. Send the form again to sign it again; if this happens again, check your device's date and time.");
            case "replay" -> new Refusal(422, "signature.invalid",
                "This signed submission was already received. The same passkey signs the same answers once: change an answer to send them again.");
            case "counter" -> new Refusal(422, "signature.invalid",
                "Your passkey reported a signature count that did not go up, which happens when a passkey is copied. Sign with another passkey, or contact us.");
            case "not_set_up" -> new Refusal(422, "signature.unavailable",
                "Passkeys are not set up on this site, so a signature cannot be checked. Send the form without signing, or contact us.");
            default -> new Refusal(422, "signature.invalid",
                "Your signature could not be checked. Send the form again to sign it again; if this happens again, contact us.");
        };
    }
}
