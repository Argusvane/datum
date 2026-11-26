package com.argusvane.datum.springweb.support;

import com.argusvane.datum.core.DatumException;
import com.argusvane.datum.web.error.ErrorDetails;
import com.argusvane.datum.web.error.ErrorItem;
import java.util.List;
import java.util.Map;

/** A capability-style exception: a 422 with field errors, a header and an extra body member. */
public class RejectedException extends DatumException implements ErrorDetails {

    private static final long serialVersionUID = 1L;

    public RejectedException() {
        super("submission.rejected", 422, "rejected");
    }

    @Override
    public List<ErrorItem> errorItems() {
        return List.of(new ErrorItem("email", "required", null), new ErrorItem(null, "form.outdated", "Reload."));
    }

    @Override
    public Map<String, String> responseHeaders() {
        return Map.of("X-Test", "yes");
    }

    @Override
    public Map<String, Object> extraBody() {
        return Map.of("currentSha256", "abc");
    }
}
