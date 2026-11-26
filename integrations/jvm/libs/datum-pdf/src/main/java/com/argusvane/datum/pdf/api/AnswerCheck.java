package com.argusvane.datum.pdf.api;

import com.argusvane.datum.submissions.receiver.ReceiverAnswer;
import com.argusvane.datum.submissions.receiver.SubmissionReceiver;
import com.argusvane.datum.submissions.spi.SubmissionError;
import com.argusvane.datum.submissions.spi.SubmissionMode;
import com.argusvane.datum.submissions.spi.SubmissionRequest;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * Judges posted answers before a PDF prints them (SPI): "validation first, so the PDF prints the sanitized values"
 * (the Java samples' PDF endpoints: only answers the receiver's dry run accepts are rendered).
 * {@link #of(SubmissionReceiver)} is that dry run: datum-submissions' receiver in {@code PDF} mode (secured as the PDF routes are, not as the dry run; no count of its own; the
 * pre-checks asked with the caller's principal), every
 * check of a delivery (version, option snapshot, journey, sandbox, signature check, validators), nothing kept,
 * handed on or published.
 */
@FunctionalInterface
public interface AnswerCheck {

    /**
     * @param request the request view (the receiver applies its own throttle and pre-checks to it)
     * @param body {@code {"document": <the envelope or signed wrapper>}} as JSON bytes
     * @throws com.argusvane.datum.core.DatumException every refusal before a verdict (400, 403, 404, 409,
     *     413, 415, 429, 503), as the receiver throws them
     */
    CheckedAnswers check(SubmissionRequest request, byte[] body);

    /** The receiver's dry run in PDF mode. */
    static AnswerCheck of(SubmissionReceiver receiver) {
        Objects.requireNonNull(receiver, "receiver");
        return (request, body) -> read(receiver.receive(request, body, SubmissionMode.PDF));
    }

    /** The dry run's 200 report read: {@code outcome}, {@code stage}, {@code errors}, {@code values}. */
    static CheckedAnswers read(ReceiverAnswer answer) {
        ObjectNode report = answer.body();
        boolean accepted = "accepted".equals(report.path("outcome").asString("")) && report.path("values").isObject();
        List<SubmissionError> errors = new ArrayList<>();
        for (JsonNode error : report.path("errors").isArray() ? report.path("errors").values() : List.<JsonNode>of()) {
            if (error.isObject() && error.path("code").isString()) {
                errors.add(new SubmissionError(text(error.get("field")), error.path("code").stringValue(), text(error.get("message")),
                    text(error.get("severity")), text(error.get("stage")), text(error.get("source"))));
            }
        }
        String stage = text(report.get("stage"));
        return new CheckedAnswers(accepted, stage, errors, accepted ? (ObjectNode) report.get("values").deepCopy() : null);
    }

    private static String text(JsonNode node) {
        return node != null && node.isString() ? node.stringValue() : null;
    }
}
