package com.argusvane.datum.submissions.spi;

import java.util.Objects;
import org.jspecify.annotations.Nullable;

/**
 * One finding about a submission: the kernel's {@code {componentId, code, message?, severity?}} or a server
 * validator's, with the server stage's {@code source}/{@code stage} marks.
 *
 * <p>Only {@code severity} decides whether it blocks: absent or {@code "error"} blocks, {@code "warning"} and
 * {@code "info"} never do (the kernel's severities: a warning rides along with an accepted submission).
 *
 * @param field the component id it belongs to, or null for the form as a whole
 * @param code the stable machine code ({@code required}, {@code journey.exit}, a validator's own)
 * @param message host-worded text, or null; sent to the browser, so never a stack trace or a guest's output
 * @param severity {@code error}, {@code warning}, {@code info}, or null (an error)
 * @param stage where it came from ({@code server} for a validator's), or null
 * @param source who said it ({@code server} for a validator's), or null
 */
public record SubmissionError(@Nullable String field, String code, @Nullable String message, @Nullable String severity, @Nullable String stage,
                              @Nullable String source) {

    public SubmissionError {
        Objects.requireNonNull(code, "code");
    }

    /** A blocking error. */
    public static SubmissionError error(@Nullable String field, String code, @Nullable String message) {
        return new SubmissionError(field, code, message, null, null, null);
    }

    /** A warning, which never blocks. */
    public static SubmissionError warning(@Nullable String field, String code, @Nullable String message) {
        return new SubmissionError(field, code, message, "warning", null, null);
    }

    /** Whether it blocks a submission: severity absent or {@code error}. */
    public boolean blocks() {
        return severity == null || "error".equals(severity);
    }

    /** The same finding marked as the server stage's, keeping any stage or source it already names. */
    public SubmissionError fromServer() {
        return new SubmissionError(field, code, message, severity, stage == null ? "server" : stage, source == null ? "server" : source);
    }

    /** The same finding with this severity when it names none. */
    public SubmissionError withDefaultSeverity(String fallback) {
        return severity != null ? this : new SubmissionError(field, code, message, fallback, stage, source);
    }
}
