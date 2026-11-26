package com.argusvane.datum.submissions.service;

import java.util.Objects;

/**
 * What a journey's check judges: one page of the journey, or the whole journey.
 *
 * @param scope {@code page} or {@code journey}
 * @param pageId the page a page check judges (an id the journey does not have is refused as malformed when the check
 *     runs, as a page check naming none is); ignored for a journey check
 */
public record JourneyCheck(String scope, String pageId) {

    public static final String PAGE = "page";
    public static final String JOURNEY = "journey";

    public JourneyCheck {
        Objects.requireNonNull(scope, "scope");
        if (!PAGE.equals(scope) && !JOURNEY.equals(scope)) {
            throw new IllegalArgumentException("A check's scope is \"page\" or \"journey\".");
        }
    }

    /** The whole journey the document names (or the form's default one). */
    public static JourneyCheck journey() {
        return new JourneyCheck(JOURNEY, null);
    }

    /** One page of it. */
    public static JourneyCheck page(String pageId) {
        return new JourneyCheck(PAGE, pageId);
    }
}
