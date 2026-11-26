package com.argusvane.datum.timestamp;

import java.time.Duration;
import java.util.Objects;
import java.util.Set;

/**
 * One timestamp request as a {@link TimestampRequestCustomizer} sees it, before the authority signs: who asks
 * and what, read only, and the two things a customizer may choose for this token, within the server's policy: the policy
 * it is issued under and the accuracy it states.
 *
 * <p>Never the digest, the nonce, the serial, the time or the key: the token vouches that the server saw this digest at
 * its own time, and nothing a hook says changes that.
 */
public final class TimestampRequestDraft {

    private final TimestampQuery query;
    private final String client;
    private final String channel;
    private final Set<String> acceptedPolicies;
    private String policy;
    private Duration accuracy;

    TimestampRequestDraft(TimestampQuery query, String client, String channel, Set<String> acceptedPolicies, String policy, Duration accuracy) {
        this.query = Objects.requireNonNull(query, "query");
        this.client = client;
        this.channel = Objects.requireNonNull(channel, "channel");
        this.acceptedPolicies = Set.copyOf(acceptedPolicies);
        this.policy = Objects.requireNonNull(policy, "policy");
        this.accuracy = Objects.requireNonNull(accuracy, "accuracy");
    }

    /** The client that asked ({@link TsaClient#id()}), or null for an open request or the host's own (read only). */
    public String client() {
        return client;
    }

    /** Who asked: {@code http} for the endpoint, {@code sealing}, {@code receipt} or another word for the host's own use (read only). */
    public String channel() {
        return channel;
    }

    /** The imprint's digest algorithm: {@code sha256}, {@code sha384} or {@code sha512} (read only). */
    public String algorithm() {
        return query.algorithm();
    }

    /** A copy of the digest the token will carry (read only). */
    public byte[] hash() {
        return query.hash();
    }

    /** The policy the request asked for ({@code reqPolicy}, dotted), or null when it asked none (read only). */
    public String requestedPolicy() {
        return query.policy();
    }

    /** Whether the request asked for the certificate in the token (read only). */
    public boolean certReq() {
        return query.certReq();
    }

    /** Whether the request carries a nonce (read only). */
    public boolean hasNonce() {
        return query.nonce() != null;
    }

    /** The policies the server issues under, the issuing one first ({@code datum.tsa.policy}, {@code datum.tsa.accepted-policies}). */
    public Set<String> acceptedPolicies() {
        return acceptedPolicies;
    }

    /** The policy the token will name. */
    public String policy() {
        return policy;
    }

    /**
     * Chooses the policy the token names, one of {@link #acceptedPolicies()}. A request that asked for a policy is issued
     * under that policy or refused (RFC 3161 section 2.4.1), so only that one is taken then.
     *
     * @throws IllegalArgumentException for a policy the server does not issue under, or another than the one asked for
     */
    public void policy(String chosen) {
        String clean = chosen == null ? "" : chosen.trim();
        if (!acceptedPolicies.contains(clean)) {
            throw new IllegalArgumentException("The timestamp server issues tokens under " + acceptedPolicies + " only, not " + clean + ".");
        }
        if (query.policy() != null && !query.policy().equals(clean)) {
            throw new IllegalArgumentException("The request asked for policy " + query.policy() + ": its token names that one or none is issued.");
        }
        this.policy = clean;
    }

    /** The accuracy the token will state (zero: none). */
    public Duration accuracy() {
        return accuracy;
    }

    /**
     * Sets the accuracy the token states, whole milliseconds from zero (none stated) to {@link TimestampAuthority#MAX_ACCURACY};
     * under a second, genTime carries milliseconds.
     *
     * @throws IllegalArgumentException outside those bounds
     */
    public void accuracy(Duration stated) {
        Objects.requireNonNull(stated, "accuracy");
        if (stated.isNegative() || stated.compareTo(TimestampAuthority.MAX_ACCURACY) > 0) {
            throw new IllegalArgumentException("A token's accuracy is 0 to " + TimestampAuthority.MAX_ACCURACY.toSeconds() + " seconds, not " + stated + ".");
        }
        this.accuracy = Duration.ofMillis(stated.toMillis());
    }
}
