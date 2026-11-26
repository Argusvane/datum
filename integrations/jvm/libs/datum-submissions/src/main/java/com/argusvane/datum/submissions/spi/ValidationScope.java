package com.argusvane.datum.submissions.spi;

import java.util.List;
import java.util.Objects;

/**
 * What a validator is judging: a delivery, or a journey's page or whole journey.
 *
 * @param kind {@code submission} (a delivery or a dry run), {@code page} or {@code journey} (a journey's check)
 * @param journeyId the journey the answers were given through, from the server's definition, or null
 * @param pageId the page a page check judges, or null
 * @param componentIds the components a page check answers for (the kernel's {@code pageComponentIds}), or null
 * @param test true for a dry run: a validator with side effects skips them
 */
public record ValidationScope(String kind, String journeyId, String pageId, List<String> componentIds, boolean test) {

    public ValidationScope {
        Objects.requireNonNull(kind, "kind");
        componentIds = componentIds == null ? null : List.copyOf(componentIds);
    }
}
