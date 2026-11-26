package com.argusvane.datum.webauthn;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Objects;
import java.util.Optional;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

/**
 * Registration challenges: stateless, signed, time-limited and single-use.
 *
 * <p>A challenge is the HMAC-SHA256, under the host's secret, of {@code datum-passkey|purpose|subject|uid|
 * userHandle|nonce|time}: what it is for, the form or account it is for, who asks ("" for an anonymous
 * visitor), the random user handle the passkey will carry, a nonce and the time. The browser gets the challenge
 * to hand the authenticator, and a token holding those fields (base64url JSON) to post back with the
 * registration; the server recomputes the HMAC from the token, so it keeps nothing until the challenge is used.
 * A forged or edited token yields another HMAC, which the authenticator never signed: the registration's
 * challenge check refuses it. Each nonce is claimed once ({@link ChallengeClaims}), so a challenge registers one
 * passkey. A challenge holds 300 seconds unless the host sets a lifetime ({@code datum.webauthn.challenge-ttl}), and an issue time up to 60 seconds ahead of the server's clock (or the host's
 * {@code datum.webauthn.challenge-skew}) is taken (another server's clock).
 *
 * <p>Who asks ({@code u}) is text, a principal's id ("" anonymous); the key is the configured secret
 * ({@code datum.webauthn.secret}).
 */
public final class PasskeyChallenges {

    /** How long a challenge holds unless the host says otherwise: five minutes, long enough for an authenticator prompt. */
    public static final Duration LIFETIME = Duration.ofSeconds(300);

    /** The shortest and longest lifetime a host may set: long enough to use a device, short enough to be a challenge. */
    public static final Duration MIN_LIFETIME = Duration.ofSeconds(10);
    public static final Duration MAX_LIFETIME = Duration.ofHours(1);

    /** How far ahead of the server's clock an issue time may be unless the host sets its own ({@code datum.webauthn.challenge-skew}). */
    public static final Duration SKEW = Duration.ofSeconds(60);

    private static final JsonMapper JSON = JsonMapper.builder().build();

    private final byte[] secret;
    private final Clock clock;
    private final ChallengeClaims claims;
    private final Duration lifetime;
    private final long skewSeconds;
    private final SecureRandom random = new SecureRandom();

    /**
     * @param secret the HMAC key: at least 32 bytes, kept by the host and the same on every process that
     *     verifies registrations
     * @param clock the server's clock
     * @param claims where nonces are claimed
     */
    public PasskeyChallenges(byte[] secret, Clock clock, ChallengeClaims claims) {
        this(secret, clock, claims, LIFETIME);
    }

    /**
     * @param lifetime how long a challenge holds ({@code datum.webauthn.challenge-ttl}), whole seconds from
     *     {@link #MIN_LIFETIME} to {@link #MAX_LIFETIME}; the nonce claim is kept as long, plus the clock skew
     * @throws IllegalArgumentException for a lifetime outside that range
     */
    public PasskeyChallenges(byte[] secret, Clock clock, ChallengeClaims claims, Duration lifetime) {
        this(secret, clock, claims, lifetime, SKEW);
    }

    /**
     * @param skew how far ahead of this clock a challenge's issue time may be ({@code datum.webauthn.challenge-skew}), whole
     *     seconds, not negative
     */
    public PasskeyChallenges(byte[] secret, Clock clock, ChallengeClaims claims, Duration lifetime, Duration skew) {
        Objects.requireNonNull(secret, "secret");
        if (Objects.requireNonNull(skew, "skew").isNegative()) {
            throw new IllegalArgumentException("The passkey challenge skew must not be negative (it is " + skew + ").");
        }
        this.skewSeconds = skew.getSeconds();
        Objects.requireNonNull(lifetime, "lifetime");
        if (lifetime.compareTo(MIN_LIFETIME) < 0 || lifetime.compareTo(MAX_LIFETIME) > 0) {
            throw new IllegalArgumentException("The passkey challenge lifetime must be between " + MIN_LIFETIME.toSeconds() + " seconds and "
                + MAX_LIFETIME.toMinutes() + " minutes (it is " + lifetime + ").");
        }
        this.lifetime = Duration.ofSeconds(lifetime.toSeconds());
        if (secret.length < 32) {
            throw new IllegalArgumentException("The passkey challenge secret must be at least 32 bytes.");
        }
        this.secret = secret.clone();
        this.clock = Objects.requireNonNull(clock, "clock");
        this.claims = Objects.requireNonNull(claims, "claims");
    }

    /** A challenge handed out: the challenge (base64url, for the authenticator), the token to post back, and when it stops holding (epoch seconds). */
    public record IssuedChallenge(String challenge, String token, long expires) {
    }

    /**
     * A token read back and claimed.
     *
     * @param challenge the raw challenge the registration must have signed; copied
     * @param userHandle the user handle (base64url) the passkey must carry
     */
    public record ClaimedChallenge(byte[] challenge, String userHandle) {

        public ClaimedChallenge {
            challenge = challenge.clone();
        }

        @Override
        public byte[] challenge() {
            return challenge.clone();
        }
    }

    private record Fields(String p, String f, String u, String h, String n, long t) {
    }

    /**
     * Issues a challenge.
     *
     * @param purpose what it is for: "register", "register:amend", "account"...
     * @param subject the form (or account, invitation) it is for
     * @param uid who asks; "" for an anonymous visitor
     * @param userHandle the user handle the passkey will carry, base64url
     */
    public IssuedChallenge issue(String purpose, String subject, String uid, String userHandle) {
        byte[] nonce = new byte[16];
        random.nextBytes(nonce);
        Fields fields = new Fields(purpose, subject, uid, userHandle, Base64Url.encode(nonce), now());
        ObjectNode token = JSON.createObjectNode();
        token.put("p", fields.p());
        token.put("f", fields.f());
        token.put("u", fields.u());
        token.put("h", fields.h());
        token.put("n", fields.n());
        token.put("t", fields.t());
        return new IssuedChallenge(Base64Url.encode(mac(fields)), Base64Url.encode(JSON.writeValueAsString(token).getBytes(StandardCharsets.UTF_8)),
            fields.t() + lifetime.toSeconds());
    }

    /**
     * Reads a token back and claims its challenge, once.
     *
     * @param token the token {@link #issue} gave
     * @param purpose the purpose it must be for
     * @param subject the form (or account) it must be for
     * @param uid who it must be for: the one posting it
     * @return the raw challenge and the user handle; empty when the token is not one of this site's shape, is
     *     for something or someone else, has expired, is dated too far ahead, or was used
     */
    public Optional<ClaimedChallenge> claim(String token, String purpose, String subject, String uid) {
        byte[] json = token == null ? null : Base64Url.decode(token);
        JsonNode read;
        try {
            read = json != null && json.length > 0 ? JSON.readTree(json) : null;
        } catch (RuntimeException e) {
            read = null;
        }
        if (read == null || !read.isObject()
            || !isText(read, "p") || !isText(read, "f") || !isText(read, "u") || !isText(read, "h") || !isText(read, "n")
            || read.get("t") == null || !read.get("t").isIntegralNumber() || !read.get("t").canConvertToLong()) {
            return Optional.empty();
        }
        Fields fields = new Fields(read.get("p").asString(), read.get("f").asString(), read.get("u").asString(), read.get("h").asString(),
            read.get("n").asString(), read.get("t").longValue());
        long now = now();
        if (!fields.p().equals(purpose) || !fields.f().equals(subject) || !fields.u().equals(uid)
            || fields.t() > now + skewSeconds || now - fields.t() > lifetime.toSeconds()) {
            return Optional.empty();
        }
        if (!claims.claim(fields.n(), Instant.ofEpochSecond(now), lifetime.plusSeconds(skewSeconds))) {
            return Optional.empty();
        }
        return Optional.of(new ClaimedChallenge(mac(fields), fields.h()));
    }

    private long now() {
        return clock.instant().getEpochSecond();
    }

    private static boolean isText(JsonNode node, String name) {
        JsonNode member = node.get(name);
        return member != null && member.isString();
    }

    /** The raw HMAC over a challenge's fields, in issue order. */
    private byte[] mac(Fields fields) {
        String message = "datum-passkey|" + String.join("|", fields.p(), fields.f(), fields.u(), fields.h(), fields.n(), Long.toString(fields.t()));
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret, "HmacSHA256"));
            return mac.doFinal(message.getBytes(StandardCharsets.UTF_8));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("HmacSHA256 is required of every Java platform", e);
        }
    }
}
