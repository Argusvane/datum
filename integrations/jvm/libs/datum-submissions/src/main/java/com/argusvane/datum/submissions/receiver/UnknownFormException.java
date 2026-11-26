package com.argusvane.datum.submissions.receiver;

import com.argusvane.datum.forms.FormNotFoundException;
import com.argusvane.datum.web.error.ErrorDetails;
import com.argusvane.datum.web.error.ErrorItem;
import java.util.List;

/**
 * The document names no form this host has: 404 {@code form.notFound} with fixed words. The id comes from the
 * posted body, so the answer never repeats it (a reflected text in an error body, and words such as
 * "Exception" that the conformance suite's SEC-05 reads as a leak). {@link #key()} is empty.
 */
public class UnknownFormException extends FormNotFoundException implements ErrorDetails {

    private static final long serialVersionUID = 1L;

    /** The words of the answer. */
    public static final String MESSAGE = "There is no such form.";

    public UnknownFormException() {
        super("");
    }

    @Override
    public String getMessage() {
        return MESSAGE;
    }

    @Override
    public List<ErrorItem> errorItems() {
        return List.of(new ErrorItem(null, "form.notFound", MESSAGE));
    }
}
