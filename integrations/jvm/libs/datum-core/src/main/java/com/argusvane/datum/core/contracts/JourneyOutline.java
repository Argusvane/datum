package com.argusvane.datum.core.contracts;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/**
 * The server's path through a journey, for the browser's diagnostics.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record JourneyOutline(
    List<String> pages,
    String end
) {
}
