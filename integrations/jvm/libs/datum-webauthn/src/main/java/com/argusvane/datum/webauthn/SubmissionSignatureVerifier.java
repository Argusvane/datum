package com.argusvane.datum.webauthn;

import java.time.Clock;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.regex.Pattern;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The verdict on a delivered submission's passkey signature, step by step in the order below.
 *
 * <ol>
 *   <li>The passkey signatures are found where the format put them (embedded in the envelope's signatures, or
 *       beside the payload of a wrapper): none is status none; more than one is invalid ({@code multiple}).</li>
 *   <li>Passkeys not set up on this site: unverifiable ({@code not_set_up}).</li>
 *   <li>A format read strictly, as the engine's {@code readSigningFormat} reads it: a known scope and placement,
 *       digest "sha-256" and canonicalization "jcs". Any other format (a missing or unknown member, or no format at
 *       all) is not a signature this form's page made: invalid ({@code format}), never merely unverifiable, so a
 *       forgery is not stored as such.</li>
 *   <li>A statement that is not text: invalid ({@code unreadable}).</li>
 *   <li>The client's two signing times (the result's and the assertion's) must agree within 60 seconds
 *       ({@code signed_at}).</li>
 *   <li>The scope must be the form's ({@code scope}); the statement the form's ({@code statement}).</li>
 *   <li>The signed text is rebuilt in JCS from the scoped part of the delivered envelope, and from
 *       {document, statement} with a statement; one with no canonical form is {@code canonical}.</li>
 *   <li>The passkey must be registered here ({@code unknown}), not revoked ({@code revoked}), usable on this
 *       form ({@code form}) and by this person ({@code owner}), answering with its own user handle
 *       ({@code handle}).</li>
 *   <li>The application's {@link SignatureCheckCustomizer}s, for a signature this site judges: they may
 *       refuse it, require user verification or shorten the signing window for this form. Then the assertion must
 *       verify with the STORED key and algorithm: challenge = SHA-256 of the signed text, origin, relying party id,
 *       user presence, verification when the form (or a customizer) requires it, the signature (webauthn4j, under
 *       {@link WebAuthnVerifier}'s policy).</li>
 *   <li>A digest its key signed before is a replay ({@code replay}); the counter must have gone up unless both
 *       are 0 ({@code counter}); the signing time must be within the window ({@code window}, the customizers' if they
 *       shortened it).</li>
 * </ol>
 *
 * <p>The signing time is the client's claim, outside the signed text: the window is a sanity check, never a
 * proof of when it was signed. The replay guard is what refuses a signed document sent again: its digest is
 * claimed under its key when it is stored ({@link #recordUse}).
 *
 * <p>There are no passkey invitations, so step 8's form check is the passkey's own form alone; a
 * submitter is a {@link PasskeySubject} (a text id).
 */
public final class SubmissionSignatureVerifier {

    /** Why a signature is not valid, by code (fixed English for the record and the log); the assertion's own checks add {@link WebAuthnVerifier#REASONS}. */
    public static final Map<String, String> REASONS = reasons();

    private static final Pattern ISO = Pattern.compile("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,9})?(Z|[+-]\\d{2}:\\d{2})");

    private final WebAuthnSettings settings;
    private final PasskeyRepository passkeys;
    private final PasskeyUseStore uses;
    private final WebAuthnVerifier verifier;
    private final Clock clock;
    private final List<SignatureCheckCustomizer> customizers;

    public SubmissionSignatureVerifier(WebAuthnSettings settings, PasskeyRepository passkeys, PasskeyUseStore uses, WebAuthnVerifier verifier,
                                       Clock clock) {
        this(settings, passkeys, uses, verifier, clock, List.of());
    }

    /**
     * As above with the application's signature-check hooks, in the framework's order.
     *
     * @param customizers the per-form policy, before the assertion is verified
     */
    public SubmissionSignatureVerifier(WebAuthnSettings settings, PasskeyRepository passkeys, PasskeyUseStore uses, WebAuthnVerifier verifier,
                                       Clock clock, List<SignatureCheckCustomizer> customizers) {
        this.customizers = List.copyOf(Objects.requireNonNull(customizers, "customizers"));
        this.settings = Objects.requireNonNull(settings, "settings");
        this.passkeys = Objects.requireNonNull(passkeys, "passkeys");
        this.uses = Objects.requireNonNull(uses, "uses");
        this.verifier = Objects.requireNonNull(verifier, "verifier");
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    private static Map<String, String> reasons() {
        Map<String, String> reasons = new LinkedHashMap<>();
        reasons.put("not_set_up", "passkeys are not set up on this site (no passkey domain), so no signature can be checked");
        reasons.put("multiple", "a submission carries one passkey signature, and this one carries more");
        reasons.put("unreadable", "the passkey signature could not be read");
        reasons.put("format", "its signing format is not one this form signs in (a known scope and placement, SHA-256, the JCS key order of RFC 8785)");
        reasons.put("scope", "it signs another part of the submission than this form asks for");
        reasons.put("statement", "its signing statement is not this form's");
        reasons.put("canonical", "its signed part has no canonical form");
        reasons.put("unknown", "the passkey is not registered on this site");
        reasons.put("revoked", "the passkey was revoked");
        reasons.put("form", "the passkey was made on another form");
        reasons.put("owner", "the passkey belongs to another account");
        reasons.put("handle", "the passkey answered with another user handle");
        reasons.put("counter", "the signature counter did not go up: the passkey may have been copied");
        reasons.put("window", "its signing time is outside the window this site allows");
        reasons.put("replay", "this passkey signed this same document before: it was already sent");
        reasons.put("signed_at", "its two signing times disagree, so the signature was changed after it was made");
        return Collections.unmodifiableMap(reasons);
    }

    /** What is known so far, carried into each answer. */
    private static final class Known {
        String credentialId;
        Long signedAt;
        String scope;
        String statement;
        String digest;
        long signCount;
        Map<String, Boolean> checks = Map.of();

        SignatureVerification fail(SignatureVerification.Status status, String code, PasskeyRecord passkey) {
            String reason = REASONS.containsKey(code) ? REASONS.get(code)
                : WebAuthnVerifier.REASONS.containsKey(code) ? WebAuthnVerifier.REASONS.get(code) : code;
            return fail(status, code, reason, passkey);
        }

        SignatureVerification fail(SignatureVerification.Status status, String code, String reason, PasskeyRecord passkey) {
            return new SignatureVerification(status, reason, code, passkey, credentialId, signedAt, scope, statement, digest, signCount, checks);
        }
    }

    /**
     * The verdict on a delivered document's passkey signature.
     *
     * @param formKey the form
     * @param form the form's signing settings
     * @param document the document as delivered: the envelope, or a signed wrapper
     * @param envelope the envelope (the wrapper's payload; the document itself when embedded)
     * @param submitter who delivers it
     */
    public SignatureVerification verify(String formKey, FormSigning form, JsonNode document, ObjectNode envelope, PasskeySubject submitter) {
        return verify(formKey, form, document, envelope, submitter, "http");
    }

    /**
     * As above, naming the channel the submission came in on (what a {@link SignatureCheckCustomizer} reads).
     *
     * @param channel {@code http}, or the submission context's channel word
     * @throws com.argusvane.datum.core.hooks.HookRefusedException when a customizer refuses the signature
     */
    public SignatureVerification verify(String formKey, FormSigning form, JsonNode document, ObjectNode envelope, PasskeySubject submitter,
                                        String channel) {
        Known known = new Known();
        // Wrapped when the document is not the envelope itself (the receiver hands copies, so by content).
        boolean wrapped = document != null && !document.equals(envelope);
        JsonNode signatures = wrapped ? member(document, "signatures") : member(envelope, "signatures");
        List<JsonNode> passkeySignatures = new ArrayList<>();
        if (signatures != null && signatures.isArray()) {
            for (JsonNode signature : signatures) {
                if (signature.isObject() && member(signature, "webauthn") != null && member(signature, "webauthn").isObject()) {
                    passkeySignatures.add(signature);
                }
            }
        }
        if (passkeySignatures.isEmpty()) {
            return new SignatureVerification(SignatureVerification.Status.NONE, null, null, null, null, null, null, null, null, 0, Map.of());
        }
        if (passkeySignatures.size() > 1) {
            return known.fail(SignatureVerification.Status.INVALID, "multiple", null);
        }
        JsonNode signature = passkeySignatures.get(0);
        JsonNode assertion = member(signature, "webauthn");
        JsonNode format = member(signature, "format") != null && member(signature, "format").isObject() ? member(signature, "format")
            : wrapped && member(document, "format") != null && member(document, "format").isObject() ? member(document, "format") : null;
        // Only text is read from the signature: anything else is unreadable, never an error. Every member is read as
        // the engine's readSigningFormat reads it, with no default for one that is missing.
        String scope = word(format, "scope", SCOPES);
        boolean readableFormat = scope != null && word(format, "placement", PLACEMENTS) != null
            && word(format, "digest", List.of("sha-256")) != null && word(format, "canonicalization", List.of("jcs")) != null;
        // An empty statement is none, as the engine reads it (signingStatementOf).
        JsonNode statementNode = member(signature, "statement");
        String statement = statementNode != null && statementNode.isString() && !statementNode.asString().isEmpty() ? statementNode.asString() : null;
        known.scope = scope;
        known.statement = statement;
        known.signedAt = signedAt(signature);
        JsonNode credentialNode = member(assertion, "credentialId");
        known.credentialId = credentialNode != null && credentialNode.isString() ? clip(credentialNode.asString(), 1400) : null;

        if (!settings.ready()) {
            return known.fail(SignatureVerification.Status.UNVERIFIABLE, "not_set_up", null);
        }
        if (!readableFormat) {
            // A format this engine does not sign under has no text a verifier can rebuild: it is not a signature
            // this form's page made, so it is invalid, not merely unverifiable.
            return known.fail(SignatureVerification.Status.INVALID, "format", null);
        }
        if (statementNode != null && !statementNode.isNull() && !statementNode.isString()) {
            return known.fail(SignatureVerification.Status.INVALID, "unreadable", null);
        }
        // The client's two claims of when it signed: one changed afterwards (the record would disagree with the
        // stored document) is refused.
        if (!signedAtAgrees(signature, settings.signedAtSkew().getSeconds())) {
            return known.fail(SignatureVerification.Status.INVALID, "signed_at", null);
        }
        if (scope == null || !scope.equals(form.scope())) {
            return known.fail(SignatureVerification.Status.INVALID, "scope", null);
        }
        String expected = form.statement().isEmpty() ? null : form.statement();
        if (!Objects.equals(statement, expected)) {
            return known.fail(SignatureVerification.Status.INVALID, "statement", null);
        }
        String text;
        try {
            text = SignedText.text(envelope, scope, statement);
        } catch (IllegalArgumentException e) {
            return known.fail(SignatureVerification.Status.INVALID, "canonical", null);
        }
        byte[] digest = SignedText.digest(text);
        known.digest = HexFormat.of().formatHex(digest);

        Optional<PasskeyRecord> found = known.credentialId != null ? passkeys.find(known.credentialId) : Optional.empty();
        if (found.isEmpty()) {
            return known.fail(SignatureVerification.Status.INVALID, "unknown", null);
        }
        PasskeyRecord passkey = found.get();
        // An invalid verdict names the passkey only when it is the person's own: never another account's or a
        // visitor's, whose name the record would show to whoever sent it.
        String owner = passkey.owner();
        boolean own = !owner.isEmpty() && owner.equals(submitter.uid());
        PasskeyRecord mine = own ? passkey : null;
        if (passkey.isRevoked()) {
            return known.fail(SignatureVerification.Status.INVALID, "revoked", mine);
        }
        // The form it was made for (an invitation naming several forms is not handled).
        if (!passkey.formId().isEmpty() && !passkey.formId().equals(formKey)) {
            return known.fail(SignatureVerification.Status.INVALID, "form", mine);
        }
        if (!owner.isEmpty() && !own) {
            return known.fail(SignatureVerification.Status.INVALID, "owner", null);
        }
        JsonNode handleNode = member(assertion, "userHandle");
        String handle = handleNode != null && handleNode.isString() ? handleNode.asString() : "";
        if (!handle.isEmpty() && !passkey.userHandle().isEmpty() && !handle.equals(passkey.userHandle())
            && !Arrays.equals(Base64Url.decode(handle), passkey.userHandle().getBytes(java.nio.charset.StandardCharsets.UTF_8))) {
            return known.fail(SignatureVerification.Status.INVALID, "handle", mine);
        }
        // The application's policy for this form, only for a signature this site judges: a visitor's while
        // visitors may not sign is answered signature.sign_in whatever it carries, so no hook is asked about it.
        SignatureCheckDraft draft = new SignatureCheckDraft(formKey == null ? "" : formKey, form, submitter, passkey, channel == null ? "http" : channel, settings.window());
        if (settings.maySign(submitter)) {
            for (SignatureCheckCustomizer customizer : customizers) {
                customizer.customize(draft);
            }
        }
        // The stored key and the stored algorithm: never the document's (the engine's RS256 documents
        // carry webauthn.algorithm -7).
        WebAuthnVerdict check = verifier.verifyAssertion(assertion, digest, settings.origins(), settings.rpId(), passkey.publicKey(),
            passkey.algorithm(), draft.userVerificationRequired());
        known.signCount = check.signCount();
        known.checks = check.checks();
        if (!check.valid()) {
            String failed = check.failed() == null ? "signature" : check.failed();
            return known.fail(SignatureVerification.Status.INVALID, failed, check.reason() == null ? WebAuthnVerifier.REASONS.get("signature") : check.reason(), mine);
        }
        // A document its key signed and this site stored before: said first, as the plainest reason a copy of
        // it fails.
        if (uses.used(passkey.publicKeyHash(), known.digest)) {
            return known.fail(SignatureVerification.Status.INVALID, "replay", mine);
        }
        if ((check.signCount() > 0 || passkey.signCount() > 0) && check.signCount() <= passkey.signCount()) {
            return known.fail(SignatureVerification.Status.INVALID, "counter", mine);
        }
        // The client's own claim, outside what is signed: a sanity check only.
        if (known.signedAt == null || Math.abs(clock.instant().getEpochSecond() - known.signedAt) > draft.window().getSeconds()) {
            return known.fail(SignatureVerification.Status.INVALID, "window", mine);
        }
        return new SignatureVerification(SignatureVerification.Status.VALID, null, null, passkey, known.credentialId, known.signedAt,
            known.scope, known.statement, known.digest, known.signCount, known.checks);
    }

    /**
     * Records a valid signature's use, in the step that stores the submission: the digest is claimed under its
     * key, then the passkey's counter and last use move by a conditional update, never by saving a record read
     * before, so a revocation or a higher counter written meanwhile stands. Nothing for a verdict that is not
     * valid.
     *
     * @param verification what {@link #verify} gave
     * @param submission the stored submission's reference ("" when not known yet)
     * @return the use recorded, to {@link #releaseUse} if the submission is not stored after all; null when
     *     the verdict is not valid (nothing to record)
     * @throws SignatureReplayException when another request claimed the digest first (replay), the passkey was
     *     revoked meanwhile (revoked), or its counter moved past this signature's (counter)
     * @throws IllegalStateException when the verdict is valid but names no stored passkey or no digest: fail
     *     closed, never a valid signature stored with its digest unclaimed
     */
    public PasskeyUseStore.PasskeyUse recordUse(SignatureVerification verification, String submission) {
        if (verification == null || verification.status() != SignatureVerification.Status.VALID) {
            return null;
        }
        if (verification.passkey() == null || verification.digest() == null || verification.passkey().id() == null) {
            throw new IllegalStateException("A valid signature names no stored passkey or no digest, so its use cannot be recorded.");
        }
        PasskeyRecord passkey = verification.passkey();
        PasskeyUseStore.PasskeyUse use = new PasskeyUseStore.PasskeyUse(passkey.publicKeyHash(), verification.digest(), passkey.id(), submission,
            verification.signCount(), clock.instant());
        recordUse(use);
        return use;
    }

    /** Records a use rebuilt from a verdict's details (the submissions seam); see {@link #recordUse(SignatureVerification, String)}. */
    public void recordUse(PasskeyUseStore.PasskeyUse use) {
        PasskeyUseStore.Outcome outcome = uses.record(use);
        switch (outcome) {
            case RECORDED -> {
            }
            case REPLAY -> throw new SignatureReplayException("replay");
            case REVOKED -> throw new SignatureReplayException("revoked");
            case COUNTER -> throw new SignatureReplayException("counter");
        }
    }

    /** Gives back a use {@link #recordUse} recorded, for a submission that was not stored after all. */
    public void releaseUse(PasskeyUseStore.PasskeyUse use) {
        if (use != null) {
            uses.release(use);
        }
    }

    /** The server's time, for callers that rebuild a use. */
    public Instant now() {
        return clock.instant();
    }

    /**
     * When a signature says it was made, in epoch seconds; null when it does not: an ISO 8601 date and time
     * (the engine's toISOString()) on the assertion, else the result's milliseconds. The client's claim.
     */
    static Long signedAt(JsonNode signature) {
        Long iso = iso(member(member(signature, "webauthn"), "signedAt"));
        if (iso != null) {
            return iso;
        }
        JsonNode millis = member(signature, "signedAt");
        if (millis != null && millis.isNumber()) {
            double value = millis.numberValue().doubleValue();
            if (Double.isFinite(value) && Math.abs(value) < 1.0E15) {
                return (long) Math.floor(value / 1000);
            }
        }
        return null;
    }

    /**
     * Whether a signature's two signing times agree, when it carries both: the result's (milliseconds, or ISO
     * 8601 text) and the assertion's (ISO 8601) must name the same moment within the tolerance
     * ({@code datum.webauthn.signed-at-skew}, 60 seconds unless the host sets its own).
     */
    static boolean signedAtAgrees(JsonNode signature, double toleranceSeconds) {
        JsonNode outer = member(signature, "signedAt");
        JsonNode inner = member(member(signature, "webauthn"), "signedAt");
        if (outer == null || outer.isNull() || inner == null || inner.isNull()) {
            return true;
        }
        Double outerSeconds;
        if (outer.isNumber() && Double.isFinite(outer.numberValue().doubleValue()) && Math.abs(outer.numberValue().doubleValue()) < 1.0E15) {
            outerSeconds = outer.numberValue().doubleValue() / 1000;
        } else {
            Long parsed = iso(outer);
            outerSeconds = parsed == null ? null : parsed.doubleValue();
        }
        Long innerSeconds = iso(inner);
        return outerSeconds != null && innerSeconds != null && Math.abs(outerSeconds - innerSeconds) <= toleranceSeconds;
    }

    /** An ISO 8601 date and time in the engine's shape, as epoch seconds (strtotime: fractions dropped). */
    private static Long iso(JsonNode node) {
        if (node == null || !node.isString() || !ISO.matcher(node.asString()).matches()) {
            return null;
        }
        try {
            return OffsetDateTime.parse(node.asString()).toEpochSecond();
        } catch (DateTimeParseException e) {
            return null;
        }
    }

    private static final List<String> SCOPES = List.of("envelope", "submission", "values");
    private static final List<String> PLACEMENTS = List.of("embedded", "wrapper");

    /** The member's text when it is one of {@code words}, else null. */
    private static String word(JsonNode node, String name, List<String> words) {
        JsonNode value = member(node, name);
        return value != null && value.isString() && words.contains(value.asString()) ? value.asString() : null;
    }

    private static JsonNode member(JsonNode node, String name) {
        if (node == null || !node.isObject()) {
            return null;
        }
        return node.get(name);
    }

    /** The first {@code max} characters (code points, so a cut never splits a pair). */
    private static String clip(String text, int max) {
        int count = text.codePointCount(0, text.length());
        return count <= max ? text : text.substring(0, text.offsetByCodePoints(0, max));
    }
}
