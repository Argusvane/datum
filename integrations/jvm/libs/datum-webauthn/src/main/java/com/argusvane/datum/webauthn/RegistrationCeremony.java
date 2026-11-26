package com.argusvane.datum.webauthn;

import com.argusvane.datum.core.hooks.HookProblem;
import com.argusvane.datum.core.hooks.HookRefusedException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Clock;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;

/**
 * Registering passkeys (endpoint catalog {@code passkeyChallenge}, {@code passkeyRegister}).
 *
 * <p>Two calls from the page: {@link #challenge} hands out a signed, single-use challenge with a random user
 * handle and the relying party's settings; {@link #register} verifies what the browser's create() made
 * ({@link WebAuthnVerifier#verifyRegistration}) and stores the passkey with the key from the authenticator data,
 * never one the page names. In order: the body must be readable (400 {@code passkey.bad_request}); the token
 * must be this site's, for this context and this person, unexpired and unused (400 {@code passkey.challenge});
 * the user handle the browser reports must be the one handed out (422 {@code passkey.invalid}); every WebAuthn
 * check must pass (422 {@code passkey.invalid}); the credential id must be new (409 {@code passkey.exists}); and
 * so must the key: attestation is "none", so registration proves nothing about the private key, and a key read
 * from someone's signature must not come back under a new credential id (409 {@code passkey.exists}).
 *
 * <p>A signed-in person's passkeys share one user handle (their first passkey's in the same scope), so an
 * authenticator keeps one passkey per account for the site, and the challenge names the others
 * (excludeCredentials) so a device is not registered twice; a visitor's is new each time. Random bytes either
 * way: never the account id, a name or an address.
 *
 * <p>The application's hooks: its {@link RegistrationCustomizer}s at both calls, before the challenge is issued
 * and before a registration's challenge is claimed (after the 400 for an unreadable body), and its
 * {@link RegistrationValidator}s after every check above passed, right before the passkey is stored.
 *
 * <p>Logs never name a passkey by its label, which may be an answer; only by credential id.
 */
public final class RegistrationCeremony {

    private static final Logger LOG = LoggerFactory.getLogger(RegistrationCeremony.class);
    private static final Pattern TRANSPORT = Pattern.compile("[a-z-]{1,32}");

    private final WebAuthnSettings settings;
    private final PasskeyChallenges challenges;
    private final PasskeyRepository passkeys;
    private final WebAuthnVerifier verifier;
    private final Clock clock;
    private final List<RegistrationCustomizer> customizers;
    private final List<RegistrationValidator> validators;
    private final SecureRandom random = new SecureRandom();

    public RegistrationCeremony(WebAuthnSettings settings, PasskeyChallenges challenges, PasskeyRepository passkeys, WebAuthnVerifier verifier,
                                Clock clock) {
        this(settings, challenges, passkeys, verifier, clock, List.of(), List.of());
    }

    /**
     * As above with the application's registration hooks, each list in the framework's order.
     *
     * @param customizers the per-request policy, at the challenge and before a registration is claimed
     * @param validators the judgement of a verified passkey, before it is stored
     */
    public RegistrationCeremony(WebAuthnSettings settings, PasskeyChallenges challenges, PasskeyRepository passkeys, WebAuthnVerifier verifier,
                                Clock clock, List<RegistrationCustomizer> customizers, List<RegistrationValidator> validators) {
        this.customizers = List.copyOf(Objects.requireNonNull(customizers, "customizers"));
        this.validators = List.copyOf(Objects.requireNonNull(validators, "validators"));
        this.settings = Objects.requireNonNull(settings, "settings");
        this.challenges = Objects.requireNonNull(challenges, "challenges");
        this.passkeys = Objects.requireNonNull(passkeys, "passkeys");
        this.verifier = Objects.requireNonNull(verifier, "verifier");
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    /**
     * What the browser needs to create a passkey.
     *
     * @param context what it is made for
     * @param asking who asks: a signed-in person, or an anonymous visitor
     * @param label the name the passkey will carry, or "" for the default
     */
    public RegistrationOptions challenge(PasskeyContext context, PasskeySubject asking, String label) {
        // The application's customizers first: a refused request issues no challenge.
        RegistrationDraft draft = customized(RegistrationDraft.Step.CHALLENGE, context, asking, label);
        String handle = handleFor(context.owner(), context.restrictTo());
        PasskeyChallenges.IssuedChallenge issued = challenges.issue(context.purpose(), context.subject(), asking.uid(), handle);
        String name = PasskeyLabels.clean(draft.label());
        if (name == null) {
            name = asking.isAnonymous() ? context.defaultLabel() : asking.displayName();
        }
        // The owner's passkeys in the same scope (those that sign any form, and those for the form a per-form
        // passkey signs); none for a passkey with no owner.
        List<RegistrationOptions.CredentialReference> exclude = new ArrayList<>();
        if (!context.owner().isEmpty()) {
            for (PasskeyRecord passkey : passkeys.ownActive(context.owner(), context.restrictTo())) {
                exclude.add(new RegistrationOptions.CredentialReference(passkey.credentialId(), passkey.transports()));
            }
        }
        return new RegistrationOptions(issued.challenge(), issued.token(), issued.expires(),
            new RegistrationOptions.RelyingParty(settings.rpId(), settings.rpName()),
            new RegistrationOptions.User(handle, name, name), draft.userVerification(), draft.residentKey(), exclude,
            RegistrationOptions.ALGORITHMS, "none");
    }

    /**
     * Verifies and stores a passkey the browser created.
     *
     * @param context what it was made for: the same as the challenge's, which is bound to it
     * @param asking who registers it
     * @param posted the posted body: {@code {token, label?, credential: {id, publicKey, algorithm, transports,
     *     userHandle, response: {clientDataJSON, authenticatorData, attestationObject, transports}}}}, from what
     *     the engine's {@code registerCredential()} returned
     * @param browser a short summary of the registering browser ("Chrome on macOS") or ""; never the
     *     User-Agent itself
     * @return the stored passkey
     * @throws PasskeyException for every refusal, with the catalog's code, status and words
     */
    public PasskeyRecord register(PasskeyContext context, PasskeySubject asking, JsonNode posted, @Nullable String browser) {
        String where = !context.madeOn().isEmpty() ? context.madeOn() : context.subject();
        JsonNode credential = posted != null && posted.isObject() && posted.get("credential") != null && posted.get("credential").isObject()
            ? posted.get("credential") : null;
        JsonNode response = credential != null && credential.get("response") != null && credential.get("response").isObject()
            ? credential.get("response") : null;
        String token = posted != null && posted.isObject() ? text(posted, "token") : null;
        if (credential == null || response == null || token == null || text(credential, "id") == null) {
            throw new PasskeyException("passkey.bad_request", 400, "The passkey could not be read.", null);
        }
        // The application's customizers before the challenge is claimed, so a refusal spends none.
        RegistrationDraft draft = customized(RegistrationDraft.Step.REGISTER, context, asking, text(posted, "label"));
        Optional<PasskeyChallenges.ClaimedChallenge> claimed = challenges.claim(token, context.purpose(), context.subject(), asking.uid());
        if (claimed.isEmpty()) {
            throw new PasskeyException("passkey.challenge", 400, "The passkey request has expired or was used. Try again.", null);
        }
        // The handle the browser made the passkey for (the engine reports it) must be the one handed out: the
        // passkey answers with it when it signs.
        String handle = text(credential, "userHandle");
        if (handle != null && !handle.isEmpty() && !MessageDigest.isEqual(bytes(claimed.get().userHandle()), bytes(handle))) {
            LOG.warn("passkey.registration_failed form={} detail=the passkey was made for another user handle", context.madeOn());
            throw new PasskeyException("passkey.invalid", 422, failureText("handle"), "handle");
        }
        byte[] credentialId = Base64Url.decode(text(credential, "id"));
        String publicKeyText = text(credential, "publicKey");
        byte[] reported = null;
        if (publicKeyText != null) {
            try {
                reported = Base64.getDecoder().decode(publicKeyText);
            } catch (IllegalArgumentException e) {
                // A reported key that is not base64 is a key reported that is no key (refused at the publicKey
                // check, where a reported key that differs from the authenticator data's is).
                reported = new byte[0];
            }
        }
        WebAuthnVerdict verdict = verifier.verifyRegistration(response, claimed.get().challenge(), settings.origins(), settings.rpId(),
            "required".equals(draft.userVerification()), credentialId, reported);
        if (!verdict.valid() || verdict.credential() == null) {
            LOG.warn("passkey.registration_failed form={} detail={}{}", context.madeOn(), verdict.reason() == null ? "unknown" : verdict.reason(),
                context.madeOn().isEmpty() ? " (" + where + ")" : "");
            throw new PasskeyException("passkey.invalid", 422, failureText(verdict.failed() == null ? "" : verdict.failed()), verdict.failed());
        }
        WebAuthnVerdict.RegisteredCredential made = verdict.credential();
        String id = Base64Url.encode(made.credentialId());
        if (passkeys.find(id).isPresent()) {
            throw new PasskeyException("passkey.exists", 409, "This passkey is registered already.", null);
        }
        // One passkey per key: a real authenticator never makes the same key twice, so a key already here is
        // someone else's, read off a signature.
        PasskeyRecord candidate = PasskeyRecord.builder()
            .owner(context.owner())
            .credentialId(id)
            .label(labelOf(draft.label(), context))
            .formId(context.restrictTo())
            .publicKey(made.spki())
            .algorithm(made.algorithm())
            .transports(transports(response, credential))
            .signCount(verdict.signCount())
            .userVerified(verdict.flags().userVerified())
            .backupEligible(verdict.flags().backupEligible())
            .backedUp(verdict.flags().backedUp())
            .userHandle(claimed.get().userHandle())
            .origin(PasskeyContext.ORIGINS.contains(context.origin()) ? context.origin() : "form")
            .madeOn(context.madeOn())
            .aaguid(made.aaguid())
            .attestation(made.attestationFormat())
            .rpId(settings.rpId())
            .webOrigin(made.origin())
            .browser(browser == null ? "" : browser)
            .created(clock.instant())
            .build();
        if (passkeys.keyRegistered(candidate.publicKeyHash())) {
            LOG.atWarn().addKeyValue("form", context.madeOn()).addKeyValue("key", id)
                .log("passkey.registration_failed form={} key={} detail=its public key is registered already under another credential id",
                context.madeOn(), id);
            throw new PasskeyException("passkey.exists", 409, "This passkey is registered already.", null);
        }
        refuseIfInvalid(context, asking, candidate);
        PasskeyRecord stored;
        try {
            stored = passkeys.create(candidate);
        } catch (DuplicatePasskeyException e) {
            // Two registrations of one credential racing: the unique key refused the second.
            LOG.warn("A passkey for {} could not be stored: {}", where, e.getMessage());
            throw new PasskeyException("passkey.exists", 409, "This passkey is registered already.", null);
        }
        LOG.atInfo().addKeyValue("key", id).log("{} key={} detail={}", "invitation".equals(context.origin()) ? "passkey.invited_registered" : "passkey.registered", id,
            switch (context.origin()) {
                case "account" -> "Account passkey, added ahead of time";
                default -> context.owner().isEmpty() ? "Anonymous passkey" : "Account passkey";
            });
        return stored;
    }

    /** The user handle a new passkey carries: the owner's first passkey's in the scope, else 16 random bytes. */
    private String handleFor(String owner, String formId) {
        if (!owner.isEmpty()) {
            Optional<PasskeyRecord> first = passkeys.firstOf(owner, formId);
            if (first.isPresent() && !first.get().userHandle().isEmpty()) {
                return first.get().userHandle();
            }
        }
        byte[] handle = new byte[16];
        random.nextBytes(handle);
        return Base64Url.encode(handle);
    }

    private static String labelOf(String asked, PasskeyContext context) {
        String cleaned = PasskeyLabels.clean(asked);
        return cleaned != null ? cleaned : context.defaultLabel();
    }

    /** The draft after the application's customizers, in their order; a refusal or a failure propagates as thrown. */
    private RegistrationDraft customized(RegistrationDraft.Step step, PasskeyContext context, PasskeySubject asking, String label) {
        RegistrationDraft draft = new RegistrationDraft(step, context, asking, label, settings.residentKey());
        for (RegistrationCustomizer customizer : customizers) {
            customizer.customize(draft);
        }
        return draft;
    }

    /**
     * The application's validators over the passkey about to be stored: every one, in order; their errors
     * refuse with one {@code INVALID} refusal (422), and nothing is stored.
     */
    private void refuseIfInvalid(PasskeyContext context, PasskeySubject asking, PasskeyRecord candidate) {
        if (validators.isEmpty()) {
            return;
        }
        List<HookProblem> errors = new ArrayList<>();
        for (RegistrationValidator validator : validators) {
            List<HookProblem> found = validator.validate(context, asking, candidate);
            if (found == null) {
                throw new IllegalStateException("A RegistrationValidator answered null; answer an empty list to let the passkey be stored.");
            }
            errors.addAll(found);
        }
        if (!errors.isEmpty()) {
            LOG.atWarn().addKeyValue("form", context.madeOn()).addKeyValue("key", candidate.credentialId())
                .log("passkey.registration_failed form={} key={} detail=refused by the application ({})", context.madeOn(),
                candidate.credentialId(), errors.get(0).code());
            throw HookRefusedException.invalid(errors);
        }
    }

    /** The transports the browser reported (the response's, else the credential's), at most 8 words of [a-z-]. */
    private static List<String> transports(JsonNode response, JsonNode credential) {
        JsonNode reported = response.get("transports") != null && response.get("transports").isArray() ? response.get("transports")
            : credential.get("transports") != null && credential.get("transports").isArray() ? credential.get("transports") : null;
        List<String> transports = new ArrayList<>();
        if (reported != null) {
            for (JsonNode transport : reported) {
                if (transport.isString() && TRANSPORT.matcher(transport.asString()).matches() && transports.size() < 8) {
                    transports.add(transport.asString());
                }
            }
        }
        return transports;
    }

    /** Words for a refused registration, by the check that failed. */
    static String failureText(String check) {
        return switch (check) {
            case "origin", "rpId" -> "Passkeys are not set up for this address of the site. Contact us.";
            case "userVerified" -> "This form needs your device to check it is you (fingerprint, face or PIN) when you make a passkey. Try again, and allow the check.";
            default -> "The passkey could not be verified. Try again.";
        };
    }

    private static String text(JsonNode node, String name) {
        JsonNode member = node == null || !node.isObject() ? null : node.get(name);
        return member != null && member.isString() ? member.asString() : null;
    }

    private static byte[] bytes(String text) {
        return text.getBytes(java.nio.charset.StandardCharsets.UTF_8);
    }
}
