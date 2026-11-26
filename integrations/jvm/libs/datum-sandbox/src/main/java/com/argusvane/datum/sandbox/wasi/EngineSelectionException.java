package com.argusvane.datum.sandbox.wasi;

import java.util.List;

/**
 * No engine can be used for the id asked for: none has it, the one that has it is unavailable here, or two claim it.
 * The message names the provider's reason and every engine found, so the fix is in the log line that stops the start; a
 * host binding prints it as it is (Spring Boot: {@code EngineSelectionFailureAnalyzer}), so it is not translated.
 */
public final class EngineSelectionException extends WasiException {

    private static final long serialVersionUID = 1L;

    private final String requested;
    private final transient List<GuestRuntimes.Found> found;

    EngineSelectionException(String requested, List<GuestRuntimes.Found> found, String message) {
        super(message);
        this.requested = requested;
        this.found = List.copyOf(found);
    }

    /** The id asked for, as given. */
    public String requested() {
        return requested;
    }

    /** What the class path holds: every provider, available or not, and every entry that could not be loaded. */
    public List<GuestRuntimes.Found> found() {
        return found;
    }
}
