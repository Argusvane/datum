package com.argusvane.datum.submissions.receiver;

/**
 * The HTTP status a pre-check's refusal is answered with: the pre-check names a code and words only
 * ({@link com.argusvane.datum.submissions.spi.PreCheckDecision.Reject}), and the route chooses the status from the
 * code, so a refusal means the same on every channel and only the HTTP facade speaks HTTP.
 *
 * <p>{@link #standard()}, the receiver's default, answers 403 for every code: what {@code Reject.of(code)} gives,
 * so a pre-check's code never changes its status by the words it happens to end in. An application
 * that wants other statuses opts in: {@link #bySuffix()} reads the code's last word (422 {@code .invalid}, 503
 * {@code .unavailable}, the statuses the anti-spam checks chose), or the application gives its own
 * mapping (the Spring binding takes a {@code PreCheckStatuses} bean). A mapping that throws, or answers a status outside
 * 400 to 599, fails the request (500), as a hook that fails does. A mapping may answer 429, but the refusal then carries
 * no {@code Retry-After} (every other 429 here does: {@code flood}); a pre-check that limits a rate belongs in the
 * {@code SubmissionThrottle}, which gives one.
 */
@FunctionalInterface
public interface PreCheckStatuses {

    /** The status for a refusal's code, 400 to 599. */
    int statusOf(String code);

    /** 403 for every code (the receiver's default). */
    static PreCheckStatuses standard() {
        return code -> 403;
    }

    /**
     * By the code's last word, opted into: 422 for a code ending {@code .invalid} (the document is not what the form
     * takes), 503 for {@code .unavailable} (a service the check asks is down), else 403 ({@code access.denied},
     * {@code spam.honeypot}: refused). No word maps to 429, which on this wire always carries a {@code Retry-After}.
     */
    static PreCheckStatuses bySuffix() {
        return code -> {
            if (code.endsWith(".invalid")) {
                return 422;
            }
            if (code.endsWith(".unavailable")) {
                return 503;
            }
            return 403;
        };
    }
}
