package com.argusvane.datum.web.security;

import com.argusvane.datum.core.DatumStartupCheck;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.function.Supplier;

/**
 * The start-up WARN (framework-first): who may call a Datum route is the
 * application's security, so when routes that change state or hand out credentials are on (the builder's writes, the
 * passkey endpoints, the timestamp server in client mode) and the application declares no security filter chain for
 * its web stack, those routes are open to anyone who can reach the server, and the start says so with the fix. A
 * chain of any shape silences it (Spring Boot's default chain, which asks a sign-in for everything, included): whether
 * the chain's rules are right is the application's to test, not something a start-up check can read.
 *
 * <p>The line's shape is here, framework-free, so a Quarkus binding would write the same line; the binding gathers the
 * {@link Facts} (which route beans exist, whether a chain exists), names its own chain and matcher types, and words
 * the remedy in its framework's terms (on Spring: add spring-boot-starter-security and secure DatumRequestMatchers),
 * which this library cannot know. The
 * timestamp server is named in client mode only ({@code datum.tsa.access}, {@code clients} by default); in open mode the application chose an open server with its flood limit.
 */
public final class SecurityStartupCheck {

    /** The category datum-web-core's start-up lines are written under. */
    public static final String CATEGORY = "datum.web";

    /**
     * What the binding found once every bean exists.
     *
     * @param builderWrites  the builder's write routes are registered
     * @param passkeys       the passkey routes are registered
     * @param tsaClientMode  the timestamp routes are registered and {@code datum.tsa.access} is not {@code open}
     * @param chain          the application declares a security filter chain for its web stack
     */
    public record Facts(boolean builderWrites, boolean passkeys, boolean tsaClientMode, boolean chain) {
    }

    private SecurityStartupCheck() {
    }

    /**
     * The check.
     *
     * @param facts    asked when the check runs (after every bean exists)
     * @param chain    the framework's chain type ({@code SecurityFilterChain})
     * @param matchers the binding's matcher type ({@code DatumRequestMatchers})
     * @param remedy   what the application does about it, in the framework's terms, ending the line
     */
    public static DatumStartupCheck check(Supplier<Facts> facts, String chain, String matchers, String remedy) {
        Objects.requireNonNull(facts, "facts");
        Objects.requireNonNull(remedy, "remedy");
        return () -> notice(facts.get(), chain, matchers, remedy).map(List::of).orElse(List.of());
    }

    /** The WARN for these facts, or none. */
    public static java.util.Optional<DatumStartupCheck.Notice> notice(Facts facts, String chain, String matchers, String remedy) {
        List<String> open = new ArrayList<>();
        if (facts.builderWrites()) {
            open.add("the builder's writes (datum.builder.enabled; " + matchers + ".builderWrites() and builderReads())");
        }
        if (facts.passkeys()) {
            open.add("the passkey endpoints (datum.webauthn.enabled; " + matchers + ".passkeys())");
        }
        if (facts.tsaClientMode()) {
            open.add("the timestamp server in client mode (datum.tsa.enabled; " + matchers + ".tsa())");
        }
        if (open.isEmpty() || facts.chain()) {
            return java.util.Optional.empty();
        }
        return java.util.Optional.of(DatumStartupCheck.Notice.warn(CATEGORY, "Datum serves " + String.join(", ", open)
            + " and the application declares no " + chain + ": these routes are open: " + remedy + "."));
    }
}
