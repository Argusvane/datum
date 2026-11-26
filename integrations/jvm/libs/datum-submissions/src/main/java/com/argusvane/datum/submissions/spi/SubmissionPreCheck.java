package com.argusvane.datum.submissions.spi;

/**
 * An application's own check on a request before it is judged (a pre-check
 * hook): an anti-spam token, a honeypot header, a captcha verdict. There is none by default; every bean is
 * asked, in the framework's order (declare {@code @Order} where the relative order matters; equal orders keep registration order), and the first refusal answers.
 *
 * <p>It is also where a rule about who may use a given form lives: the route itself is the
 * application's security, which cannot see the form key in the body. The check reads the caller from
 * {@link IncomingSubmission#principal()} (never from a thread-bound security context, which the WebFlux binding's
 * elastic scheduler does not carry), and one that refuses with
 * {@code PreCheckDecision.Reject.of("access.denied")} keeps the wire's code (403 by the receiver's standard
 * {@code PreCheckStatuses}: a refusal names a code and words, the HTTP receiver the status).
 *
 * <p>It runs after the body is read and the throttle, and before the definition version
 * check and the sandbox, so a refused request costs no run. It is asked for every mode
 * ({@link IncomingSubmission#mode()}); a check that must not refuse a dry run or a journey's check (an anti-spam
 * check usually skips both, and a minimum fill time makes no sense on a page check) answers
 * {@link PreCheckDecision#ALLOW} for them.
 */
@FunctionalInterface
public interface SubmissionPreCheck {

    PreCheckDecision check(IncomingSubmission submission);
}
