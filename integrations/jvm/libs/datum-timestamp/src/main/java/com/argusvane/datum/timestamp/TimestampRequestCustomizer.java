package com.argusvane.datum.timestamp;

/**
 * The application's per-request policy for the timestamp authority, before it signs (the timestamp side of the
 * hook model): refuse a client, choose the policy a token is issued under among the accepted ones, state another accuracy
 * within the bounds. The beans run in the framework's order (declare {@code @Order} where the relative order matters;
 * equal orders keep registration order), each over what the one before left.
 *
 * <p>By default a customizer runs for the endpoint's tokens only ({@link TimestampRequestDraft#channel()} {@value #HTTP},
 * after its admission: cookie, content type, client key, flood, size). The host's own tokens (sealing a PDF, a receipt)
 * carry no client, so a client policy that refuses an unknown client would refuse every one of them, and the seal path
 * turns a failed timestamp into a {@code sealing.timestamp} warning: sealed PDFs would go out silently without the token
 * their layout asked for. A customizer meant for those too says so with {@link #appliesTo(String)},
 * or is wrapped in {@link #everyChannel(TimestampRequestCustomizer)}.
 *
 * <p>In order: the request's own policy is checked (unacceptedPolicy), then the customizers, then the time source, the key,
 * the serial and the signature; a refused request costs no key load and no serial.
 *
 * <p>The timestamp server's wire is RFC 3161, so a refusal is a TimeStampResp rejection: a customizer throws
 * {@link TimestampRefusedException} with the PKIFailureInfo bit it means ({@code badRequest} for "transaction not
 * permitted", {@code unacceptedPolicy}), or {@link com.argusvane.datum.core.hooks.HookRefusedException} of any kind,
 * which is answered {@code badRequest} with its message (400). Anything else it throws, a draft value out of bounds
 * included, is {@code systemFailure} (503) with the cause in the log only: a token issued without the policy the
 * application set is not one it would stand behind.
 */
@FunctionalInterface
public interface TimestampRequestCustomizer {

    /** The endpoint's channel: {@code POST /tsa}. */
    String HTTP = "http";

    /** Adjusts the draft in place, or refuses. */
    void customize(TimestampRequestDraft draft);

    /**
     * Whether this customizer runs for a token asked on this channel, asked before {@link #customize}: {@value #HTTP} only
     * by default. A throw here is the customizer's failure ({@code systemFailure}), as one from {@code customize} is.
     *
     * @param channel {@value #HTTP} for the endpoint, {@code sealing}, {@code receipt} or another word for the host's own use
     */
    default boolean appliesTo(String channel) {
        return HTTP.equals(channel);
    }

    /** The customizer, run for every token the authority issues: the endpoint's and the host's own (sealing, receipts). */
    static TimestampRequestCustomizer everyChannel(TimestampRequestCustomizer customizer) {
        java.util.Objects.requireNonNull(customizer, "customizer");
        return new TimestampRequestCustomizer() {
            @Override
            public void customize(TimestampRequestDraft draft) {
                customizer.customize(draft);
            }

            @Override
            public boolean appliesTo(String channel) {
                return true;
            }
        };
    }
}
