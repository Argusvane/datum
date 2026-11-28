package com.argusvane.datum.webauthn;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.Base64;
import java.util.List;
import java.util.Map;
import org.assertj.core.api.ThrowableAssert.ThrowingCallable;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ObjectNode;

/**
 * Registration through the ceremony: a registration, and a copied key that cannot replay (its registration half).
 */
class RegistrationCeremonyTest {

    private final Passkeys site = new Passkeys();
    private final FormSigning required = FormSigning.builder().mode(FormSigning.Mode.REQUIRED).build();

    private static PasskeyException refusal(ThrowingCallable call) {
        try {
            call.call();
        } catch (PasskeyException e) {
            return e;
        } catch (Throwable e) {
            throw new AssertionError("Expected a PasskeyException, got " + e, e);
        }
        throw new AssertionError("Expected a PasskeyException.");
    }

    /** Anonymous registration, the challenge's rules, and what is kept. */
    @Test
    void registration() {
        SoftwareAuthenticator authenticator = new SoftwareAuthenticator();
        PasskeyRecord passkey = site.register(authenticator);
        assertThat(passkey.owner()).as("A visitor's passkey is anonymous.").isEmpty();
        assertThat(passkey.publicKey()).as("The key from the authenticator data is kept.").isEqualTo(authenticator.spki);
        assertThat(passkey.algorithm()).isEqualTo(CoseKey.ES256);
        assertThat(passkey.label()).isEqualTo("Ada Lovelace");
        assertThat(passkey.transports()).containsExactly("internal", "hybrid");
        assertThat(passkey.formId()).as("Site-wide passkeys by default.").isEmpty();
        assertThat(passkey.userHandle()).isNotEmpty();
        assertThat(passkey.attestation()).isEqualTo("none");
        assertThat(passkey.aaguid()).isEqualTo("00000000-0000-0000-0000-000000000000");
        assertThat(passkey.rpId()).isEqualTo("localhost");
        assertThat(passkey.webOrigin()).isEqualTo("http://localhost");
        assertThat(passkey.madeOn()).isEqualTo("petition");
        assertThat(passkey.origin()).isEqualTo("form");
        assertThat(passkey.browser()).isEqualTo("Chrome on macOS");
        assertThat(passkey.userVerified()).isTrue();
        assertThat(passkey.backupEligible()).isTrue();
        assertThat(passkey.backedUp()).isTrue();
        assertThat(passkey.created()).isEqualTo(site.clock.instant());

        PasskeySubject visitor = PasskeySubject.anonymous();
        PasskeyContext context = site.context(visitor, required);
        // A challenge registers one passkey.
        RegistrationOptions challenge = site.ceremony.challenge(context, visitor, "");
        assertThat(challenge.user().name()).as("The default name: \"<site name> signer\".").isEqualTo("Petition signer");
        assertThat(challenge.residentKey()).isEqualTo("required");
        assertThat(challenge.attestation()).isEqualTo("none");
        assertThat(challenge.pubKeyCredParams()).extracting(RegistrationOptions.CredentialParameter::alg).containsExactly(-7, -257);
        assertThat(challenge.excludeCredentials()).as("None for a passkey with no owner.").isEmpty();
        SoftwareAuthenticator other = new SoftwareAuthenticator();
        assertThat(site.ceremony.register(context, visitor, Passkeys.posted(challenge.token(), null, other.register(challenge.challenge())), "")).isNotNull();
        SoftwareAuthenticator third = new SoftwareAuthenticator();
        PasskeyException used = refusal(() -> site.ceremony.register(context, visitor, Passkeys.posted(challenge.token(), null, third.register(challenge.challenge())), ""));
        assertThat(used.code()).as("A used challenge is refused.").isEqualTo("passkey.challenge");
        assertThat(used.httpStatus()).isEqualTo(400);
        assertThat(used.getMessage()).isEqualTo("The passkey request has expired or was used. Try again.");

        // The challenge must be the one handed out, the origin this site's.
        RegistrationOptions fresh = site.ceremony.challenge(context, visitor, "");
        PasskeyException wrong = refusal(() -> site.ceremony.register(context, visitor,
            Passkeys.posted(fresh.token(), null, third.register(Base64Url.encode(SoftwareAuthenticator.random(32)))), ""));
        assertThat(List.of(wrong.code(), wrong.httpStatus(), wrong.check())).containsExactly("passkey.invalid", 422, "challenge");
        assertThat(wrong.getMessage()).isEqualTo("The passkey could not be verified. Try again.");
        RegistrationOptions fresh2 = site.ceremony.challenge(context, visitor, "");
        PasskeyException elsewhere = refusal(() -> site.ceremony.register(context, visitor,
            Passkeys.posted(fresh2.token(), null, third.register(fresh2.challenge(), Map.of("origin", "https://evil.example"))), ""));
        assertThat(List.of(elsewhere.code(), elsewhere.check())).containsExactly("passkey.invalid", "origin");
        assertThat(elsewhere.getMessage()).isEqualTo("Passkeys are not set up for this address of the site. Contact us.");
        // Made for another user handle than the one handed out.
        RegistrationOptions fresh3 = site.ceremony.challenge(context, visitor, "");
        String handle = Base64Url.encode(SoftwareAuthenticator.random(16));
        PasskeyException otherHandle = refusal(() -> site.ceremony.register(context, visitor,
            Passkeys.posted(fresh3.token(), null, third.register(fresh3.challenge(), Map.of("userHandle", handle))), ""));
        assertThat(List.of(otherHandle.code(), otherHandle.check())).containsExactly("passkey.invalid", "handle");
        // A token for another form, or another account, is refused.
        assertThat(site.challenges.claim(fresh3.token(), "register", "other", "")).isEmpty();
        assertThat(site.challenges.claim(fresh3.token(), "register", "petition", "5")).isEmpty();
        // The same credential twice is refused.
        RegistrationOptions fresh4 = site.ceremony.challenge(context, visitor, "");
        PasskeyException twice = refusal(() -> site.ceremony.register(context, visitor,
            Passkeys.posted(fresh4.token(), null, authenticator.register(fresh4.challenge())), ""));
        assertThat(List.of(twice.code(), twice.httpStatus())).containsExactly("passkey.exists", 409);
        assertThat(twice.getMessage()).isEqualTo("This passkey is registered already.");

        // Signed in: the passkey is theirs, and their next one shares its handle.
        PasskeySubject person = new PasskeySubject("7", "ada", "Ada L.");
        PasskeyRecord mine = site.register(new SoftwareAuthenticator(CoseKey.RS256), "Laptop", person);
        assertThat(mine.owner()).isEqualTo("7");
        assertThat(mine.algorithm()).isEqualTo(CoseKey.RS256);
        RegistrationOptions next = site.ceremony.challenge(site.context(person, required), person, "");
        assertThat(next.user().id()).isEqualTo(mine.userHandle());
        assertThat(next.user().name()).as("A signed-in person's display name.").isEqualTo("Ada L.");
        assertThat(next.excludeCredentials()).extracting(RegistrationOptions.CredentialReference::id).containsExactly(mine.credentialId());
    }

    /** A key copied from a signature, under a credential id of the attacker's choosing, is refused. */
    @Test
    void aCopiedKeyIsRefused() {
        SoftwareAuthenticator victim = new SoftwareAuthenticator();
        site.register(victim);
        SoftwareAuthenticator copy = victim.copyWithCredentialId(SoftwareAuthenticator.random(16));
        PasskeySubject visitor = PasskeySubject.anonymous();
        PasskeyContext context = site.context(visitor, required);
        RegistrationOptions challenge = site.ceremony.challenge(context, visitor, "");
        PasskeyException refused = refusal(() -> site.ceremony.register(context, visitor,
            Passkeys.posted(challenge.token(), null, copy.register(challenge.challenge(), Map.of("userHandle", challenge.user().id()))), ""));
        assertThat(List.of(refused.code(), refused.httpStatus())).containsExactly("passkey.exists", 409);
    }

    /** What cannot be read is a bad request, before the token is looked at. */
    @Test
    void unreadableBodies() {
        PasskeySubject visitor = PasskeySubject.anonymous();
        PasskeyContext context = site.context(visitor, required);
        RegistrationOptions challenge = site.ceremony.challenge(context, visitor, "");
        ObjectNode record = new SoftwareAuthenticator().register(challenge.challenge());
        ObjectNode noToken = Passkeys.posted(challenge.token(), null, record);
        noToken.remove("token");
        ObjectNode noResponse = Passkeys.posted(challenge.token(), null, record.deepCopy());
        ((ObjectNode) noResponse.get("credential")).remove("response");
        ObjectNode numericId = Passkeys.posted(challenge.token(), null, record.deepCopy());
        ((ObjectNode) numericId.get("credential")).put("id", 5);
        for (Object body : new Object[] {null, SoftwareAuthenticator.JSON.createArrayNode(), noToken, noResponse, numericId}) {
            PasskeyException refused = refusal(() -> site.ceremony.register(context, visitor, (tools.jackson.databind.JsonNode) body, ""));
            assertThat(List.of(refused.code(), refused.httpStatus())).as(String.valueOf(body)).containsExactly("passkey.bad_request", 400);
        }
        // None of them used the challenge.
        assertThat(site.ceremony.register(context, visitor, Passkeys.posted(challenge.token(), null, record), "")).isNotNull();
    }

    /** User verification required by the form: a registration without it is refused with its own words. */
    @Test
    void userVerificationRequired() {
        PasskeySubject visitor = PasskeySubject.anonymous();
        FormSigning strict = FormSigning.builder().mode(FormSigning.Mode.REQUIRED).userVerification("required").build();
        PasskeyContext context = site.context(visitor, strict);
        RegistrationOptions challenge = site.ceremony.challenge(context, visitor, "");
        assertThat(challenge.userVerification()).isEqualTo("required");
        PasskeyException refused = refusal(() -> site.ceremony.register(context, visitor,
            Passkeys.posted(challenge.token(), null, new SoftwareAuthenticator().register(challenge.challenge(), Map.of("uv", false))), ""));
        assertThat(refused.check()).isEqualTo("userVerified");
        assertThat(refused.getMessage()).startsWith("This form needs your device to check it is you");
    }

    /**
     * The key the page reports must be the authenticator data's; a report that is not base64 is a key that is none,
     * refused the same way.
     */
    @Test
    void theReportedKeyIsCrossChecked() {
        PasskeySubject visitor = PasskeySubject.anonymous();
        PasskeyContext context = site.context(visitor, required);
        RegistrationOptions challenge = site.ceremony.challenge(context, visitor, "");
        ObjectNode record = new SoftwareAuthenticator().register(challenge.challenge());
        record.put("publicKey", Base64.getEncoder().encodeToString(new SoftwareAuthenticator().spki));
        PasskeyException refused = refusal(() -> site.ceremony.register(context, visitor, Passkeys.posted(challenge.token(), null, record), ""));
        assertThat(refused.check()).isEqualTo("publicKey");
        RegistrationOptions again = site.ceremony.challenge(context, visitor, "");
        ObjectNode garbled = new SoftwareAuthenticator().register(again.challenge());
        garbled.put("publicKey", "not base64!");
        PasskeyException unreadable = refusal(() -> site.ceremony.register(context, visitor, Passkeys.posted(again.token(), null, garbled), ""));
        assertThat(unreadable.check()).isEqualTo("publicKey");
        assertThat(unreadable.code()).isEqualTo("passkey.invalid");
        assertThat(unreadable.httpStatus()).isEqualTo(422);
        // With no reported key at all, the authenticator data's is taken.
        RegistrationOptions third = site.ceremony.challenge(context, visitor, "");
        ObjectNode unreported = new SoftwareAuthenticator().register(third.challenge());
        unreported.remove("publicKey");
        assertThat(site.ceremony.register(context, visitor, Passkeys.posted(third.token(), null, unreported), "")).isNotNull();
    }

    /** Per-form passkeys sign their form alone; a race on the unique key is a 409. */
    @Test
    void perFormAndRaces() {
        site.configure(new WebAuthnSettings("localhost", "Petition", List.of("http://localhost"), null, true, true, null, null, null, null));
        PasskeyRecord passkey = site.register(new SoftwareAuthenticator());
        assertThat(passkey.formId()).isEqualTo("petition");

        InMemoryPasskeyRepository repository = new InMemoryPasskeyRepository();
        PasskeyRepository duplicate = new DelegatingRepository(repository) {
            @Override
            public PasskeyRecord create(PasskeyRecord record) {
                throw new DuplicatePasskeyException("unique key");
            }
        };
        RegistrationCeremony ceremony = new RegistrationCeremony(site.settings, site.challenges, duplicate, site.verifier, site.clock, List.of(), List.of());
        PasskeySubject visitor = PasskeySubject.anonymous();
        PasskeyContext context = site.context(visitor, required);
        RegistrationOptions challenge = ceremony.challenge(context, visitor, "");
        PasskeyException refused = refusal(() -> ceremony.register(context, visitor,
            Passkeys.posted(challenge.token(), null, new SoftwareAuthenticator().register(challenge.challenge())), ""));
        assertThat(List.of(refused.code(), refused.httpStatus())).containsExactly("passkey.exists", 409);
    }

    @Test
    void labelsAreCleaned() {
        assertThat(PasskeyLabels.clean("  Ada\u0000\u0001Lovelace\n ")).isEqualTo("Ada Lovelace");
        assertThat(PasskeyLabels.clean(" \t ")).isNull();
        assertThat(PasskeyLabels.clean("x".repeat(200))).hasSize(128);
        assertThat(PasskeyLabels.clean("😀".repeat(130))).hasSize(256);
        assertThat(PasskeyLabels.clean("a\ud800b")).isEqualTo("a?b");
    }

    /** A repository that hands every call on. */
    static class DelegatingRepository implements PasskeyRepository {
        private final PasskeyRepository delegate;

        DelegatingRepository(PasskeyRepository delegate) {
            this.delegate = delegate;
        }

        @Override public java.util.Optional<PasskeyRecord> find(String credentialId) { return delegate.find(credentialId); }
        @Override public java.util.Optional<PasskeyRecord> findById(long id) { return delegate.findById(id); }
        @Override public boolean keyRegistered(String publicKeyHash) { return delegate.keyRegistered(publicKeyHash); }
        @Override public java.util.Optional<PasskeyRecord> firstOf(String owner, String formId) { return delegate.firstOf(owner, formId); }
        @Override public List<PasskeyRecord> ownActive(String owner, String formId) { return delegate.ownActive(owner, formId); }
        @Override public List<PasskeyRecord> ofOwner(String owner) { return delegate.ofOwner(owner); }
        @Override public PasskeyRecord create(PasskeyRecord passkey) { return delegate.create(passkey); }
        @Override public boolean revoke(long id, String by, java.time.Instant at) { return delegate.revoke(id, by, at); }
        @Override public boolean markRemoved(long id, java.time.Instant at) { return delegate.markRemoved(id, at); }
        @Override public boolean delete(long id) { return delegate.delete(id); }
        @Override public boolean touch(long id, long signCount, java.time.Instant at) { return delegate.touch(id, signCount, at); }
    }
}
