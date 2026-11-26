package com.argusvane.datum.webauthn;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.hooks.HookProblem;
import com.argusvane.datum.core.hooks.HookRefusedException;
import com.argusvane.datum.web.error.ErrorItem;
import com.argusvane.datum.web.error.ErrorMapper;
import com.argusvane.datum.web.error.ErrorResponse;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ObjectNode;

/**
 * The passkey side of the hook model: {@link RegistrationCustomizer}s at both calls of the ceremony (before a
 * challenge is issued, before a registration's challenge is claimed) set the label and a stricter user verification or
 * resident key, or refuse; {@link RegistrationValidator}s judge a verified passkey after Datum's own refusals and before the
 * store. Order, the refusal by its kind, and a hook that throws failing the request.
 */
class RegistrationHooksTest {

    private final Passkeys site = new Passkeys();
    private final FormSigning preferred = FormSigning.builder().mode(FormSigning.Mode.REQUIRED).build();
    private final PasskeySubject visitor = PasskeySubject.anonymous();
    private final ErrorMapper errors = new ErrorMapper(false, List.of());

    private RegistrationCeremony ceremony(List<RegistrationCustomizer> customizers, List<RegistrationValidator> validators) {
        return new RegistrationCeremony(site.settings, site.challenges, site.repository, site.verifier, site.clock, customizers, validators);
    }

    private static ObjectNode made(SoftwareAuthenticator authenticator, RegistrationOptions options, boolean uv) {
        return authenticator.register(options.challenge(), Map.of("userHandle", options.user().id(), "uv", uv));
    }

    @Test
    void theCustomizersRunInOrderAtBothStepsAndSetTheLabelAndAStricterUserVerification() {
        List<String> seen = new ArrayList<>();
        RegistrationCustomizer label = draft -> {
            seen.add("label:" + draft.step() + ":" + draft.label() + ":" + draft.context().subject());
            draft.label("Work key");
        };
        RegistrationCustomizer strict = draft -> {
            seen.add("strict:" + draft.step() + ":" + draft.label() + ":" + draft.userVerification());
            draft.userVerification("required");
        };
        RegistrationCeremony ceremony = ceremony(List.of(label, strict), List.of());
        PasskeyContext context = site.context(visitor, preferred);
        assertThat(context.userVerification()).isEqualTo("preferred");

        RegistrationOptions options = ceremony.challenge(context, visitor, "Phone");
        assertThat(options.user().name()).isEqualTo("Work key");
        assertThat(options.userVerification()).isEqualTo("required");
        assertThat(options.residentKey()).isEqualTo("required");
        assertThat(seen).containsExactly("label:CHALLENGE:Phone:petition", "strict:CHALLENGE:Work key:preferred");

        SoftwareAuthenticator authenticator = new SoftwareAuthenticator();
        assertThatThrownBy(() -> ceremony.register(context, visitor, Passkeys.posted(options.token(), "Phone", made(authenticator, options, false)), ""))
            .as("the registration step checks the stricter user verification")
            .isInstanceOfSatisfying(PasskeyException.class, e -> assertThat(List.of(e.code(), e.check())).containsExactly("passkey.invalid", "userVerified"));

        RegistrationOptions again = ceremony.challenge(context, visitor, "Phone");
        PasskeyRecord stored = ceremony.register(context, visitor, Passkeys.posted(again.token(), "Phone", made(authenticator, again, true)), "");
        assertThat(stored.label()).isEqualTo("Work key");
        assertThat(seen).contains("label:REGISTER:Phone:petition", "strict:REGISTER:Work key:preferred");
    }

    @Test
    void aCustomizerMayMakeThePolicyStricterNeverWeaker() {
        PasskeyContext required = site.context(visitor, FormSigning.builder().mode(FormSigning.Mode.REQUIRED).userVerification("required").build());
        RegistrationCeremony weakerUv = ceremony(List.of(draft -> draft.userVerification("preferred")), List.of());
        assertThatThrownBy(() -> weakerUv.challenge(required, visitor, "")).isInstanceOf(IllegalArgumentException.class).hasMessageContaining("never weaker");
        RegistrationCeremony weakerKey = ceremony(List.of(draft -> draft.residentKey("discouraged")), List.of());
        assertThatThrownBy(() -> weakerKey.challenge(site.context(visitor, preferred), visitor, "")).isInstanceOf(IllegalArgumentException.class);
        RegistrationCeremony unknown = ceremony(List.of(draft -> draft.userVerification("always")), List.of());
        assertThatThrownBy(() -> unknown.challenge(site.context(visitor, preferred), visitor, "")).isInstanceOf(IllegalArgumentException.class);
    }

    /**
     * Never weaker than an earlier customizer either (the rule of {@code SignatureCheckDraft}): each
     * value is compared with what the draft holds now, so a later hook (another starter's, say) cannot undo what one before it
     * required, at either step.
     */
    @Test
    void aLaterCustomizerCannotUndoAnEarlierOne() {
        PasskeyContext context = site.context(visitor, preferred);
        RegistrationCeremony undoUv = ceremony(List.of(
            draft -> draft.userVerification("required"),
            draft -> draft.userVerification("preferred")), List.of());
        assertThatThrownBy(() -> undoUv.challenge(context, visitor, "")).as("the challenge step")
            .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("never weaker");

        // The registration step runs the same chain over its own draft: an earlier required cannot be undone there either.
        RegistrationCeremony plain = ceremony(List.of(), List.of());
        RegistrationOptions options = plain.challenge(context, visitor, "");
        SoftwareAuthenticator authenticator = new SoftwareAuthenticator();
        ObjectNode posted = Passkeys.posted(options.token(), null, made(authenticator, options, false));
        assertThatThrownBy(() -> undoUv.register(context, visitor, posted, "")).as("the registration step")
            .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("never weaker");
        assertThat(site.repository.find(Base64Url.encode(authenticator.credentialId))).as("nothing stored").isEmpty();

        // A site whose resident key is preferred: one customizer requires a discoverable key, a later one cannot ask less.
        Passkeys lenient = new Passkeys(new WebAuthnSettings("localhost", "Petition", List.of("http://localhost"), null, true, false,
            "preferred", null, null, null));
        RegistrationCeremony undoKey = new RegistrationCeremony(lenient.settings, lenient.challenges, lenient.repository, lenient.verifier,
            lenient.clock, List.of(draft -> draft.residentKey("required"), draft -> draft.residentKey("preferred")), List.of());
        assertThatThrownBy(() -> undoKey.challenge(lenient.context(visitor, preferred), visitor, ""))
            .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("never weaker");

        // The same value again, or a stricter one, is fine.
        List<String> seen = new ArrayList<>();
        RegistrationCeremony tightening = new RegistrationCeremony(lenient.settings, lenient.challenges, lenient.repository, lenient.verifier,
            lenient.clock, List.of(
                draft -> {
                    draft.userVerification("preferred");
                    draft.residentKey("preferred");
                },
                draft -> {
                    draft.userVerification("required");
                    draft.userVerification("required");
                    draft.residentKey("required");
                    draft.residentKey("required");
                    seen.add(draft.userVerification() + " " + draft.residentKey());
                }), List.of());
        RegistrationOptions strict = tightening.challenge(lenient.context(visitor, preferred), visitor, "");
        assertThat(strict.userVerification()).isEqualTo("required");
        assertThat(strict.residentKey()).isEqualTo("required");
        assertThat(seen).containsExactly("required required");
    }

    @Test
    void aRefusalAtTheChallengeIssuesNoneAndAtTheRegistrationSpendsNone() {
        AtomicBoolean refuse = new AtomicBoolean(true);
        List<String> ran = new ArrayList<>();
        RegistrationCeremony ceremony = ceremony(List.of(draft -> {
            ran.add(draft.step().name());
            if (refuse.get()) {
                throw HookRefusedException.forbidden("passkey.tenant", "Passkeys are not offered to your organization.");
            }
        }, draft -> ran.add("later")), List.of());
        PasskeyContext context = site.context(visitor, preferred);

        assertThatThrownBy(() -> ceremony.challenge(context, visitor, "")).isInstanceOfSatisfying(HookRefusedException.class, e -> {
            ErrorResponse answer = errors.map(e);
            assertThat(answer.status()).isEqualTo(403);
            assertThat(answer.body().get("errors")).isEqualTo(List.of(new ErrorItem(null, "passkey.tenant", "Passkeys are not offered to your organization.")));
        });
        assertThat(ran).containsExactly("CHALLENGE");

        refuse.set(false);
        RegistrationOptions options = ceremony.challenge(context, visitor, "");
        refuse.set(true);
        SoftwareAuthenticator authenticator = new SoftwareAuthenticator();
        ObjectNode posted = Passkeys.posted(options.token(), null, made(authenticator, options, true));
        assertThatThrownBy(() -> ceremony.register(context, visitor, posted, "")).isInstanceOf(HookRefusedException.class);
        refuse.set(false);
        assertThat(ceremony.register(context, visitor, posted, "")).as("the refused registration spent no challenge").isNotNull();
    }

    @Test
    void aCustomizerThatThrowsFailsTheRequestAndStoresNothing() {
        RegistrationCeremony broken = ceremony(List.of(draft -> {
            if (draft.step() == RegistrationDraft.Step.REGISTER) {
                throw new IllegalStateException("directory down");
            }
        }), List.of());
        PasskeyContext context = site.context(visitor, preferred);
        RegistrationOptions options = broken.challenge(context, visitor, "");
        SoftwareAuthenticator authenticator = new SoftwareAuthenticator();

        assertThatThrownBy(() -> broken.register(context, visitor, Passkeys.posted(options.token(), null, made(authenticator, options, true)), ""))
            .isInstanceOfSatisfying(IllegalStateException.class, e -> assertThat(errors.map(e).status()).isEqualTo(500));
        assertThat(site.repository.find(Base64Url.encode(authenticator.credentialId))).isEmpty();
    }

    @Test
    void everyValidatorRunsAfterTheVerificationAndTheirErrorsRefuseTogether() {
        List<String> seen = new ArrayList<>();
        RegistrationValidator aaguid = (context, asking, passkey) -> {
            seen.add("aaguid:" + passkey.aaguid() + ":" + passkey.attestation() + ":" + passkey.userVerified() + ":" + context.subject());
            return List.of(HookProblem.of("passkey.aaguid", "This kind of authenticator is not allowed."));
        };
        RegistrationValidator backup = (context, asking, passkey) -> {
            seen.add("backup:" + passkey.backedUp());
            return List.of(HookProblem.at("backedUp", "passkey.synced", "Synced passkeys are not allowed."));
        };
        RegistrationCeremony ceremony = ceremony(List.of(), List.of(aaguid, backup));
        PasskeyContext context = site.context(visitor, preferred);
        RegistrationOptions options = ceremony.challenge(context, visitor, "");
        SoftwareAuthenticator authenticator = new SoftwareAuthenticator();

        assertThatThrownBy(() -> ceremony.register(context, visitor, Passkeys.posted(options.token(), null, made(authenticator, options, true)), ""))
            .isInstanceOfSatisfying(HookRefusedException.class, e -> {
                assertThat(e.kind()).isEqualTo(HookRefusedException.Kind.INVALID);
                ErrorResponse answer = errors.map(e);
                assertThat(answer.status()).isEqualTo(422);
                assertThat(answer.body().get("errors")).isEqualTo(List.of(new ErrorItem(null, "passkey.aaguid", "This kind of authenticator is not allowed."),
                    new ErrorItem("backedUp", "passkey.synced", "Synced passkeys are not allowed.")));
            });
        assertThat(seen).containsExactly("aaguid:00000000-0000-0000-0000-000000000000:none:true:petition", "backup:true");
        assertThat(site.repository.find(Base64Url.encode(authenticator.credentialId))).as("nothing stored").isEmpty();
    }

    @Test
    void datumsOwnRefusalsComeFirstAndAThrowingValidatorFailsTheRequest() {
        SoftwareAuthenticator known = new SoftwareAuthenticator();
        site.register(known);
        RegistrationCeremony refusing = ceremony(List.of(), List.of((context, asking, passkey) -> {
            throw new AssertionError("never asked about a passkey Datum refuses");
        }));
        PasskeyContext context = site.context(visitor, preferred);
        RegistrationOptions options = refusing.challenge(context, visitor, "");
        assertThatThrownBy(() -> refusing.register(context, visitor, Passkeys.posted(options.token(), null, known.register(options.challenge())), ""))
            .isInstanceOfSatisfying(PasskeyException.class, e -> assertThat(e.code()).isEqualTo("passkey.exists"));

        RegistrationCeremony broken = ceremony(List.of(), List.of((context2, asking, passkey) -> {
            throw new IllegalStateException("allow-list service down");
        }));
        RegistrationOptions fresh = broken.challenge(context, visitor, "");
        SoftwareAuthenticator authenticator = new SoftwareAuthenticator();
        assertThatThrownBy(() -> broken.register(context, visitor, Passkeys.posted(fresh.token(), null, made(authenticator, fresh, true)), ""))
            .isInstanceOf(IllegalStateException.class);

        RegistrationCeremony conflicting = ceremony(List.of(), List.of((context3, asking, passkey) -> {
            throw HookRefusedException.conflict("passkey.limit", "You have five passkeys already.");
        }));
        RegistrationOptions third = conflicting.challenge(context, visitor, "");
        SoftwareAuthenticator another = new SoftwareAuthenticator();
        assertThatThrownBy(() -> conflicting.register(context, visitor, Passkeys.posted(third.token(), null, made(another, third, true)), ""))
            .isInstanceOfSatisfying(HookRefusedException.class, e -> assertThat(errors.map(e).status()).isEqualTo(409));
        assertThat(site.repository.find(Base64Url.encode(authenticator.credentialId))).isEmpty();
        assertThat(site.repository.find(Base64Url.encode(another.credentialId))).isEmpty();
    }
}
