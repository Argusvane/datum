package com.argusvane.datum.webauthn;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The verdict on signed submissions: required and optional signatures, scopes, owners, amendments and
 * dry runs (the verdict half), and the hardening cases (a copied key, removal, concurrent revocation and counter,
 * malformed and foreign signatures), at the verifier, without the receiver.
 */
class SubmissionSignatureVerifierTest {

    private static final String CONFIRM = "I confirm these answers.";
    private static final PasskeySubject VISITOR = PasskeySubject.anonymous();

    private final Passkeys site = new Passkeys();

    private static FormSigning required(String statement) {
        return FormSigning.builder().mode(FormSigning.Mode.REQUIRED).statement(statement).build();
    }

    private static ObjectNode signature(ObjectNode document) {
        return (ObjectNode) (document.has("payload") ? document.get("signatures") : document.get("signatures")).get(0);
    }

    /** A required signature: valid, recorded, replayed, and each way it fails. */
    @Test
    void required() {
        FormSigning form = required(CONFIRM);
        SoftwareAuthenticator authenticator = new SoftwareAuthenticator();
        PasskeyRecord passkey = site.register(authenticator);

        ObjectNode body = site.signed(authenticator, Map.of("fullName", "Ada"), Map.of("statement", CONFIRM));
        SignatureVerification valid = site.verify(body, form, VISITOR);
        assertThat(valid.status()).as(String.valueOf(valid.reason())).isEqualTo(SignatureVerification.Status.VALID);
        assertThat(valid.passkey().id()).isEqualTo(passkey.id());
        assertThat(valid.scope()).isEqualTo("envelope");
        assertThat(valid.statement()).isEqualTo(CONFIRM);
        assertThat(valid.signedAt()).isEqualTo(site.clock.instant().getEpochSecond());
        assertThat(valid.digest()).hasSize(64);
        assertThat(valid.credentialId()).isEqualTo(passkey.credentialId());
        assertThat(valid.checks()).containsEntry("signature", true).containsEntry(WebAuthnVerifier.LIBRARY_CHECK, true);
        assertThat(site.signatures.recordUse(valid, "SUB-1")).isNotNull();
        PasskeyRecord moved = site.repository.find(passkey.credentialId()).orElseThrow();
        assertThat(moved.signCount()).as("The counter moves in the store.").isEqualTo(authenticator.counter);
        assertThat(moved.lastUsed()).isNotNull();

        // The same signed document again: a replay.
        assertThat(site.verify(body, form, VISITOR).code()).isEqualTo("replay");
        // Unsigned: none.
        assertThat(site.verify(SoftwareAuthenticator.envelope("petition", Map.of("fullName", "Ada")), form, VISITOR).status())
            .isEqualTo(SignatureVerification.Status.NONE);
        // Another statement, or none, is not this form's.
        assertThat(site.verify(site.signed(authenticator, Map.of("fullName", "Bo"), Map.of("statement", "Something else.")), form, VISITOR).code())
            .isEqualTo("statement");
        assertThat(site.verify(site.signed(authenticator, Map.of("fullName", "Bo")), form, VISITOR).code()).isEqualTo("statement");
        // A counter that did not go up.
        assertThat(site.verify(site.signed(authenticator, Map.of("fullName", "Cy"), Map.of("statement", CONFIRM, "counter", 1L)), form, VISITOR).code())
            .isEqualTo("counter");
        // Answers changed after signing.
        ObjectNode tampered = site.signed(authenticator, Map.of("fullName", "Di"), Map.of("statement", CONFIRM));
        ((ObjectNode) tampered.get("submission").get("values")).put("fullName", "Eve");
        assertThat(site.verify(tampered, form, VISITOR).code()).isEqualTo("challenge");
        // Signed too long ago (both of its times an hour back).
        ObjectNode old = site.signed(authenticator, Map.of("fullName", "Fay"),
            Map.of("statement", CONFIRM, "signedAt", (site.clock.instant().getEpochSecond() - 3600) * 1000));
        ((ObjectNode) signature(old).get("webauthn")).put("signedAt",
            DateTimeFormatter.ISO_OFFSET_DATE_TIME.format(site.clock.instant().minusSeconds(3600).atOffset(ZoneOffset.UTC)));
        assertThat(site.verify(old, form, VISITOR).code()).isEqualTo("window");
        // Its two signing times disagree (the result's moved an hour earlier): changed after signing.
        ObjectNode moved2 = site.signed(authenticator, Map.of("fullName", "Fen"), Map.of("statement", CONFIRM));
        signature(moved2).put("signedAt", DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'.000Z'").withZone(ZoneOffset.UTC)
            .format(site.clock.instant().minusSeconds(3600)));
        SignatureVerification disagree = site.verify(moved2, form, VISITOR);
        assertThat(disagree.code()).isEqualTo("signed_at");
        assertThat(disagree.reason()).isEqualTo(SubmissionSignatureVerifier.REASONS.get("signed_at"));
        // Both the same moment, one as milliseconds: valid.
        ObjectNode agreed = site.signed(authenticator, Map.of("fullName", "Fen"), Map.of("statement", CONFIRM));
        signature(agreed).put("signedAt", Instant.parse(signature(agreed).get("webauthn").get("signedAt").asString()).getEpochSecond() * 1000);
        assertThat(site.verify(agreed, form, VISITOR).status()).isEqualTo(SignatureVerification.Status.VALID);
        // A passkey this site never registered.
        SignatureVerification unknown = site.verify(site.signed(new SoftwareAuthenticator(), Map.of("fullName", "Gus"), Map.of("statement", CONFIRM)), form, VISITOR);
        assertThat(unknown.code()).isEqualTo("unknown");
        assertThat(unknown.reason()).isEqualTo("the passkey is not registered on this site");
        assertThat(unknown.digest()).as("What is known so far goes with the reason.").isNotNull();
        // A format naming another key order, a format naming none, and no format at all: invalid (this form signs
        // in JCS), never merely unverifiable.
        assertThat(site.verify(site.signed(authenticator, Map.of("fullName", "Hal"), Map.of("statement", CONFIRM, "canonicalization", "sorted-keys")), form, VISITOR))
            .extracting(SignatureVerification::status, SignatureVerification::code)
            .containsExactly(SignatureVerification.Status.INVALID, "format");
        ObjectNode unnamed = site.signed(authenticator, Map.of("fullName", "Cal"), Map.of("statement", CONFIRM));
        ((ObjectNode) signature(unnamed).get("format")).remove("canonicalization");
        assertThat(site.verify(unnamed, form, VISITOR))
            .extracting(SignatureVerification::status, SignatureVerification::code)
            .containsExactly(SignatureVerification.Status.INVALID, "format");
        ObjectNode formatless = site.signed(authenticator, Map.of("fullName", "Dot"), Map.of("statement", CONFIRM));
        signature(formatless).remove("format");
        SignatureVerification noFormat = site.verify(formatless, form, VISITOR);
        assertThat(noFormat)
            .extracting(SignatureVerification::status, SignatureVerification::code)
            .containsExactly(SignatureVerification.Status.INVALID, "format");
        assertThat(noFormat.reason()).isEqualTo(SubmissionSignatureVerifier.REASONS.get("format"));
        // The format is read strictly, as the engine reads it: no member falls back to a default.
        for (String missing : List.of("scope", "placement", "digest")) {
            ObjectNode partial = site.signed(authenticator, Map.of("fullName", "Eve"), Map.of("statement", CONFIRM));
            ((ObjectNode) signature(partial).get("format")).remove(missing);
            assertThat(site.verify(partial, form, VISITOR))
                .as("a format with no %s", missing)
                .extracting(SignatureVerification::status, SignatureVerification::code)
                .containsExactly(SignatureVerification.Status.INVALID, "format");
        }
        ObjectNode otherDigest = site.signed(authenticator, Map.of("fullName", "Fay"), Map.of("statement", CONFIRM));
        ((ObjectNode) signature(otherDigest).get("format")).put("digest", "sha-1");
        assertThat(site.verify(otherDigest, form, VISITOR).code()).isEqualTo("format");
        ObjectNode otherPlacement = site.signed(authenticator, Map.of("fullName", "Gil"), Map.of("statement", CONFIRM));
        ((ObjectNode) signature(otherPlacement).get("format")).put("placement", "beside");
        assertThat(site.verify(otherPlacement, form, VISITOR).code()).isEqualTo("format");

        // The wrapper placement, and the submission scope.
        FormSigning wrapperForm = FormSigning.builder().mode(FormSigning.Mode.REQUIRED).scope("submission").placement("wrapper").build();
        ObjectNode wrapped = site.signed(authenticator, Map.of("fullName", "Ivy"), Map.of("scope", "submission", "placement", "wrapper"));
        SignatureVerification wrappedVerdict = site.verify(wrapped, wrapperForm, VISITOR);
        assertThat(wrappedVerdict.status()).as(String.valueOf(wrappedVerdict.reason())).isEqualTo(SignatureVerification.Status.VALID);
        assertThat(wrappedVerdict.scope()).isEqualTo("submission");
        // The scope must be the form's: a page opened before it changed.
        assertThat(site.verify(site.signed(authenticator, Map.of("fullName", "Jo"), Map.of("scope", "values", "placement", "wrapper")), wrapperForm, VISITOR).code())
            .isEqualTo("scope");

        // Revoked: signs nothing new.
        assertThat(site.repository.revoke(passkey.id(), "1", site.clock.instant())).isTrue();
        SignatureVerification revoked = site.verify(site.signed(authenticator, Map.of("fullName", "Kim"), Map.of("scope", "submission", "placement", "wrapper")),
            wrapperForm, VISITOR);
        assertThat(revoked.code()).isEqualTo("revoked");
        assertThat(revoked.passkey()).as("A visitor's passkey is never named on an invalid verdict.").isNull();
    }

    /** One passkey signature per submission; not set up; verification required; the stored algorithm. */
    @Test
    void moreRefusals() {
        FormSigning form = required("");
        SoftwareAuthenticator authenticator = new SoftwareAuthenticator();
        site.register(authenticator);
        ObjectNode twice = site.signed(authenticator, Map.of("fullName", "Ada"));
        ((ArrayNode) twice.get("signatures")).add(signature(twice).deepCopy());
        assertThat(site.verify(twice, form, VISITOR).code()).isEqualTo("multiple");
        // A signature from another provider is not a passkey signature.
        ObjectNode other = site.signed(authenticator, Map.of("fullName", "Ada"));
        ((ArrayNode) other.get("signatures")).add(SoftwareAuthenticator.JSON.createObjectNode().put("algorithm", "ed25519"));
        assertThat(site.verify(other, form, VISITOR).status()).isEqualTo(SignatureVerification.Status.VALID);

        FormSigning uv = FormSigning.builder().mode(FormSigning.Mode.REQUIRED).userVerification("required").build();
        assertThat(site.verify(site.signed(authenticator, Map.of("fullName", "Bo"), Map.of("uv", false)), uv, VISITOR).code()).isEqualTo("userVerified");
        // A frame of another site: the origin check.
        assertThat(site.verify(site.signed(authenticator, Map.of("fullName", "Cy"), Map.of("crossOrigin", true)), form, VISITOR).code()).isEqualTo("origin");
        // A credential id past 1400 characters is no passkey's.
        ObjectNode long1 = site.signed(authenticator, Map.of("fullName", "Di"));
        ((ObjectNode) signature(long1).get("webauthn")).put("credentialId", "A".repeat(1500));
        SignatureVerification clipped = site.verify(long1, form, VISITOR);
        assertThat(clipped.code()).isEqualTo("unknown");
        assertThat(clipped.credentialId()).hasSize(1400);
        // An unpaired surrogate in an answer: no canonical form.
        ObjectNode surrogate = site.signed(authenticator, Map.of("fullName", "\ud800"));
        assertThat(site.verify(surrogate, form, VISITOR).code()).isEqualTo("canonical");

        // Not set up: unverifiable, whatever arrives.
        site.configure(new WebAuthnSettings("", "Petition", List.of(), null, true, false, null, null, null, null));
        SignatureVerification notSetUp = site.verify(site.signed(authenticator, Map.of("fullName", "Eve")), form, VISITOR);
        assertThat(notSetUp).extracting(SignatureVerification::status, SignatureVerification::code)
            .containsExactly(SignatureVerification.Status.UNVERIFIABLE, "not_set_up");
    }

    /** The algorithm is the stored passkey's: an RS256 document naming -7 (the engine fixture's quirk) verifies. */
    @Test
    void theStoredAlgorithmIsUsed() {
        SoftwareAuthenticator rsa = new SoftwareAuthenticator(CoseKey.RS256);
        site.register(rsa);
        ObjectNode body = site.signed(rsa, Map.of("fullName", "Ada"));
        ((ObjectNode) signature(body).get("webauthn")).put("algorithm", CoseKey.ES256);
        ((ObjectNode) signature(body).get("webauthn")).put("publicKey", "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE");
        assertThat(site.verify(body, required(""), VISITOR).status()).isEqualTo(SignatureVerification.Status.VALID);
    }

    /** Per-form passkeys sign their form only; another account's passkey signs nothing for this one. */
    @Test
    void scopeAndOwners() {
        site.configure(new WebAuthnSettings("localhost", "Petition", List.of("http://localhost"), null, true, true, null, null, null, null));
        FormSigning form = required("");
        SoftwareAuthenticator authenticator = new SoftwareAuthenticator();
        PasskeyRecord passkey = site.register(authenticator);
        assertThat(passkey.formId()).isEqualTo("petition");
        ObjectNode body = authenticator.signSubmission(SoftwareAuthenticator.envelope("other", Map.of("fullName", "Ada")));
        assertThat(site.signatures.verify("other", form, body, body, VISITOR).code()).as("A per-form passkey signs its own form only.").isEqualTo("form");

        PasskeySubject owner = new PasskeySubject("7", "ada", "Ada");
        SoftwareAuthenticator owned = new SoftwareAuthenticator();
        site.register(owned, "Phone", owner);
        SignatureVerification foreign = site.verify(site.signed(owned, Map.of("fullName", "Bo")), form, new PasskeySubject("8", "bo", "Bo"));
        assertThat(foreign.code()).isEqualTo("owner");
        assertThat(foreign.passkey()).as("Another account's passkey is never named.").isNull();
        SignatureVerification anonymous = site.verify(site.signed(owned, Map.of("fullName", "Bo")), form, VISITOR);
        assertThat(anonymous.code()).isEqualTo("owner");
        SignatureVerification own = site.verify(site.signed(owned, Map.of("fullName", "Bo")), form, owner);
        assertThat(own.status()).isEqualTo(SignatureVerification.Status.VALID);
        site.signatures.recordUse(own, "SUB-1");
        // The owner's own passkey is named on an invalid verdict.
        SignatureVerification ownInvalid = site.verify(site.signed(owned, Map.of("fullName", "Cy"), Map.of("counter", 1L)), form, owner);
        assertThat(ownInvalid.code()).isEqualTo("counter");
        assertThat(ownInvalid.passkey()).isNotNull();
    }

    /**
     * A key read off a signature and registered under a new credential id cannot replay what it signed:
     * the digest is filed under the key, and outlives the passkey.
     */
    @Test
    void aCopiedKeyCannotReplay() {
        FormSigning form = required("");
        SoftwareAuthenticator victim = new SoftwareAuthenticator();
        PasskeyRecord original = site.register(victim);
        ObjectNode signed = site.signed(victim, Map.of("fullName", "Ada"));
        SignatureVerification first = site.verify(signed, form, VISITOR);
        assertThat(first.status()).isEqualTo(SignatureVerification.Status.VALID);
        site.signatures.recordUse(first, "SUB-1");
        assertThat(original.publicKeyHash()).isEqualTo(java.util.HexFormat.of().formatHex(SoftwareAuthenticator.sha256(victim.spki)));

        // Once the original record is gone, the key may be registered again: what it signed is still claimed.
        assertThat(site.uses.signedCount(original.id())).isEqualTo(1);
        assertThat(site.repository.delete(original.id())).isTrue();
        assertThat(site.repository.find(original.credentialId())).isEmpty();
        SoftwareAuthenticator copy = victim.copyWithCredentialId(SoftwareAuthenticator.random(16));
        PasskeyRecord again = site.register(copy);
        assertThat(again.credentialId()).isNotEqualTo(original.credentialId());
        ObjectNode replay = signed.deepCopy();
        ObjectNode assertion = (ObjectNode) signature(replay).get("webauthn");
        assertion.put("credentialId", again.credentialId());
        assertion.remove("userHandle");
        SignatureVerification refused = site.verify(replay, form, VISITOR);
        assertThat(refused.code()).isEqualTo("replay");
        assertThat(refused.credentialId()).isEqualTo(again.credentialId());
    }

    /** Removing a passkey that signed keeps it revoked and nameless, and its signatures still verify. */
    @Test
    void removingKeepsWhatItSigned() {
        FormSigning form = required("");
        PasskeySubject person = new PasskeySubject("7", "ada", "Ada");
        SoftwareAuthenticator laptop = new SoftwareAuthenticator();
        PasskeyRecord used = site.register(laptop, "Ada Lovelace", person);
        PasskeyRecord unused = site.register(new SoftwareAuthenticator(), "Spare key", person);
        ObjectNode signed = site.signed(laptop, Map.of("fullName", "Ada"));
        SignatureVerification verdict = site.verify(signed, form, person);
        site.signatures.recordUse(verdict, "SUB-1");

        // One that signed nothing goes; one that signed is kept: revoked, nameless, its key and counter there.
        assertThat(site.uses.signedCount(unused.id())).isZero();
        assertThat(site.repository.delete(unused.id())).isTrue();
        assertThat(site.uses.signedCount(used.id())).isEqualTo(1);
        assertThat(site.repository.revoke(used.id(), "7", site.clock.instant())).isTrue();
        assertThat(site.repository.revoke(used.id(), "1", site.clock.instant())).as("A revocation stays as it was.").isFalse();
        assertThat(site.repository.markRemoved(used.id(), site.clock.instant())).isTrue();
        PasskeyRecord kept = site.repository.findById(used.id()).orElseThrow();
        assertThat(kept.isRevoked()).isTrue();
        assertThat(kept.isRemoved()).isTrue();
        assertThat(kept.label()).isEmpty();
        assertThat(kept.revokedBy()).isEqualTo("7");
        assertThat(kept.owner()).isEqualTo("7");
        assertThat(kept.publicKey()).isEqualTo(laptop.spki);
        assertThat(kept.signCount()).isEqualTo(laptop.counter);
        // It leaves its owner's list, and its signature still verifies with the kept key.
        assertThat(site.repository.ofOwner("7")).isEmpty();
        assertThat(site.repository.ownActive("7", null)).isEmpty();
        WebAuthnVerdict check = site.verifier.verifyAssertion(signature(signed).get("webauthn"), SignedText.digest(SignedText.text(signed, "envelope", null)),
            List.of("http://localhost"), "localhost", kept.publicKey(), kept.algorithm(), false);
        assertThat(check.valid()).as(String.valueOf(check.reason())).isTrue();
    }

    /**
     * A revocation or a higher counter written while a store waits stands: the counter and the last use move by a conditional update.
     */
    @Test
    void concurrentRevocationAndCounter() {
        FormSigning form = required("");
        SoftwareAuthenticator authenticator = new SoftwareAuthenticator();
        PasskeyRecord passkey = site.register(authenticator);

        // Two signatures judged before either is stored; the later one (a higher counter) stores first: the
        // earlier is refused, the counter never goes down.
        SignatureVerification earlier = site.verify(site.signed(authenticator, Map.of("fullName", "Ada")), form, VISITOR);
        SignatureVerification later = site.verify(site.signed(authenticator, Map.of("fullName", "Bo")), form, VISITOR);
        assertThat(List.of(earlier.status(), later.status())).containsOnly(SignatureVerification.Status.VALID);
        site.signatures.recordUse(later, "SUB-2");
        assertThatThrownBy(() -> site.signatures.recordUse(earlier, "SUB-1"))
            .isInstanceOfSatisfying(SignatureReplayException.class, e -> assertThat(e.reason()).isEqualTo("counter"));
        assertThat(site.repository.findById(passkey.id()).orElseThrow().signCount()).isEqualTo(later.signCount());
        assertThat(site.uses.used(passkey.publicKeyHash(), earlier.digest())).as("A refused use claims nothing.").isFalse();

        // Two posts of one signature at the same moment: one is stored.
        SignatureVerification same = site.verify(site.signed(authenticator, Map.of("fullName", "Cy")), form, VISITOR);
        site.signatures.recordUse(same, "SUB-3");
        assertThatThrownBy(() -> site.signatures.recordUse(same, "SUB-4"))
            .isInstanceOfSatisfying(SignatureReplayException.class, e -> assertThat(e.reason()).isEqualTo("replay"));

        // Judged, then revoked by an administrator before the store: refused, and the revocation stands.
        SignatureVerification pending = site.verify(site.signed(authenticator, Map.of("fullName", "Di")), form, VISITOR);
        assertThat(pending.status()).isEqualTo(SignatureVerification.Status.VALID);
        site.repository.revoke(passkey.id(), "1", site.clock.instant());
        assertThatThrownBy(() -> site.signatures.recordUse(pending, "SUB-5"))
            .isInstanceOfSatisfying(SignatureReplayException.class, e -> assertThat(e.reason()).isEqualTo("revoked"));
        assertThat(site.repository.findById(passkey.id()).orElseThrow().isRevoked()).isTrue();
        assertThat(site.verify(site.signed(authenticator, Map.of("fullName", "Eve")), form, VISITOR).code()).isEqualTo("revoked");
    }

    /** A use given back (the handler did not store the submission) leaves the document sendable again. */
    @Test
    void aReleasedUseCanBeSentAgain() {
        FormSigning form = required("");
        SoftwareAuthenticator authenticator = new SoftwareAuthenticator();
        PasskeyRecord passkey = site.register(authenticator);
        ObjectNode body = site.signed(authenticator, Map.of("fullName", "Ada"));
        SignatureVerification verdict = site.verify(body, form, VISITOR);
        PasskeyUseStore.PasskeyUse use = site.signatures.recordUse(verdict, "");
        assertThat(site.verify(body, form, VISITOR).code()).isEqualTo("replay");
        site.signatures.releaseUse(use);
        assertThat(site.repository.findById(passkey.id()).orElseThrow().signCount()).isEqualTo(passkey.signCount());
        SignatureVerification again = site.verify(body, form, VISITOR);
        assertThat(again.status()).isEqualTo(SignatureVerification.Status.VALID);
        assertThat(site.signatures.recordUse(again, "SUB-1")).isNotNull();
        // Nothing is recorded for a verdict that is not valid.
        assertThat(site.signatures.recordUse(site.verify(body, form, VISITOR), "SUB-2")).isNull();
    }

    /** An authenticator that keeps no counter (0 on both sides) is taken; a later 0 after a count is not. */
    @Test
    void aCounterOfZero() {
        FormSigning form = required("");
        SoftwareAuthenticator noCounter = new SoftwareAuthenticator("localhost", "http://localhost", CoseKey.ES256, new byte[] {1}, false);
        PasskeyRecord passkey = site.register(noCounter);
        for (String name : List.of("Ada", "Bo")) {
            SignatureVerification verdict = site.verify(site.signed(noCounter, Map.of("fullName", name)), form, VISITOR);
            assertThat(verdict.status()).as(name).isEqualTo(SignatureVerification.Status.VALID);
            assertThat(verdict.signCount()).isZero();
            site.signatures.recordUse(verdict, name);
        }
        assertThat(site.repository.findById(passkey.id()).orElseThrow().signCount()).isZero();

        // A counting authenticator's copy that reports 0 once the counter has risen: refused.
        SoftwareAuthenticator counting = new SoftwareAuthenticator();
        PasskeyRecord counted = site.register(counting);
        SignatureVerification first = site.verify(site.signed(counting, Map.of("fullName", "Cy")), form, VISITOR);
        site.signatures.recordUse(first, "SUB-1");
        assertThat(site.repository.findById(counted.id()).orElseThrow().signCount()).isPositive();
        SignatureVerification zero = site.verify(site.signed(counting, Map.of("fullName", "Di"), Map.of("counter", 0L)), form, VISITOR);
        assertThat(zero.code()).isEqualTo("counter");
    }

    /** Malformed signature members are verdicts, never errors; a forgery naming a visitor's passkey names no one. */
    @Test
    void malformedAndForeignSignatures() {
        FormSigning form = required("");
        SoftwareAuthenticator authenticator = new SoftwareAuthenticator();
        PasskeyRecord passkey = site.register(authenticator);
        ObjectNode document = site.signed(authenticator, Map.of("fullName", "Ada"));
        ((ObjectNode) signature(document).get("format")).putObject("scope");
        ((ObjectNode) signature(document).get("webauthn")).putObject("clientDataJSON");
        assertThat(site.verify(document, form, VISITOR)).extracting(SignatureVerification::status, SignatureVerification::code)
            .containsExactly(SignatureVerification.Status.INVALID, "format");
        ObjectNode notText = site.signed(authenticator, Map.of("fullName", "Ada"));
        ((ObjectNode) signature(notText).get("webauthn")).putArray("signature").add("not").add("text");
        assertThat(site.verify(notText, form, VISITOR).code()).isEqualTo("readable");
        ObjectNode statement = site.signed(authenticator, Map.of("fullName", "Ada"));
        signature(statement).put("statement", 5);
        assertThat(site.verify(statement, form, VISITOR).code()).isEqualTo("unreadable");
        // A JSON null scope names no scope: the format is unreadable.
        ObjectNode nullScope = site.signed(authenticator, Map.of("fullName", "Bo"));
        ((ObjectNode) signature(nullScope).get("format")).putNull("scope");
        assertThat(site.verify(nullScope, form, VISITOR)).extracting(SignatureVerification::status, SignatureVerification::code)
            .containsExactly(SignatureVerification.Status.INVALID, "format");

        // Garbage naming a visitor's passkey: invalid, naming no one.
        ObjectNode forged = site.signed(new SoftwareAuthenticator(), Map.of("fullName", "Bo"));
        ((ObjectNode) signature(forged).get("webauthn")).put("credentialId", passkey.credentialId());
        SignatureVerification verdict = site.verify(forged, form, VISITOR);
        assertThat(verdict.status()).isEqualTo(SignatureVerification.Status.INVALID);
        assertThat(verdict.code()).isEqualTo("handle");
        assertThat(verdict.passkey()).isNull();
        ObjectNode forgedNoHandle = site.signed(new SoftwareAuthenticator(), Map.of("fullName", "Cy"));
        ((ObjectNode) signature(forgedNoHandle).get("webauthn")).put("credentialId", passkey.credentialId());
        ((ObjectNode) signature(forgedNoHandle).get("webauthn")).remove("userHandle");
        assertThat(site.verify(forgedNoHandle, form, VISITOR).code()).isEqualTo("signature");
    }

    /** The window is the site's, both ways round. */
    @Test
    void theWindow() {
        site.configure(new WebAuthnSettings("localhost", "Petition", List.of("http://localhost"), Duration.ofSeconds(120), true, false, null, null, null, null));
        FormSigning form = required("");
        SoftwareAuthenticator authenticator = new SoftwareAuthenticator();
        site.register(authenticator);
        ObjectNode body = site.signed(authenticator, Map.of("fullName", "Ada"));
        // Exactly the window old is inside it; a second more is not.
        site.clock.advance(Duration.ofSeconds(120));
        assertThat(site.verify(body, form, VISITOR).status()).isEqualTo(SignatureVerification.Status.VALID);
        site.clock.advance(Duration.ofSeconds(1));
        assertThat(site.verify(body, form, VISITOR).code()).isEqualTo("window");
        site.clock.advance(Duration.ofSeconds(-242));
        assertThat(site.verify(body, form, VISITOR).code()).as("A signing time ahead of the server too.").isEqualTo("window");
        site.clock.advance(Duration.ofSeconds(1));
        assertThat(site.verify(body, form, VISITOR).status()).isEqualTo(SignatureVerification.Status.VALID);
        site.clock.advance(Duration.ofSeconds(120));
        assertThat(site.verify(body, form, VISITOR).status()).isEqualTo(SignatureVerification.Status.VALID);
        // No signing time at all.
        ObjectNode undated = site.signed(authenticator, Map.of("fullName", "Bo"));
        signature(undated).remove("signedAt");
        ((ObjectNode) signature(undated).get("webauthn")).remove("signedAt");
        assertThat(site.verify(undated, form, VISITOR).code()).isEqualTo("window");
    }

    /** The default window is 600 seconds, its edge inside. */
    @Test
    void theDefaultWindowsEdge() {
        FormSigning form = required("");
        SoftwareAuthenticator authenticator = new SoftwareAuthenticator();
        site.register(authenticator);
        ObjectNode body = site.signed(authenticator, Map.of("fullName", "Ada"));
        site.clock.advance(Duration.ofSeconds(600));
        assertThat(site.verify(body, form, VISITOR).status()).isEqualTo(SignatureVerification.Status.VALID);
        site.clock.advance(Duration.ofSeconds(1));
        assertThat(site.verify(body, form, VISITOR).code()).isEqualTo("window");

        // The verifier's order: replay, then the counter, then the window. A stored document sent again late is a replay.
        site.clock.advance(Duration.ofSeconds(-601));
        site.signatures.recordUse(site.verify(body, form, VISITOR), "SUB-1");
        ObjectNode lower = site.signed(authenticator, Map.of("fullName", "Bo"), Map.of("counter", 1L));
        site.clock.advance(Duration.ofSeconds(601));
        assertThat(site.verify(body, form, VISITOR).code()).isEqualTo("replay");
        assertThat(site.verify(lower, form, VISITOR).code()).isEqualTo("counter");
    }

    /** The two signing times may be 60 seconds apart, not 61. */
    @Test
    void theSigningTimesTolerance() {
        FormSigning form = required("");
        SoftwareAuthenticator authenticator = new SoftwareAuthenticator();
        site.register(authenticator);
        for (long apart : new long[] {60, -60, 61, -61}) {
            ObjectNode body = site.signed(authenticator, Map.of("fullName", "Ada " + apart));
            long inner = Instant.parse(signature(body).get("webauthn").get("signedAt").asString()).getEpochSecond();
            signature(body).put("signedAt", (inner - apart) * 1000);
            SignatureVerification verdict = site.verify(body, form, VISITOR);
            if (Math.abs(apart) <= 60) {
                assertThat(verdict.status()).as(apart + " s").isEqualTo(SignatureVerification.Status.VALID);
            } else {
                assertThat(verdict.code()).as(apart + " s").isEqualTo("signed_at");
            }
        }
    }

    /**
     * The step 8 order: a per-form passkey of another account, used on another form, fails "form" (before
     * "owner"), and names no passkey.
     */
    @Test
    void formIsCheckedBeforeOwner() {
        site.configure(new WebAuthnSettings("localhost", "Petition", List.of("http://localhost"), null, true, true, null, null, null, null));
        SoftwareAuthenticator owned = new SoftwareAuthenticator();
        PasskeyRecord passkey = site.register(owned, "Phone", new PasskeySubject("7", "ada", "Ada"));
        assertThat(passkey.formId()).isEqualTo("petition");
        owned.clock = site.clock;
        ObjectNode body = owned.signSubmission(SoftwareAuthenticator.envelope("other", Map.of("fullName", "Bo")));
        SignatureVerification verdict = site.signatures.verify("other", required(""), body, body, new PasskeySubject("8", "bo", "Bo"));
        assertThat(verdict.code()).isEqualTo("form");
        assertThat(verdict.passkey()).isNull();
    }

    /**
     * A release puts back the counter its own record replaced, never the one seen at judging: a
     * use recorded in between stays below the counter, so a copy cannot sign again with its count.
     */
    @Test
    void aReleaseNeverDropsTheCounterBelowAStoredUse() {
        FormSigning form = required("");
        SoftwareAuthenticator authenticator = new SoftwareAuthenticator();
        PasskeyRecord passkey = site.register(authenticator);
        // A and B both judged at the starting counter; both recorded, then B's handler fails.
        SignatureVerification a = site.verify(site.signed(authenticator, Map.of("fullName", "Ada")), form, VISITOR);
        long countA = authenticator.counter;
        ObjectNode bodyB = site.signed(authenticator, Map.of("fullName", "Bo"));
        SignatureVerification b = site.verify(bodyB, form, VISITOR);
        assertThat(List.of(a.status(), b.status())).containsOnly(SignatureVerification.Status.VALID);
        PasskeyUseStore.PasskeyUse useA = site.signatures.recordUse(a, "SUB-A");
        PasskeyUseStore.PasskeyUse useB = site.signatures.recordUse(b, "SUB-B");
        site.signatures.releaseUse(useB);
        assertThat(site.repository.findById(passkey.id()).orElseThrow().signCount()).as("Back to A's, not to the judged one.").isEqualTo(countA);
        // A copy signing with A's count is refused.
        SignatureVerification clone = site.verify(site.signed(authenticator, Map.of("fullName", "Cy"), Map.of("counter", countA)), form, VISITOR);
        assertThat(clone.code()).isEqualTo("counter");
        // B sent again goes through: its claim was given back, and its count is above A's.
        assertThat(site.verify(bodyB, form, VISITOR).status()).isEqualTo(SignatureVerification.Status.VALID);

        // A released after a later use moved the counter on: the counter stays where the later use put it.
        PasskeyUseStore.PasskeyUse useD = site.signatures.recordUse(
            site.verify(site.signed(authenticator, Map.of("fullName", "Eve")), form, VISITOR), "SUB-E");
        site.signatures.releaseUse(useA);
        assertThat(site.repository.findById(passkey.id()).orElseThrow().signCount()).isEqualTo(useD.signCount());
        assertThat(site.uses.used(passkey.publicKeyHash(), a.digest())).as("A's claim is given back.").isFalse();
    }

    /** A release names its own use: one that differs (another time, count or passkey) leaves the claim. */
    @Test
    void aReleaseOfAnotherUseLeavesTheClaim() {
        FormSigning form = required("");
        SoftwareAuthenticator authenticator = new SoftwareAuthenticator();
        PasskeyRecord passkey = site.register(authenticator);
        SignatureVerification verdict = site.verify(site.signed(authenticator, Map.of("fullName", "Ada")), form, VISITOR);
        PasskeyUseStore.PasskeyUse use = site.signatures.recordUse(verdict, "SUB-1");
        for (PasskeyUseStore.PasskeyUse other : List.of(
            new PasskeyUseStore.PasskeyUse(use.keySha256(), use.digest(), use.passkeyId(), "", use.signCount(), use.at().plusSeconds(1)),
            new PasskeyUseStore.PasskeyUse(use.keySha256(), use.digest(), use.passkeyId(), "", use.signCount() + 1, use.at()),
            new PasskeyUseStore.PasskeyUse(use.keySha256(), use.digest(), use.passkeyId() + 1, "", use.signCount(), use.at()))) {
            site.signatures.releaseUse(other);
            assertThat(site.uses.used(passkey.publicKeyHash(), verdict.digest())).isTrue();
            assertThat(site.repository.findById(passkey.id()).orElseThrow().signCount()).isEqualTo(use.signCount());
        }
    }

    /** A valid verdict that names no stored passkey is never recorded as nothing: it fails closed. */
    @Test
    void aValidVerdictWithoutAStoredPasskeyFailsClosed() {
        SoftwareAuthenticator authenticator = new SoftwareAuthenticator();
        PasskeyRecord unsaved = PasskeyRecord.builder().credentialId("abc").publicKey(authenticator.spki).created(site.clock.instant()).build();
        SignatureVerification valid = new SignatureVerification(SignatureVerification.Status.VALID, null, null, unsaved, "abc", null, "envelope",
            null, "0".repeat(64), 2, Map.of());
        assertThatThrownBy(() -> site.signatures.recordUse(valid, "SUB-1")).isInstanceOf(IllegalStateException.class);
    }

    /** One key, one passkey: the repository itself refuses a second credential id with a stored key (the shared SQL's unique key). */
    @Test
    void theRepositoryRefusesAStoredKeyUnderAnotherCredentialId() {
        SoftwareAuthenticator victim = new SoftwareAuthenticator();
        PasskeyRecord stored = site.register(victim);
        PasskeyRecord copy = stored.toBuilder().id(null).credentialId(Base64Url.encode(SoftwareAuthenticator.random(16))).build();
        assertThatThrownBy(() -> site.repository.create(copy)).isInstanceOf(DuplicatePasskeyException.class);
        // Revoked and removed included.
        site.repository.revoke(stored.id(), "1", site.clock.instant());
        site.repository.markRemoved(stored.id(), site.clock.instant());
        assertThatThrownBy(() -> site.repository.create(copy)).isInstanceOf(DuplicatePasskeyException.class);
        assertThat(site.repository.ofOwner("")).isEmpty();
    }

    /**
     * Numbers next to a power of two are rebuilt as the browser wrote them (ECMAScript's spelling): the signature verifies, from the node tree and from the JSON text a receiver reads.
     */
    @Test
    void numbersAreRebuiltAsTheBrowserWroteThem() {
        FormSigning form = required("");
        SoftwareAuthenticator authenticator = new SoftwareAuthenticator();
        site.register(authenticator);
        ObjectNode body = site.signed(authenticator, Map.of("tiny", Math.scalb(1.0, -24), "huge", Math.scalb(1.0, 89), "small", Math.scalb(1.0, -44)));
        assertThat(SignedText.text(body, "envelope", null)).contains("5.960464477539063e-8", "6.189700196426902e+26", "5.684341886080802e-14");
        SignatureVerification verdict = site.verify(body, form, VISITOR);
        assertThat(verdict.status()).as(String.valueOf(verdict.reason())).isEqualTo(SignatureVerification.Status.VALID);
        ObjectNode read = (ObjectNode) SoftwareAuthenticator.JSON.readTree(SoftwareAuthenticator.JSON.writeValueAsString(body));
        assertThat(site.verify(read, form, VISITOR).status()).isEqualTo(SignatureVerification.Status.VALID);
    }
}
