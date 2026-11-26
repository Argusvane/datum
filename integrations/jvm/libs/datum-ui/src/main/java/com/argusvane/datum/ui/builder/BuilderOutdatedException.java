package com.argusvane.datum.ui.builder;

import com.argusvane.datum.forms.FormOutdatedException;
import com.argusvane.datum.web.EntityTags;
import com.argusvane.datum.web.error.ErrorDetails;
import com.argusvane.datum.web.error.ErrorItem;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 409 {@code form.outdated} for a builder write that builds on a version that is no longer current: another
 * author's save, another tab's (BLD-02; named {@code form.outdated} as the forms module names every 409 of a form).
 * Nothing is stored.
 *
 * <p>The answer says what is current, so the page can offer to reload: the {@code ETag} header and
 * {@code currentSha256} name the current definition hash (or the catalog's etag for a translations save),
 * {@code version} the current definition's version.
 */
public class BuilderOutdatedException extends FormOutdatedException implements ErrorDetails {

    private static final long serialVersionUID = 1L;

    private final String message;
    private final String version;

    private BuilderOutdatedException(String current, String version, String message) {
        super(current);
        this.message = message;
        this.version = version;
    }

    /** The definition moved on: the builder's wording, with its version. */
    public static BuilderOutdatedException definition(String currentSha256, String version) {
        String shown = version == null ? "" : version;
        return new BuilderOutdatedException(currentSha256, version,
            "The form was changed since this page loaded: it is now version " + shown
                + ". Download this copy if you want to keep it, then reload the page to get the current form.");
    }

    /** The translations moved on. */
    public static BuilderOutdatedException catalog(String currentEtag) {
        return new BuilderOutdatedException(currentEtag, null,
            "The translations were changed since this page loaded. Reload the page to get the current ones, then make your changes again.");
    }

    @Override
    public String getMessage() {
        return message;
    }

    @Override
    public List<ErrorItem> errorItems() {
        return List.of(new ErrorItem(null, code(), message));
    }

    @Override
    public Map<String, String> responseHeaders() {
        return currentSha256() == null ? Map.of() : Map.of("ETag", EntityTags.of(currentSha256()));
    }

    @Override
    public Map<String, Object> extraBody() {
        Map<String, Object> extra = new LinkedHashMap<>();
        extra.put("code", code());
        if (currentSha256() != null) {
            extra.put("currentSha256", currentSha256());
        }
        if (version != null) {
            extra.put("version", version);
        }
        return extra;
    }
}
