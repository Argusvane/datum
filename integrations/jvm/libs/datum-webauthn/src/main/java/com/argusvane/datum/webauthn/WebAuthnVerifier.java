package com.argusvane.datum.webauthn;

import com.webauthn4j.WebAuthnManager;
import com.webauthn4j.converter.AttestationObjectConverter;
import com.webauthn4j.converter.util.ObjectConverter;
import com.webauthn4j.credential.CredentialRecord;
import com.webauthn4j.credential.CredentialRecordImpl;
import com.webauthn4j.data.AuthenticationData;
import com.webauthn4j.data.AuthenticationParameters;
import com.webauthn4j.data.AuthenticationRequest;
import com.webauthn4j.data.PublicKeyCredentialParameters;
import com.webauthn4j.data.PublicKeyCredentialType;
import com.webauthn4j.data.RegistrationData;
import com.webauthn4j.data.RegistrationParameters;
import com.webauthn4j.data.RegistrationRequest;
import com.webauthn4j.data.attestation.authenticator.AAGUID;
import com.webauthn4j.data.attestation.authenticator.AttestedCredentialData;
import com.webauthn4j.data.attestation.authenticator.COSEKey;
import com.webauthn4j.data.attestation.statement.COSEAlgorithmIdentifier;
import com.webauthn4j.data.attestation.statement.NoneAttestationStatement;
import com.webauthn4j.data.client.Origin;
import com.webauthn4j.data.client.challenge.DefaultChallenge;
import com.webauthn4j.server.ServerProperty;
import com.webauthn4j.verifier.exception.BadChallengeException;
import com.webauthn4j.verifier.exception.BadOriginException;
import com.webauthn4j.verifier.exception.BadRpIdException;
import com.webauthn4j.verifier.exception.BadSignatureException;
import com.webauthn4j.verifier.exception.BadTopOriginException;
import com.webauthn4j.verifier.exception.CredentialIdTooLongException;
import com.webauthn4j.verifier.exception.CrossOriginException;
import com.webauthn4j.verifier.exception.InconsistentClientDataTypeException;
import com.webauthn4j.verifier.exception.MissingChallengeException;
import com.webauthn4j.verifier.exception.NotAllowedAlgorithmException;
import com.webauthn4j.verifier.exception.UserNotPresentException;
import com.webauthn4j.verifier.exception.UserNotVerifiedException;
import com.webauthn4j.verifier.exception.VerificationException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.util.Collections;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;
import tools.jackson.core.StreamReadConstraints;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * The relying party's verdict on WebAuthn ceremonies: webauthn4j parses and verifies, and this class holds the site's policy around it.
 *
 * <p>Before the library reads a byte, the response must be readable: its members text and base64url, the client data
 * strict JSON (eight levels at most, nothing after the value) with text type, challenge and origin, the authenticator
 * data laid out as WebAuthn 6.1 says (37 bytes and more; with the AT flag a credential id of 1 to 1023 bytes and a COSE
 * key; with ED an extensions map; nothing after), and every CBOR item through {@link CborGate}. Then webauthn4j's
 * non-strict manager (attestation formats without trust anchors: attestation is "none", who made the authenticator is
 * recorded, never judged) parses the bytes and checks, in its order, the ceremony type, the challenge, the origin on the
 * allow-list, the relying-party id hash, user presence, user verification when required, then for an assertion the
 * signature with the STORED key (built from the stored SPKI and algorithm, in a fresh credential record with counter 0:
 * the counter rule is {@link SubmissionSignatureVerifier}'s, after its replay check) and for a registration the
 * algorithm among ES256 and RS256. The library is never given a topOrigin, so it refuses {@code crossOrigin: true} (a
 * page framed by another site writes it) and any {@code topOrigin}; this class refuses {@code crossOrigin: true} again
 * on its own reading, the origin unless it is exactly one of the configured texts (the library normalises origins
 * before it compares them; a refusal of the library's after its origin check is named {@code origin} for such a
 * response), and the challenge text unless it is exactly the base64url this site handed out. For a
 * registration this class then holds the credential to its own rules: the credential id the browser reported is the
 * authenticator data's, the COSE key is one {@link CoseKey#fromCose} takes (P-256 on the curve, RSA of 2048 bits and
 * more), and the SPKI the browser reported ({@code getPublicKey()}) is that key's.
 *
 * <p>The verdict names the first check that failed, with its English reason: {@code readable}, {@code type},
 * {@code challenge}, {@code origin}, {@code rpId}, {@code userPresent}, {@code userVerified}, then {@code signature}
 * (an assertion) or {@code attestedCredential}, {@code credentialId}, {@code publicKey} (a registration), and
 * {@value #LIBRARY_CHECK} for a rule of the library's this site has no name for (a backup state without backup
 * eligibility, an attestation statement under "none", token binding, extensions); webauthn4j's exceptions are mapped to
 * these names ({@link #checkOf}), the wire's codes and words read them ({@link RegistrationCeremony}, the signature
 * seam). The library stops at the first failure, so the checks map says which checks passed: {@code true} for a check
 * that ran and passed, {@code false} for the one that failed and for every one not reached.
 *
 * <p>Nothing here throws for a failed check. Bytes are base64url in and out, as WebAuthn's JSON spells them; a member of
 * another type than text is unreadable, never an error. Thread-safe.
 */
public final class WebAuthnVerifier {

    /** The check a rule of the library's that this site has no name for fails under. */
    public static final String LIBRARY_CHECK = "library";

    /** The checks' failures, worded (English, for logs and the record). */
    public static final Map<String, String> REASONS = reasons();

    private static final List<String> ASSERTION_CHECKS = List.of("readable", "type", "challenge", "origin", "rpId", "userPresent",
        "userVerified", "signature", LIBRARY_CHECK);

    private static final List<String> REGISTRATION_CHECKS = List.of("readable", "type", "challenge", "origin", "rpId", "userPresent",
        "userVerified", "attestedCredential", "credentialId", "publicKey", LIBRARY_CHECK);

    /** The checks webauthn4j makes that have a name here, in the order it makes them. */
    private static final List<String> LIBRARY_ORDER = List.of("type", "challenge", "origin", "rpId", "userPresent", "userVerified", "signature");

    private static final Pattern FORMAT = Pattern.compile("[A-Za-z0-9._-]{1,32}");

    private static final List<PublicKeyCredentialParameters> ALGORITHMS = List.of(
        new PublicKeyCredentialParameters(PublicKeyCredentialType.PUBLIC_KEY, COSEAlgorithmIdentifier.ES256),
        new PublicKeyCredentialParameters(PublicKeyCredentialType.PUBLIC_KEY, COSEAlgorithmIdentifier.RS256));

    // Client data is read strictly: eight levels at most (it is a flat object), nothing after the value.
    private static final JsonMapper CLIENT_DATA = JsonMapper.builder(JsonFactory.builder()
            .streamReadConstraints(StreamReadConstraints.builder().maxNestingDepth(8).build())
            .build())
        .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
        .build();

    /** webauthn4j's readers and writers (its own Jackson mappers, never the application's). */
    private static final ObjectConverter OBJECTS = new ObjectConverter();

    private final WebAuthnManager manager;
    private final AttestationObjectConverter attestationObjects = new AttestationObjectConverter(OBJECTS);

    /** A verifier over webauthn4j's non-strict manager (attestation formats without trust anchors). */
    public WebAuthnVerifier() {
        this(WebAuthnManager.createNonStrictWebAuthnManager(OBJECTS));
    }

    /** A verifier over the given manager; for tests. */
    public WebAuthnVerifier(WebAuthnManager manager) {
        this.manager = manager;
    }

    private static Map<String, String> reasons() {
        Map<String, String> reasons = new LinkedHashMap<>();
        reasons.put("readable", "the WebAuthn response could not be read");
        reasons.put("type", "the client data is not of the expected ceremony type");
        reasons.put("challenge", "the challenge is not the one expected");
        reasons.put("origin", "the origin is not one this site accepts");
        reasons.put("rpId", "the relying party id hash does not match this site");
        reasons.put("userPresent", "the authenticator reports no user presence");
        reasons.put("userVerified", "user verification was required and not performed");
        reasons.put("attestedCredential", "the authenticator data carries no attested credential");
        reasons.put("credentialId", "the credential id is not the one the authenticator data names");
        reasons.put("publicKey", "the public key is not one this site takes, or not the one the authenticator data holds");
        reasons.put("signature", "the signature does not verify with the registered public key");
        reasons.put(LIBRARY_CHECK, "the WebAuthn library refused the response");
        return Collections.unmodifiableMap(reasons);
    }

    /**
     * The check a webauthn4j refusal is named under here: the ceremony type, the challenge, the origin (a cross-origin
     * response and a topOrigin included), the relying-party id, user presence and verification, the signature, the
     * algorithm (a registration's key) and the credential id's length; any other is {@value #LIBRARY_CHECK}.
     */
    static String checkOf(VerificationException refusal) {
        if (refusal instanceof InconsistentClientDataTypeException) {
            return "type";
        }
        if (refusal instanceof BadChallengeException || refusal instanceof MissingChallengeException) {
            return "challenge";
        }
        if (refusal instanceof BadOriginException || refusal instanceof BadTopOriginException || refusal instanceof CrossOriginException) {
            return "origin";
        }
        if (refusal instanceof BadRpIdException) {
            return "rpId";
        }
        if (refusal instanceof UserNotPresentException) {
            return "userPresent";
        }
        if (refusal instanceof UserNotVerifiedException) {
            return "userVerified";
        }
        if (refusal instanceof BadSignatureException) {
            return "signature";
        }
        if (refusal instanceof NotAllowedAlgorithmException) {
            return "publicKey";
        }
        if (refusal instanceof CredentialIdTooLongException) {
            return "credentialId";
        }
        return LIBRARY_CHECK;
    }

    /**
     * Verifies an assertion (a signature made with a registered passkey).
     *
     * @param assertion clientDataJSON, authenticatorData and signature, base64url (and credentialId, which the library
     *     carries; the passkey was already chosen by it)
     * @param expectedChallenge the raw bytes the challenge must be: for a signed submission, SHA-256 of the
     *     signed text
     * @param origins the origins the client may have written
     * @param rpId the relying party id
     * @param spki the registered public key, SPKI DER
     * @param algorithm its COSE algorithm, the one stored with it
     * @param requireUserVerification whether the UV flag must be set
     */
    public WebAuthnVerdict verifyAssertion(JsonNode assertion, byte[] expectedChallenge, List<String> origins, String rpId,
                                           byte[] spki, int algorithm, boolean requireUserVerification) {
        Checks checks = new Checks(ASSERTION_CHECKS);
        byte[] clientJson = Base64Url.decode(text(assertion, "clientDataJSON"));
        byte[] authData = Base64Url.decode(text(assertion, "authenticatorData"));
        byte[] signature = Base64Url.decode(text(assertion, "signature"));
        ClientData clientData = clientJson != null ? clientData(clientJson) : null;
        if (clientData == null || authData == null || !laidOut(authData) || signature == null || signature.length == 0) {
            return checks.verdict(null, null);
        }
        byte[] credentialId = Base64Url.decode(text(assertion, "credentialId"));
        AuthenticationData data;
        try {
            data = manager.parse(new AuthenticationRequest(credentialId == null ? new byte[0] : credentialId, null, authData, clientJson, signature));
        } catch (RuntimeException e) {
            return checks.verdict(null, null);
        }
        if (data.getAuthenticatorData() == null || data.getCollectedClientData() == null) {
            return checks.verdict(null, null);
        }
        checks.pass("readable");
        AuthenticatorFlags flags = AuthenticatorFlags.of(data.getAuthenticatorData().getFlags());
        long signCount = data.getAuthenticatorData().getSignCount();
        // The stored key must be one of the algorithm's kind (ES256 on P-256, RS256 of 2048 bits and more): a key that is
        // not can never verify, so the signature fails without asking the library (before the client data's checks).
        COSEKey key = CoseKey.toCose(spki, algorithm);
        if (key == null) {
            return checks.fail("signature", flags, signCount, null);
        }
        try {
            // A fresh record per verification: webauthn4j moves the counter of the record it is given, and the counter
            // rule is the signature verifier's (after the replay check), so the library is shown none.
            CredentialRecord record = new CredentialRecordImpl(new NoneAttestationStatement(), null, null, null, 0L,
                new AttestedCredentialData(AAGUID.ZERO, credentialId == null ? new byte[0] : credentialId, key), null, null, null, null);
            manager.verify(data, new AuthenticationParameters(serverProperty(origins, rpId, expectedChallenge), record, null,
                requireUserVerification, true));
        } catch (VerificationException e) {
            return checks.refused(e, flags, signCount, origins.contains(clientData.origin()));
        } catch (RuntimeException e) {
            // webauthn4j lets raw exceptions of its readers escape: a rule of the library's, never a pass.
            return checks.fail(LIBRARY_CHECK, flags, signCount, e.getClass().getSimpleName());
        }
        checks.passLibrary();
        String refused = clientDataPolicy(clientData, expectedChallenge, origins);
        if (refused != null) {
            return checks.fail(refused, flags, signCount, null);
        }
        return checks.passed(flags, signCount, null);
    }

    /**
     * Verifies a registration (a passkey created for this site).
     *
     * @param response clientDataJSON, and attestationObject and/or authenticatorData, base64url
     * @param expectedChallenge the raw challenge this site handed out
     * @param origins the origins the client may have written
     * @param rpId the relying party id
     * @param requireUserVerification whether the UV flag must be set
     * @param credentialId the credential id the browser reported (raw), checked against the authenticator
     *     data's; null takes the authenticator data's
     * @param publicKey the SPKI the browser reported ({@code getPublicKey()}, raw), checked against the
     *     authenticator data's COSE key; null takes the COSE key's (an empty array is a reported key that is none)
     */
    public WebAuthnVerdict verifyRegistration(JsonNode response, byte[] expectedChallenge, List<String> origins, String rpId,
                                              boolean requireUserVerification, byte @Nullable [] credentialId, byte @Nullable [] publicKey) {
        Checks checks = new Checks(REGISTRATION_CHECKS);
        byte[] clientJson = Base64Url.decode(text(response, "clientDataJSON"));
        ClientData clientData = clientJson != null ? clientData(clientJson) : null;
        Registration posted = registration(response);
        if (clientData == null || posted == null) {
            return checks.verdict(null, null);
        }
        RegistrationData data;
        try {
            data = manager.parse(new RegistrationRequest(posted.attestationObject(), clientJson));
        } catch (RuntimeException e) {
            return checks.verdict(null, null);
        }
        if (data.getAttestationObject() == null || data.getAttestationObject().getAuthenticatorData() == null || data.getCollectedClientData() == null) {
            return checks.verdict(null, null);
        }
        checks.pass("readable");
        var authenticatorData = data.getAttestationObject().getAuthenticatorData();
        AuthenticatorFlags flags = AuthenticatorFlags.of(authenticatorData.getFlags());
        long signCount = authenticatorData.getSignCount();
        AttestedCredentialData attested = authenticatorData.getAttestedCredentialData();
        if (attested == null || attested.getCOSEKey() == null) {
            // Without the AT flag there is no credential to register (the library would refuse it before anything else).
            return checks.fail("attestedCredential", flags, signCount, null);
        }
        checks.pass("attestedCredential");
        try {
            manager.verify(data, new RegistrationParameters(serverProperty(origins, rpId, expectedChallenge), ALGORITHMS,
                requireUserVerification, true));
        } catch (VerificationException e) {
            return checks.refused(e, flags, signCount, origins.contains(clientData.origin()));
        } catch (RuntimeException e) {
            return checks.fail(LIBRARY_CHECK, flags, signCount, e.getClass().getSimpleName());
        }
        checks.passLibrary();
        String refused = clientDataPolicy(clientData, expectedChallenge, origins);
        if (refused != null) {
            return checks.fail(refused, flags, signCount, null);
        }
        if (credentialId != null && !MessageDigest.isEqual(attested.getCredentialId(), credentialId)) {
            return checks.fail("credentialId", flags, signCount, null);
        }
        checks.pass("credentialId");
        CoseKey.Spki key;
        try {
            // A key this site could never verify with (an RSA modulus under 2048 bits padded with zero bytes, a point off
            // P-256) is refused here, not stored to fail every signature later.
            key = CoseKey.fromCose(attested.getCOSEKey());
        } catch (IllegalArgumentException e) {
            return checks.fail("publicKey", flags, signCount, null);
        }
        if (publicKey != null && !MessageDigest.isEqual(key.spki(), publicKey)) {
            return checks.fail("publicKey", flags, signCount, null);
        }
        checks.pass("publicKey");
        WebAuthnVerdict.RegisteredCredential credential = new WebAuthnVerdict.RegisteredCredential(attested.getCredentialId(), key.spki(),
            key.algorithm(), aaguid(attested.getAaguid() == null ? null : attested.getAaguid().getBytes()), clientData.origin(),
            posted.sent() ? attestationFormat(data) : "");
        return checks.passed(flags, signCount, credential);
    }

    /**
     * The site's own reading of the client data, after the library's: the challenge exactly the base64url this site
     * handed out (the library compares the decoded bytes); the origin exactly one of the configured texts, as the
     * browser wrote it (the library compares {@link Origin}s, which lower-case the scheme and host, fill in the default
     * port and drop a path, query, fragment or user info, so {@code http://localhost/evil} would pass it; the rule, every host's,
     * is the exact text, and the text is what a registration stores); and never
     * {@code crossOrigin: true} (the library refuses it too while no topOrigin is configured, which this site never does).
     */
    private static String clientDataPolicy(ClientData clientData, byte[] expectedChallenge, List<String> origins) {
        if (!MessageDigest.isEqual(Base64Url.encode(expectedChallenge).getBytes(StandardCharsets.UTF_8),
            clientData.challenge().getBytes(StandardCharsets.UTF_8))) {
            return "challenge";
        }
        if (!origins.contains(clientData.origin()) || clientData.crossOrigin()) {
            return "origin";
        }
        return null;
    }

    /** The attestation object to give the library, and whether the browser sent one. */
    private record Registration(byte[] attestationObject, boolean sent) {
    }

    /**
     * The attestation object of a registration response, through the pre-gate: the one the browser sent (and then the
     * authenticatorData beside it, if any, must be its authData), or, for a registration made of the authenticator data
     * alone (taken, as the engine's registerCredential can send it), the "none" one those bytes stand for. Null when it
     * cannot be read.
     */
    private Registration registration(JsonNode response) {
        byte[] reported = response != null && response.isObject() && response.get("authenticatorData") != null
            && response.get("authenticatorData").isString() ? Base64Url.decode(response.get("authenticatorData").asString()) : null;
        JsonNode attestation = response == null || !response.isObject() ? null : response.get("attestationObject");
        try {
            if (attestation == null || !attestation.isString()) {
                if (reported == null || !laidOut(reported)) {
                    return null;
                }
                Map<String, Object> none = new LinkedHashMap<>();
                none.put("fmt", "none");
                none.put("attStmt", Map.of());
                none.put("authData", reported);
                return new Registration(OBJECTS.getCborMapper().writeValueAsBytes(none), false);
            }
            byte[] bytes = Base64Url.decode(attestation.asString());
            if (bytes == null || bytes.length == 0) {
                return null;
            }
            CborGate.whole(bytes);
            byte[] authData = attestationObjects.extractAuthenticatorData(bytes);
            if (authData == null || !laidOut(authData) || (reported != null && reported.length > 0 && !MessageDigest.isEqual(authData, reported))) {
                return null;
            }
            return new Registration(bytes, true);
        } catch (RuntimeException e) {
            return null;
        }
    }

    /**
     * Whether authenticator data is laid out as WebAuthn 6.1 says, its CBOR through the pre-gate: the 32-byte rpIdHash,
     * the flags, the counter; with AT the AAGUID, a credential id of 1 to 1023 bytes and a COSE key map; with ED an
     * extensions map; and nothing after.
     */
    static boolean laidOut(byte[] authData) {
        if (authData.length < 37) {
            return false;
        }
        int flags = authData[32] & 0xff;
        int offset = 37;
        try {
            if ((flags & 0x40) != 0) {
                // The aaguid (16), credentialIdLength (2), credentialId, COSE key.
                if (authData.length < 55) {
                    return false;
                }
                int length = ((authData[53] & 0xff) << 8) | (authData[54] & 0xff);
                if (length == 0 || length > 1023 || authData.length < 55 + length) {
                    return false;
                }
                offset = CborGate.map(authData, 55 + length);
            }
            if ((flags & 0x80) != 0) {
                offset = CborGate.map(authData, offset);
            }
        } catch (IllegalArgumentException e) {
            return false;
        }
        return offset == authData.length;
    }

    /** The format of the attestation object the browser sent ("none"), or "" when it is none this site records. */
    private static String attestationFormat(RegistrationData data) {
        String format;
        try {
            format = data.getAttestationObject().getFormat();
        } catch (RuntimeException e) {
            return "";
        }
        return format != null && FORMAT.matcher(format).matches() ? format : "";
    }

    /** The client data's fields this site reads (WebAuthn 7.1, steps 7 to 11). */
    private record ClientData(String type, String challenge, String origin, boolean crossOrigin) {
    }

    /** The client data JSON, read strictly; null when it is not WebAuthn's. */
    private static ClientData clientData(byte[] json) {
        JsonNode data;
        try {
            data = CLIENT_DATA.readTree(json);
        } catch (RuntimeException e) {
            return null;
        }
        if (data == null || !data.isObject()) {
            return null;
        }
        JsonNode type = data.get("type");
        JsonNode challenge = data.get("challenge");
        JsonNode origin = data.get("origin");
        if (type == null || !type.isString() || challenge == null || !challenge.isString() || origin == null || !origin.isString()) {
            return null;
        }
        JsonNode crossOrigin = data.get("crossOrigin");
        return new ClientData(type.asString(), challenge.asString(), origin.asString(),
            crossOrigin != null && crossOrigin.isBoolean() && crossOrigin.booleanValue());
    }

    private static ServerProperty serverProperty(List<String> origins, String rpId, byte[] challenge) {
        Set<Origin> allowed = new LinkedHashSet<>();
        for (String origin : origins) {
            allowed.add(new Origin(origin));
        }
        // Never a topOrigin: a cross-origin response is refused.
        return new ServerProperty(allowed, rpId, new DefaultChallenge(challenge));
    }

    /** A member that must be text; "" when it is missing or of another type. */
    private static String text(JsonNode values, String name) {
        JsonNode member = values == null || !values.isObject() ? null : values.get(name);
        return member != null && member.isString() ? member.asString() : "";
    }

    /**
     * The checks of one ceremony, in order, each false until it passed: the library stops at its first refusal, so a
     * check after the failed one says "not reached", never "passed".
     */
    private static final class Checks {
        private final List<String> order;
        private final Map<String, Boolean> checks = new LinkedHashMap<>();

        Checks(List<String> order) {
            this.order = order;
            for (String name : order) {
                checks.put(name, false);
            }
        }

        void pass(String name) {
            checks.put(name, true);
        }

        /** Every check the library made passed. */
        void passLibrary() {
            for (String name : LIBRARY_ORDER) {
                if (checks.containsKey(name)) {
                    checks.put(name, true);
                }
            }
            checks.put(LIBRARY_CHECK, true);
        }

        /**
         * The library refused: the checks it made before the refused one passed, when the refusal has a name here. The
         * library compares normalised origins, so a refusal it made after its origin check, for a response whose origin
         * is not exactly a configured text, is named {@code origin}: the exact origin comes before the relying party,
         * presence, verification and the signature, as it always did here.
         */
        WebAuthnVerdict refused(VerificationException refusal, AuthenticatorFlags flags, long signCount, boolean originExact) {
            String failed = checkOf(refusal);
            if (!originExact && !List.of("type", "challenge", "origin").contains(failed)) {
                checks.put("type", true);
                checks.put("challenge", true);
                return fail("origin", flags, signCount, null);
            }
            int at = LIBRARY_ORDER.indexOf(failed);
            for (int i = 0; i < at; i++) {
                if (checks.containsKey(LIBRARY_ORDER.get(i))) {
                    checks.put(LIBRARY_ORDER.get(i), true);
                }
            }
            if (failed.equals("publicKey") || failed.equals("credentialId")) {
                // A registration's algorithm and the id's length come after user verification in the library's order.
                for (String name : LIBRARY_ORDER) {
                    if (checks.containsKey(name)) {
                        checks.put(name, true);
                    }
                }
            }
            return fail(failed, flags, signCount, failed.equals(LIBRARY_CHECK) ? refusal.getClass().getSimpleName() : null);
        }

        WebAuthnVerdict fail(String failed, AuthenticatorFlags flags, long signCount, String detail) {
            checks.put(failed, false);
            String reason = REASONS.get(failed) + (detail == null ? "" : " (" + detail + ")");
            return new WebAuthnVerdict(false, checks, flags, signCount, failed, reason, null);
        }

        /** Nothing could be read. */
        WebAuthnVerdict verdict(AuthenticatorFlags flags, WebAuthnVerdict.RegisteredCredential credential) {
            return new WebAuthnVerdict(false, checks, flags == null ? AuthenticatorFlags.NONE : flags, 0, order.get(0),
                REASONS.get(order.get(0)), credential);
        }

        WebAuthnVerdict passed(AuthenticatorFlags flags, long signCount, WebAuthnVerdict.RegisteredCredential credential) {
            for (Map.Entry<String, Boolean> check : checks.entrySet()) {
                if (!check.getValue()) {
                    // A check this class forgot to mark: fail closed, never a valid verdict over an unmade check.
                    return fail(check.getKey(), flags, signCount, null);
                }
            }
            return new WebAuthnVerdict(true, checks, flags, signCount, null, null, credential);
        }
    }

    /** An AAGUID as 8-4-4-4-12 text; "" when it is not 16 bytes. */
    static String aaguid(byte[] bytes) {
        if (bytes == null || bytes.length != 16) {
            return "";
        }
        String hex = HexFormat.of().formatHex(bytes);
        return hex.substring(0, 8) + "-" + hex.substring(8, 12) + "-" + hex.substring(12, 16) + "-" + hex.substring(16, 20) + "-" + hex.substring(20);
    }

    static byte[] sha256(byte[] bytes) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(bytes);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("SHA-256 is required of every Java platform", e);
        }
    }
}
