package com.argusvane.datum.submissions.receiver;

import com.argusvane.datum.core.DatumException;
import com.argusvane.datum.submissions.spi.SubmissionError;
import com.argusvane.datum.web.error.ErrorDetails;
import com.argusvane.datum.web.error.ErrorItem;
import java.util.List;
import java.util.Objects;

/**
 * A delivery refused for its content: 422 {@code {errors: [{field, code, message?}]}}, the shape the browser
 * maps with {@code setErrors()} (no severity on the wire, every finding of the verdict listed, warnings included:
 * the endpoint catalog's error entry).
 */
public class SubmissionRejectedException extends DatumException implements ErrorDetails {

    private static final long serialVersionUID = 1L;

    /** The code of a rejection whose verdict listed no finding (the kernel kept no values and said nothing). */
    public static final String CODE = "submission.rejected";

    private final String stage;
    private final transient List<SubmissionError> errors;

    /**
     * @param stage {@code journey}, {@code sandbox}, {@code signature} or {@code server}
     * @param errors the verdict's findings
     */
    public SubmissionRejectedException(String stage, List<SubmissionError> errors) {
        super(CODE, 422, "The submission was not accepted.");
        this.stage = Objects.requireNonNull(stage, "stage");
        this.errors = List.copyOf(errors);
    }

    /** Where it was refused. */
    public String stage() {
        return stage;
    }

    /** The findings. */
    public List<SubmissionError> errors() {
        return errors;
    }

    @Override
    public List<ErrorItem> errorItems() {
        return errors.stream().map(error -> new ErrorItem(error.field(), error.code(), error.message())).toList();
    }
}
