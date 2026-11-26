package com.argusvane.datum.webauthn.web;

import com.argusvane.datum.core.CountedAddress;
import com.argusvane.datum.core.DatumEventPublisher;
import com.argusvane.datum.web.error.BadRequestException;
import com.argusvane.datum.web.json.DatumJsonMapper;
import com.argusvane.datum.web.json.JsonBodies;
import com.argusvane.datum.forms.FormKeys;
import com.argusvane.datum.webauthn.FormSigning;
import com.argusvane.datum.webauthn.FormSigningSource;
import com.argusvane.datum.webauthn.PasskeyChallenges;
import com.argusvane.datum.webauthn.PasskeyContext;
import com.argusvane.datum.webauthn.PasskeyException;
import com.argusvane.datum.webauthn.PasskeyRecord;
import com.argusvane.datum.webauthn.PasskeyRepository;
import com.argusvane.datum.webauthn.PasskeySubject;
import com.argusvane.datum.webauthn.PasskeySubjectResolver;
import com.argusvane.datum.webauthn.PasskeyUseStore;
import com.argusvane.datum.webauthn.RegistrationCeremony;
import com.argusvane.datum.webauthn.RegistrationOptions;
import com.argusvane.datum.webauthn.WebAuthnSettings;
import com.argusvane.datum.webauthn.WebAuthnVerdict;
import com.argusvane.datum.webauthn.WebAuthnVerifier;
import com.argusvane.datum.webauthn.events.PasskeyRegisteredEvent;
import com.argusvane.datum.webauthn.events.PasskeyRevokedEvent;
import java.security.MessageDigest;
import java.security.Principal;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.function.Predicate;
import com.fasterxml.jackson.annotation.JsonInclude;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The passkey endpoints, written once for both web stacks (the MVC and WebFlux
 * classes only move bytes; a binding for another web stack would reuse this class): endpoint catalog {@code passkeyChallenge},
 * {@code passkeyRegister}, {@code listPasskeys}, {@code removePasskey}, {@code passkeyCheckChallenge},
 * {@code passkeyCheck}, with the form named in the body instead of the route ({@code {context, form?}}).
 *
 * <p>The adapters read the body with the stack's reader ({@code MvcBodies}/{@code WebFluxBodies}: 415, then the
 * 64 KiB cap counted on the raw stream) and hand the bytes here. Every method blocks (the stores are JDBC), so
 * the WebFlux adapter calls them on the elastic scheduler. Failures are Datum exceptions the error mapper
 * answers.
 *
 * <p>Before the body is read, the routes the throttle counts ({@link #challenge}, {@link #register},
 * {@link #checkChallenge}) are admitted: 415, then the address limit ({@link #admit}, 429 {@code flood}), so a body that
 * never parses is counted too.
 *
 * <p>Order inside an endpoint, as datum-forms' read endpoints: the body reads (415, 413, 400), then the
 * parameter checks (400), existence and signing off (404), passkeys not set up (503), the person's right to make a
 * passkey here (403 {@code signing.sign_in}, {@code signing.context}, {@code signing.register_off}), the throttle
 * (429 {@code flood}), then the work.
 *
 * <p>Who may reach these routes at all is the application's security in front of them (framework-first;
 * on Spring {@code DatumRequestMatchers.passkeys()}): the facade asks no access policy. What stays Datum's is the
 * passkey's own rules: the registration's {@code context} is {@code submit} or {@code amend} (anyone the route
 * admits; the Spring host has no separate amend access) or {@code test}, which only the people
 * {@link Options#testers()} names may use. The Test context is the one
 * way to make a passkey at a form while {@code register-at-submit} is off, so it stays closed unless the
 * application names its testers; any other context is {@code signing.context}. With no {@code form} the passkey is
 * made ahead of time on a signed-in person's account and signs any form.
 *
 * <p>A passkey in a path is named by its credential id (base64url, safe in a path), never by the database id:
 * that is what every list answers as {@code id}, and what the engine and the page already hold.
 */
public final class PasskeysApi {

    private static final Logger LOG = LoggerFactory.getLogger("datum.webauthn");
    private static final Map<String, String> NO_STORE = Map.of("Cache-Control", "no-store");
    private static final String READ_FAILED = "The passkey could not be read.";

    private static final int PURGE_BATCH = 50;

    /** The largest body accepted, in bytes: 64 KiB, far past a registration response (a few KB). */
    public static final long MAX_BODY = 65536;

    /**
     * What the facade needs of configuration.
     *
     * @param registerAtSubmit whether people may make passkeys at a form (the Test context still may)
     * @param labelPath the answer (value path) that names a visitor's passkey, told to the page; "" for none
     * @param testers who may make a passkey in the Test context, asked
     *     with the request's principal (null when anonymous); nobody when null. On Spring the binding answers it
     *     from {@code datum.webauthn.test-roles} against the Spring Security authentication.
     */
    public record Options(boolean registerAtSubmit, String labelPath, Predicate<Principal> testers) {

        /** Nobody may use the Test context. */
        public static final Predicate<Principal> NOBODY = principal -> false;

        public Options {
            labelPath = labelPath == null ? "" : labelPath;
            testers = testers == null ? NOBODY : testers;
        }

        /** Options with nobody allowed the Test context. */
        public Options(boolean registerAtSubmit, String labelPath) {
            this(registerAtSubmit, labelPath, NOBODY);
        }
    }

    private final WebAuthnSettings settings;
    private final Options options;
    private final RegistrationCeremony ceremony;
    private final PasskeyChallenges challenges;
    private final PasskeyRepository passkeys;
    private final PasskeyUseStore uses;
    private final WebAuthnVerifier verifier;
    private final FormSigningSource forms;
    private final PasskeySubjectResolver subjects;
    private final PasskeyThrottle throttle;
    private final DatumJsonMapper json;
    private final DatumEventPublisher events;
    private final Clock clock;

    public PasskeysApi(WebAuthnSettings settings, Options options, RegistrationCeremony ceremony, PasskeyChallenges challenges,
                       PasskeyRepository passkeys, PasskeyUseStore uses, WebAuthnVerifier verifier, FormSigningSource forms,
                       PasskeySubjectResolver subjects, PasskeyThrottle throttle,
                       DatumJsonMapper json, DatumEventPublisher events, Clock clock) {
        this.settings = Objects.requireNonNull(settings, "settings");
        this.options = Objects.requireNonNull(options, "options");
        this.ceremony = Objects.requireNonNull(ceremony, "ceremony");
        this.challenges = Objects.requireNonNull(challenges, "challenges");
        this.passkeys = Objects.requireNonNull(passkeys, "passkeys");
        this.uses = Objects.requireNonNull(uses, "uses");
        this.verifier = Objects.requireNonNull(verifier, "verifier");
        this.forms = Objects.requireNonNull(forms, "forms");
        this.subjects = Objects.requireNonNull(subjects, "subjects");
        this.throttle = throttle == null ? PasskeyThrottle.NONE : throttle;
        this.json = Objects.requireNonNull(json, "json");
        // As given: the passkey is stored (or removed) before its event; through the host's guarded default a
        // listener never changes the answer, and an application's own publisher that throws reaches the caller.
        this.events = events == null ? DatumEventPublisher.noop() : events;
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    /** The cap an adapter reads a body under. */
    public long maxBodyBytes() {
        return MAX_BODY;
    }

    /** The media type every body is written with. */
    public static String contentType() {
        return "application/json";
    }

    // ------------------------------------------------------------------------------------------------ the address limit

    /**
     * What an adapter asks before it reads the body of {@link #challenge} or {@link #register}: 415 for a body that is
     * not JSON by its Content-Type, then the address limit ({@link PasskeyThrottle#checkAddress}: 429 {@code flood} with
     * {@code Retry-After}, the answer of the per-form throttle further on). The per-form count needs the form named in the
     * body, so it runs after the parse; this one counts every request first, whether or not its body parses.
     */
    public void admit(PasskeysRequest request) {
        JsonBodies.requireJson(request.contentType());
        admitAddress(request);
    }

    /** The address limit alone, for a counted route with no body ({@link #checkChallenge} asks it first). */
    private void admitAddress(PasskeysRequest request) {
        String address = request.remoteAddress();
        if (address == null || address.isEmpty()) {
            return;
        }
        if (throttle.checkAddress(CountedAddress.of(address)) instanceof PasskeyThrottle.Decision.Deny deny) {
            throw new PasskeyThrottledException(deny.retryAfter());
        }
    }

    // ------------------------------------------------------------------------------------------------ the ceremony

    /** {@code POST /challenge}: a registration challenge, signed and single-use (200). */
    public PasskeysReply challenge(byte[] body, PasskeysRequest request) {
        ObjectNode posted = object(body, request);
        Admitted admitted = admit(posted, request);
        RegistrationOptions made = ceremony.challenge(admitted.context(), admitted.subject(), text(posted, "label"));
        // RegistrationOptions lists its members in wire order (the engine reads these names), so Jackson writes it as is.
        return reply(200, made);
    }

    /** {@code POST /register}: verifies and stores a passkey the browser created (201 {@code {id, label, createdAt, ...}}). */
    public PasskeysReply register(byte[] body, PasskeysRequest request) {
        ObjectNode posted = object(body, request);
        Admitted admitted = admit(posted, request);
        PasskeyRecord stored = ceremony.register(admitted.context(), admitted.subject(), posted, PasskeyBrowser.summary(request.header("User-Agent")));
        publish(new PasskeyRegisteredEvent(stored.credentialId(), stored.owner(), stored.madeOn(), stored.origin(), clock.instant()));
        if (stored.owner().isEmpty()) {
            purgeAnonymous();
        }
        return reply(201, new Registered(stored.credentialId(), stored.transports(), stored.algorithm(), publicKey(stored),
            stored.label(), stored.created().toString()));
    }

    // ------------------------------------------------------------------------------------------------ the person's passkeys

    /**
     * {@code GET /passkeys[?form=]}: the caller's passkeys. With a form: the ones the page offers the browser
     * ({@code {id, transports, algorithm, publicKey}}) and a {@code signing} block of what the page needs (mode,
     * scope, placement, statement, relying party). Without: the caller's list for a "my passkeys" page. An
     * anonymous caller has none.
     */
    public PasskeysReply mine(String form, PasskeysRequest request) {
        PasskeySubject subject = subjects.resolve(request.principal());
        if (form != null) {
            // Passkeys not set up is not an error here: the page reads the real mode and the unavailable
            // policy from the block (ready:false) and decides itself, so an optional form
            // keeps sending. The 503 stays on the endpoints that would make or check a passkey.
            FormSigning signing = formFor(form, request, false);
            List<Reference> offered = new ArrayList<>();
            if (!subject.isAnonymous()) {
                // The passkeys that may sign here: those that sign any form and, when passkeys are per form, this form's.
                for (PasskeyRecord passkey : passkeys.ownActive(subject.uid(), settings.perForm() ? form : null)) {
                    offered.add(reference(passkey));
                }
            }
            return reply(200, new ForForm(offered, signingBlock(signing, subject)));
        }
        List<Listed> own = new ArrayList<>();
        if (!subject.isAnonymous()) {
            for (PasskeyRecord passkey : passkeys.ofOwner(subject.uid())) {
                own.add(new Listed(passkey.credentialId(), passkey.transports(), passkey.algorithm(), publicKey(passkey),
                    passkey.label(), passkey.formId(), passkey.origin(), passkey.browser(), passkey.created().toString(),
                    passkey.lastUsed() == null ? null : passkey.lastUsed().toString(), passkey.isRevoked()));
            }
        }
        return reply(200, new Mine(own));
    }

    /**
     * {@code DELETE /passkeys/{id}}: the owner removes a passkey. It is revoked first, so it signs nothing new;
     * then it is deleted, or, when a stored submission names it, kept with its label cleared so what it signed
     * can be checked again.
     *
     * <p>Only the owner. An administrator's revoke is the application's own
     * tooling over {@code PasskeyRepository}, because a route rule is not a safe stand-in for "may remove other
     * people's passkeys": a passkey removed by someone else costs its owner every submission they could have signed.
     */
    public PasskeysReply revoke(String credentialId, PasskeysRequest request) {
        PasskeySubject subject = subjects.resolve(request.principal());
        // A passkey that is not yours is "not found", as one that does not exist.
        PasskeyRecord passkey = ownPasskey(subject, credentialId);
        Instant now = clock.instant();
        passkeys.revoke(passkey.id(), subject.uid(), now);
        boolean deleted = uses.signedCount(passkey.id()) == 0 && passkeys.delete(passkey.id());
        if (!deleted) {
            passkeys.markRemoved(passkey.id(), now);
        }
        publish(new PasskeyRevokedEvent(passkey.credentialId(), passkey.owner(), subject.uid(), deleted, now));
        return reply(200, new Revoked(passkey.credentialId(), deleted ? "deleted" : "removed"));
    }

    /** {@code POST /passkeys/{id}/check-challenge}: a challenge to test one of the caller's passkeys with. */
    public PasskeysReply checkChallenge(String credentialId, PasskeysRequest request) {
        // No body: the address limit is the first thing asked, as on the routes that have one.
        admitAddress(request);
        PasskeySubject subject = subjects.resolve(request.principal());
        PasskeyRecord passkey = ownPasskey(subject, credentialId);
        requireReady();
        if (passkey.isRevoked()) {
            throw revokedRefusal();
        }
        throttled(request, null, subject);
        PasskeyChallenges.IssuedChallenge issued = challenges.issue("check", "passkey:" + passkey.id(), subject.uid(), passkey.credentialId());
        return reply(200, new CheckChallenge(issued.challenge(), issued.token(), issued.expires(), settings.rpId(),
            List.of(new Allowed(passkey.credentialId(), passkey.transports())), "preferred"));
    }

    /**
     * {@code POST /passkeys/{id}/check}: checks the assertion a test made. 200 {@code {ok, lastUsed}} when it
     * verifies with the passkey's key (when it was last used moves, and the counter when it went up); 422
     * {@code passkey.check} when it does not; 422 {@code passkey.counter} when its counter did not go up (the
     * passkey may have been copied).
     */
    public PasskeysReply check(String credentialId, byte[] body, PasskeysRequest request) {
        PasskeySubject subject = subjects.resolve(request.principal());
        PasskeyRecord passkey = ownPasskey(subject, credentialId);
        requireReady();
        ObjectNode posted = object(body, request);
        JsonNode token = posted.get("token");
        JsonNode assertion = posted.get("assertion");
        if (token == null || !token.isString() || assertion == null || !assertion.isObject()) {
            throw new PasskeyException("passkey.bad_request", 400, READ_FAILED, null);
        }
        Optional<PasskeyChallenges.ClaimedChallenge> claimed = challenges.claim(token.asString(), "check", "passkey:" + passkey.id(), subject.uid());
        if (claimed.isEmpty() || !MessageDigest.isEqual(bytes(passkey.credentialId()), bytes(claimed.get().userHandle()))) {
            throw new PasskeyException("passkey.challenge", 400, "The passkey request has expired or was used. Try again.", null);
        }
        String named = text(assertion, "credentialId");
        if (!named.isEmpty() && !MessageDigest.isEqual(bytes(passkey.credentialId()), bytes(named))) {
            throw new SigningRefusedException("passkey.check", 422, "Your device answered with another passkey. Choose this one when it asks.");
        }
        PasskeyRecord fresh = passkeys.findById(passkey.id()).orElse(passkey);
        if (fresh.isRevoked()) {
            throw revokedRefusal();
        }
        WebAuthnVerdict verdict = verifier.verifyAssertion(assertion, claimed.get().challenge(), settings.origins(), settings.rpId(),
            fresh.publicKey(), fresh.algorithm(), false);
        if (!verdict.valid()) {
            LOG.atInfo().addKeyValue("key", fresh.credentialId())
                .log("passkey.check_failed key={} detail={}", fresh.credentialId(), verdict.reason() == null ? "unknown" : verdict.reason());
            throw new SigningRefusedException("passkey.check", 422,
                "The test did not verify: this passkey may not be on this device. Try again, or choose it when your device asks.");
        }
        long count = verdict.signCount();
        long stored = fresh.signCount();
        if ((count > 0 || stored > 0) && count <= stored) {
            LOG.atInfo().addKeyValue("key", fresh.credentialId())
                .log("passkey.check_failed key={} detail=the signature counter did not go up: the passkey may have been copied", fresh.credentialId());
            throw new SigningRefusedException("passkey.counter", 422,
                "Your passkey reported a signature count that did not go up, which happens when a passkey is copied. Contact us.");
        }
        Instant now = clock.instant();
        passkeys.touch(fresh.id(), Math.max(count, stored), now);
        LOG.atInfo().addKeyValue("key", fresh.credentialId()).log("passkey.checked key={} detail=Tested by its owner: the device holds it", fresh.credentialId());
        return reply(200, new Checked(true, now.getEpochSecond()));
    }

    // ------------------------------------------------------------------------------------------------ admission

    /**
     * Clears a batch of the rows an anonymous visitor leaves behind once their grace has passed. A binding with a
     * scheduler (the Spring binding, when the application has a {@code TaskScheduler}) calls
     * it on a timer, and every registration by an anonymous visitor calls it too, so a host with no scheduler still
     * clears them. Best effort: a failure here must not fail the registration that is already stored.
     */
    public void purgeAnonymous() {
        try {
            passkeys.purgeAnonymous(clock.instant().minus(settings.anonymousGrace()), PURGE_BATCH);
        } catch (RuntimeException e) {
            LOG.warn("Anonymous passkeys could not be purged: {}", e.toString());
        }
    }

    /** The caller, the context and the form's signing settings of a challenge or a registration. */
    private record Admitted(PasskeyContext context, PasskeySubject subject, FormSigning signing) {
    }

    private Admitted admit(ObjectNode posted, PasskeysRequest request) {
        PasskeySubject subject = subjects.resolve(request.principal());
        JsonNode formNode = posted.get("form");
        if (formNode != null && !formNode.isNull() && !formNode.isString()) {
            throw new PasskeyException("passkey.bad_request", 400, READ_FAILED, null);
        }
        String form = formNode == null || formNode.isNull() ? null : formNode.asString();
        JsonNode contextNode = posted.get("context");
        if (contextNode != null && !contextNode.isNull() && !contextNode.isString()) {
            throw new PasskeyException("passkey.bad_request", 400, READ_FAILED, null);
        }
        String named = contextNode == null || contextNode.isNull() ? (form == null ? "account" : "submit") : contextNode.asString();
        if (form == null) {
            return admitAccount(named, subject, request);
        }
        FormSigning signing = formFor(form, request, true);
        if (!settings.maySign(subject)) {
            throw new SigningRefusedException("signing.sign_in", 403,
                "Sign in to make a passkey: only people who are signed in can sign on this site.");
        }
        // Who may reach the route is the application's security; the context is Datum's: submit and
        // amend for anyone it admits, test only for the testers the application named, nothing else.
        boolean allowed = switch (named) {
            case "submit", "amend" -> true;
            case "test" -> isTester(request.principal());
            default -> false;
        };
        if (!allowed) {
            throw new SigningRefusedException("signing.context", 403, "A passkey cannot be made here.");
        }
        if (!named.equals("test") && !options.registerAtSubmit()) {
            throw new SigningRefusedException("signing.register_off", 403,
                "This site does not make passkeys at its forms: sign with a passkey registered with this site ahead of time.");
        }
        throttled(request, form, subject);
        String label = subject.isAnonymous() ? siteName() + " signer" : "Passkey for " + siteName();
        return new Admitted(PasskeyContext.forForm(form, subject, named, settings.perForm(), signing, label), subject, signing);
    }

    /** A passkey made ahead of time on a signed-in person's account ({@code context: "account"}). */
    private Admitted admitAccount(String named, PasskeySubject subject, PasskeysRequest request) {
        if (!named.equals("account")) {
            throw new PasskeyException("passkey.bad_request", 400, READ_FAILED, null);
        }
        if (subject.isAnonymous()) {
            throw new SigningRefusedException("signing.sign_in", 403,
                "Sign in to make a passkey: only people who are signed in can sign on this site.");
        }
        requireReady();
        throttled(request, null, subject);
        return new Admitted(PasskeyContext.forAccount(subject, "Passkey for " + siteName()), subject, FormSigning.OFF);
    }

    /**
     * The form's signing settings after the checks every form endpoint makes: a valid key (404), signing on for the
     * form (404 {@code signing.off}), passkeys set up (503, unless the caller only reads the form's settings).
     */
    private FormSigning formFor(String form, PasskeysRequest request, boolean mustBeReady) {
        if (!FormKeys.isValid(form)) {
            // Fixed words: a key that is not one never reaches a repository, and is never echoed.
            throw new SigningRefusedException("form.notFound", 404, "There is no such form.");
        }
        FormSigning signing = forms.forForm(form);
        if (signing == null || signing.mode() == FormSigning.Mode.OFF) {
            throw new SigningRefusedException("signing.off", 404, "This form is not signed.");
        }
        if (mustBeReady) {
            requireReady();
        }
        return signing;
    }

    /** Whether the application named this caller a tester; a predicate that throws names nobody (fail closed). */
    private boolean isTester(Principal principal) {
        try {
            return options.testers().test(principal);
        } catch (RuntimeException e) {
            LOG.warn("The passkey testers' check failed, so the Test context is refused: {}", e.toString());
            return false;
        }
    }

    private void requireReady() {
        if (!settings.ready()) {
            throw new SigningRefusedException("signing.not_set_up", 503, "Passkeys are not set up on this site.");
        }
    }

    private void throttled(PasskeysRequest request, String form, PasskeySubject subject) {
        String principal = request.principal() == null ? null : request.principal().getName();
        // Counted as the submission routes count an address: an IPv6 client by its /64.
        PasskeyThrottle.Decision decision = throttle.check(CountedAddress.of(request.remoteAddress()), form, subject.isAnonymous() ? null : principal);
        if (decision instanceof PasskeyThrottle.Decision.Deny deny) {
            throw new PasskeyThrottledException(deny.retryAfter());
        }
    }

    private PasskeyRecord ownPasskey(PasskeySubject subject, String credentialId) {
        return passkeys.find(credentialId).filter(found -> !found.isRemoved() && owns(subject, found)).orElseThrow(PasskeysApi::notFound);
    }

    private static boolean owns(PasskeySubject subject, PasskeyRecord passkey) {
        return !subject.isAnonymous() && !passkey.owner().isEmpty() && passkey.owner().equals(subject.uid());
    }

    private static SigningRefusedException notFound() {
        return new SigningRefusedException("passkey.notFound", 404, "There is no such passkey.");
    }

    private static SigningRefusedException revokedRefusal() {
        return new SigningRefusedException("passkey.revoked", 409, "This passkey was revoked: it signs nothing on this site.");
    }

    private String siteName() {
        return settings.rpName().isEmpty() ? settings.rpId() : settings.rpName();
    }

    // ------------------------------------------------------------------------------------------------ wire shapes

    private ObjectNode object(byte[] body, PasskeysRequest request) {
        JsonBodies.requireJson(request.contentType());
        if (body.length > MAX_BODY) {
            throw JsonBodies.tooLarge(MAX_BODY);
        }
        JsonNode parsed = JsonBodies.parse(json, body);
        if (!(parsed instanceof ObjectNode object)) {
            throw new BadRequestException("passkey.bad_request", READ_FAILED);
        }
        return object;
    }

    // The answers are records whose members are in wire order, written by Jackson's data binding. A record that
    // never holds a null member needs no inclusion rule; the two optional members say theirs.

    /** A passkey the page offers the browser (endpoint catalog {@code listPasskeys} with a form): {id, transports, algorithm, publicKey}. */
    private record Reference(String id, List<String> transports, int algorithm, String publicKey) {
    }

    /** {@code POST /register}: the reference plus what the person sees. */
    private record Registered(String id, List<String> transports, int algorithm, String publicKey, String label, String createdAt) {
    }

    /** One entry of the caller's own list. {@code lastUsed} is written as null when never used. */
    private record Listed(String id, List<String> transports, int algorithm, String publicKey, String label, String formId,
                          String origin, String browser, String createdAt, String lastUsed, boolean revoked) {
    }

    private record Mine(List<Listed> passkeys) {
    }

    private record ForForm(List<Reference> passkeys, SigningBlock signing) {
    }

    private record Revoked(String id, String status) {
    }

    private record Allowed(String id, List<String> transports) {
    }

    private record CheckChallenge(String challenge, String token, long expires, String rpId, List<Allowed> allowCredentials,
                                  String userVerification) {
    }

    private record Checked(boolean ok, long lastUsed) {
    }

    /** What the page needs to sign a form: the challenge answer's signing block, which the page glue reads. */
    private record SigningBlock(String mode, String scope, String placement, String userVerification,
                                @JsonInclude(JsonInclude.Include.NON_EMPTY) String statement, String unavailable, String rpId,
                                boolean ready, boolean register, boolean signIn, boolean signedIn,
                                @JsonInclude(JsonInclude.Include.NON_EMPTY) String labelPath) {
    }

    private Reference reference(PasskeyRecord passkey) {
        return new Reference(passkey.credentialId(), passkey.transports(), passkey.algorithm(), publicKey(passkey));
    }

    private static String publicKey(PasskeyRecord passkey) {
        return Base64.getEncoder().encodeToString(passkey.publicKey());
    }

    private SigningBlock signingBlock(FormSigning signing, PasskeySubject subject) {
        return new SigningBlock(signing.mode().name().toLowerCase(java.util.Locale.ROOT), signing.scope(), signing.placement(),
            signing.userVerification(), signing.statement(), signing.unavailable(), settings.rpId(), settings.ready(),
            options.registerAtSubmit(), !settings.maySign(subject), !subject.isAnonymous(), options.labelPath());
    }

    private PasskeysReply reply(int status, Object body) {
        return new PasskeysReply(status, NO_STORE, json.mapper().writeValueAsBytes(body));
    }

    /** Through the publisher as given: the host's guarded default logs a listener's failure (the passkey is stored or removed already). */
    private void publish(Object event) {
        events.publish(event);
    }

    private static String text(JsonNode node, String name) {
        JsonNode member = node == null ? null : node.get(name);
        return member != null && member.isString() ? member.asString() : "";
    }

    private static byte[] bytes(String text) {
        return text.getBytes(java.nio.charset.StandardCharsets.UTF_8);
    }
}
