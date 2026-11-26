package com.argusvane.datum.submissions.spi;

import java.util.Objects;

/**
 * What a {@link HostContextProvider} is told of one run: the form it judges and who asked through what. The request facts
 * are the {@link SubmissionContext} every other hook of the run reads (the principal, the headers as plain data, the client
 * address, the channel), so a provider serves an HTTP request, a queue's message and a batch alike; on the routes the
 * principal is the web framework's own (Spring Security's {@code Authentication} on Spring Boot).
 *
 * @param formKey the form's key (its id)
 * @param formVersion the version of the server's current definition, which the document was checked to name
 * @param mode which call: a delivery, a journey's check, a dry run, or the dry run behind a PDF
 * @param submission who sent the document and through what
 */
public record HostContextRequest(String formKey, String formVersion, SubmissionMode mode, SubmissionContext submission) {

    public HostContextRequest {
        Objects.requireNonNull(formKey, "formKey");
        Objects.requireNonNull(formVersion, "formVersion");
        Objects.requireNonNull(mode, "mode");
        Objects.requireNonNull(submission, "submission");
    }
}
