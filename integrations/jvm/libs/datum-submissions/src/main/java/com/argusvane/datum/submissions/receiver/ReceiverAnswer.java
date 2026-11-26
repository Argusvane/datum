package com.argusvane.datum.submissions.receiver;

import java.util.Objects;
import tools.jackson.databind.node.ObjectNode;

/**
 * A 2xx answer of the receiver; every refusal is an exception the error mapper answers.
 *
 * <ul>
 *   <li>A delivery: 200 {@code {id, reference, status: "accepted", digest, receipt?, warnings?}} (the receipt body of
 *       endpoint catalog {@code submitSubmission}; the browser glue shows {@code receipt}).</li>
 *   <li>A check: 200 {@code {accepted, errors: [{field?, code, message?}], notes?: [{field?, code, severity, message?}]}}
 *       ({@code errors} hold only what blocks, {@code notes} is left out when empty).</li>
 *   <li>A dry run: 200 with the report ({@code outcome} accepted or rejected, the findings, what a delivery
 *       would have stored).</li>
 * </ul>
 *
 * @param status the HTTP status
 * @param body the JSON body
 */
public record ReceiverAnswer(int status, ObjectNode body) {

    public ReceiverAnswer {
        Objects.requireNonNull(body, "body");
    }

    static ReceiverAnswer ok(ObjectNode body) {
        return new ReceiverAnswer(200, body);
    }
}
