package com.argusvane.datum.submissions.spi;

/**
 * Which of the receiver's routes a request came in on.
 *
 * <ul>
 *   <li>{@link #SUBMIT}: a delivery ({@code POST /api/submissions}): judged, handed to the
 *       {@link SubmissionHandler}, events published.</li>
 *   <li>{@link #VALIDATE}: a journey's page or final check ({@code POST /api/submissions/validate}):
 *       judged, nothing kept, answered {@code {accepted, errors, notes?}}.</li>
 *   <li>{@link #TEST}: the dry run ({@code POST /api/submissions/test}, the builder's test of a form; endpoint
 *       catalog {@code testSubmission}): every check of a delivery, reported, and nothing kept, handed on or
 *       published.</li>
 *   <li>{@link #PDF}: the answers behind a PDF request ({@code POST /pdf*} of datum-pdf): judged exactly as a dry
 *       run judges them and nothing kept, handed on or published (who may print is the application's security on
 *       the PDF routes, never the dry run's: an application that restricts the dry run must not lose its PDFs; the
 *       {@link SubmissionPreCheck}s are asked, with this mode, as for every other) and not counted by
 *       the receiver's throttle, because the PDF facade counted the request once under kind {@code pdf} before it
 *       asked (counting it again would halve the limit). The 200 body is the dry run's report.</li>
 * </ul>
 */
public enum SubmissionMode {
    SUBMIT,
    VALIDATE,
    TEST,
    PDF;

    /** Whether nothing is kept, handed on or published, and the answer is the dry run's report: {@link #TEST} and {@link #PDF}. */
    public boolean dryRun() {
        return this == TEST || this == PDF;
    }
}
