package com.argusvane.datum.submissions.spi;

import java.util.Objects;
import org.jspecify.annotations.Nullable;
import tools.jackson.databind.JsonNode;

/**
 * What a {@link SubmissionHandler} answers for a stored submission: the 200 body's {@code id},
 * {@code reference} and {@code receipt} (endpoint catalog {@code submitSubmission}; the body also carries
 * {@code status: "accepted"}, the digest and any warnings).
 *
 * @param id the record's id (a UUID is a good choice; REC-12 holds a redelivery to the same id); never null
 * @param reference a reference a person can quote ({@code CONTACT-0042}), or null
 * @param receipt the notice the form shows ({@code setNotice}: {@code {title?, message?, ...}}), or null for
 *     the form's own
 */
public record SubmissionReceipt(String id, @Nullable String reference, @Nullable JsonNode receipt) {

    public SubmissionReceipt {
        Objects.requireNonNull(id, "id");
    }
}
