package com.argusvane.datum.submissions.receiver;

import com.argusvane.datum.forms.FormOutdatedException;
import com.argusvane.datum.web.error.ErrorDetails;
import com.argusvane.datum.web.error.ErrorItem;
import java.util.List;

/**
 * The document was answered on a version of the form that is no longer current: 409 {@code form.outdated}
 * (REC-06), which the page answers with "Reload and keep my answers".
 *
 * <p>The answer names no hash. The current definition's hash
 * ({@link #currentSha256()}) is the FULL definition's, server-secret rules included, which datum-forms serves only
 * to a builder: on a filler's route it would confirm a guess of the secret rules and show when they change, and
 * the page reloads by the form's key anyway. It stays on the exception for the application's own handling.
 * Nothing goes in the body either: the security suite's wire rule (SEC-05) allows nothing beside {@code errors}
 * in a refusal of a POST.
 */
public class SubmissionOutdatedException extends FormOutdatedException implements ErrorDetails {

    private static final long serialVersionUID = 1L;

    public SubmissionOutdatedException(String currentSha256) {
        super(currentSha256);
    }

    @Override
    public List<ErrorItem> errorItems() {
        return List.of(new ErrorItem(null, "form.outdated", "This form changed while it was open. Reload it: your answers are kept."));
    }
}
