package com.argusvane.datum.pdf.api;

import com.argusvane.datum.submissions.spi.SubmissionError;
import java.util.List;
import tools.jackson.databind.node.ObjectNode;

/**
 * Posted answers, judged as a delivery would be and nothing kept: whether the server accepts them and, when it
 * does, the sanitized values (what the form defines, nothing else) a PDF prints.
 *
 * @param accepted whether every check passed
 * @param stage where they were refused ({@code journey}, {@code sandbox}, {@code signature}, {@code server}), or null
 * @param errors the findings
 * @param values the sanitized values when accepted, else null
 */
public record CheckedAnswers(boolean accepted, String stage, List<SubmissionError> errors, ObjectNode values) {

    public CheckedAnswers {
        errors = errors == null ? List.of() : List.copyOf(errors);
    }
}
