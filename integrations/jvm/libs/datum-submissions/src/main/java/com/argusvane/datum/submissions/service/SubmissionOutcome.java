package com.argusvane.datum.submissions.service;

import com.argusvane.datum.submissions.spi.AcceptedSubmission;
import com.argusvane.datum.submissions.spi.PreCheckDecision;
import com.argusvane.datum.submissions.spi.SubmissionError;
import com.argusvane.datum.submissions.spi.SubmissionReceipt;
import com.argusvane.datum.submissions.spi.ThrottleKey;
import java.time.Duration;
import java.util.List;
import java.util.Objects;
import tools.jackson.databind.node.ObjectNode;

/**
 * What the {@link SubmissionService} answers: one record per way a call can end, with no header or media type
 * in any of them and no status code in any of them (not even a pre-check's: {@link Refused} carries the
 * {@link PreCheckDecision.Reject}'s code and words only, and the HTTP receiver's {@code PreCheckStatuses} chooses its
 * status). The HTTP receiver maps each record to the wire (the endpoint catalog's status and code); another caller reads
 * the record.
 *
 * <p>Which answers which call: {@link Accepted} and {@link Redelivered} only a delivery; {@link Checked} only a journey's
 * check; {@link DryRun} only a dry run (and the check behind a PDF); {@link Rejected} only a delivery (a dry run reports
 * its rejection inside {@link DryRun}, a check inside {@link Checked}); the rest any call, before a verdict.
 *
 * <p>Not an outcome: what a hook or a store throws on its own (a {@code DatumException} with its own code, which the HTTP
 * mapping answers as it is, or any other exception) and an {@link Error}. Both reach the caller unchanged, as they reached
 * the error mapper before; nothing is handled after either.
 */
public sealed interface SubmissionOutcome permits SubmissionOutcome.Accepted, SubmissionOutcome.Redelivered,
    SubmissionOutcome.Rejected, SubmissionOutcome.Checked, SubmissionOutcome.DryRun, SubmissionOutcome.Outdated,
    SubmissionOutcome.NotFound, SubmissionOutcome.Malformed, SubmissionOutcome.KeyConflict, SubmissionOutcome.TooLarge, SubmissionOutcome.Refused,
    SubmissionOutcome.Throttled, SubmissionOutcome.Unavailable {

    /**
     * Every check passed and the handler stored it: {@link com.argusvane.datum.submissions.events.SubmissionValidatedEvent}
     * was published.
     *
     * @param receipt the handler's receipt
     * @param submission what the handler was given (its digest is the document's)
     * @param warnings the findings that did not block, the sandbox's then the validators'
     */
    record Accepted(SubmissionReceipt receipt, AcceptedSubmission submission, List<SubmissionError> warnings) implements SubmissionOutcome {

        public Accepted {
            Objects.requireNonNull(receipt, "receipt");
            Objects.requireNonNull(submission, "submission");
            warnings = List.copyOf(warnings);
        }
    }

    /**
     * The form accepted this submit attempt before (same form, version and submission key, with the same digest, on any
     * channel): the first receipt, and no sandbox run, signature check, validator or handler.
     *
     * @param receipt the first delivery's receipt
     * @param digest the document's digest
     */
    record Redelivered(SubmissionReceipt receipt, String digest) implements SubmissionOutcome {

        public Redelivered {
            Objects.requireNonNull(receipt, "receipt");
            Objects.requireNonNull(digest, "digest");
        }
    }

    /**
     * The verdict refused a delivery; {@link com.argusvane.datum.submissions.events.SubmissionRejectedEvent} was
     * published.
     *
     * @param errors every finding of the verdict, warnings included
     * @param stage {@code journey}, {@code sandbox}, {@code signature} or {@code server}
     */
    record Rejected(List<SubmissionError> errors, String stage) implements SubmissionOutcome {

        public Rejected {
            errors = List.copyOf(errors);
            Objects.requireNonNull(stage, "stage");
        }
    }

    /**
     * A journey's check was judged, accepted or not; nothing is kept.
     *
     * @param accepted whether nothing in scope blocks
     * @param errors the blocking findings in scope (severity {@code error}, which is also what none means); empty exactly
     *     when {@code accepted}
     * @param notes the findings that do not block, in the order the run and the server stage gave them: warnings, and the
     *     {@code server.skipped} note (severity {@code info}); the wire's {@code notes}
     * @param journeyId the journey judged by, or null when the check named an unknown one
     * @param pageId the page checked, or null for a whole-journey check
     */
    record Checked(boolean accepted, List<SubmissionError> errors, List<SubmissionError> notes, String journeyId, String pageId)
        implements SubmissionOutcome {

        public Checked {
            errors = List.copyOf(errors);
            notes = List.copyOf(notes);
        }
    }

    /**
     * A dry run's verdict, accepted or not: nothing stored, handed on or published.
     *
     * @param accepted whether a delivery of it would be accepted
     * @param stage where it was refused, or null when accepted
     * @param errors the findings
     * @param values the values the sandbox kept, or null
     * @param report the dry run's report (what the dry-run route answers): the findings with their severity, stage and
     *     source, what was sent, the kept values, the rule-check lists, the canonical document and digest, the run log,
     *     the run's settings and the signature verdict
     */
    record DryRun(boolean accepted, String stage, List<SubmissionError> errors, ObjectNode values, ObjectNode report)
        implements SubmissionOutcome {

        public DryRun {
            errors = List.copyOf(errors);
            Objects.requireNonNull(report, "report");
        }
    }

    /**
     * The document was answered on a version of the form that is no longer current.
     *
     * @param currentVersion the current definition's {@code version}
     * @param currentSha256 the current FULL definition's hash (server-secret rules included: the HTTP mapping never sends
     *     it to a filler, see {@code SubmissionOutdatedException})
     */
    record Outdated(String currentVersion, String currentSha256) implements SubmissionOutcome {
    }

    /**
     * No form has the key the document (or the {@link FormRef}) names, or no form could have it.
     *
     * @param formKey the key as named (never echoed by the HTTP mapping)
     */
    record NotFound(String formKey) implements SubmissionOutcome {
    }

    /**
     * The document is not one this call takes (its shape, its nesting, a number JSON cannot write back, a page check
     * naming no page of the journey, a {@link FormRef} that names another form).
     *
     * @param reason the host's words, fixed (never the caller's text)
     */
    record Malformed(String reason) implements SubmissionOutcome {

        public Malformed {
            Objects.requireNonNull(reason, "reason");
        }
    }

    /**
     * The delivery's submission key was accepted before with another document: refused (409 {@code submission.keyConflict}),
     * never answered with the first receipt, so a guessed key reads nothing. The key is asked before the document is judged,
     * so this is the answer whatever the other document holds. A new submit attempt carries a new key.
     *
     * @param digest the digest of the document this delivery carried
     */
    record KeyConflict(String digest) implements SubmissionOutcome {

        public KeyConflict {
            Objects.requireNonNull(digest, "digest");
        }
    }

    /**
     * The document takes more than the service's size cap as JSON text, measured before anything else walks it; nothing
     * was judged or counted.
     *
     * @param maxBytes the cap, in bytes
     */
    record TooLarge(long maxBytes) implements SubmissionOutcome {
    }

    /**
     * A {@link com.argusvane.datum.submissions.spi.SubmissionPreCheck} refused it, before anything was judged.
     *
     * @param decision the pre-check's refusal, as it gave it: its code and words (the HTTP receiver maps the code to a
     *     status)
     */
    record Refused(PreCheckDecision.Reject decision) implements SubmissionOutcome {

        public Refused {
            Objects.requireNonNull(decision, "decision");
        }

        /** The pre-check's machine code ({@code spam.honeypot}, say). */
        public String code() {
            return decision.code();
        }

        /** The pre-check's words for the person, or null. */
        public String message() {
            return decision.message();
        }
    }

    /**
     * The throttle said no, before anything was judged.
     *
     * @param retryAfter how long until the key may ask again
     * @param key the key it counted
     */
    record Throttled(Duration retryAfter, ThrottleKey key) implements SubmissionOutcome {

        public Throttled {
            Objects.requireNonNull(retryAfter, "retryAfter");
        }
    }

    /**
     * No verdict could be reached, for a reason that is not the answers': the runtime is down or busy, a data source, a
     * rule module, a hook or the idempotency store failed, the program's outcome lacks what a record is stored under, or the
     * run itself gave no answer ({@code wasm.execution_error}, {@code outcome_too_large}, {@code definition.tooDeep}), on a
     * delivery and on a journey's check alike: a run that failed is no verdict, so a check never answers it as {@link Checked}.
     * Nothing was accepted.
     *
     * @param code {@code server.unavailable}, {@code server.busy}, {@code validator_unavailable} or the run's own code
     * @param reason the host's words, for the log (the HTTP routes answer a 5xx without them)
     * @param cause what failed: the run's own exception (which the HTTP mapping answers as it is), or the hook's
     *     exception behind a {@code validator_unavailable}; null when nothing threw (an outcome without its digest)
     */
    record Unavailable(String code, String reason, Throwable cause) implements SubmissionOutcome {

        public Unavailable {
            Objects.requireNonNull(code, "code");
            Objects.requireNonNull(reason, "reason");
        }
    }
}
