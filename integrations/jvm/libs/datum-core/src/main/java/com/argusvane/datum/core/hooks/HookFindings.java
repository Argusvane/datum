package com.argusvane.datum.core.hooks;

import java.util.List;

/**
 * What a {@code *Validator} found after the engine answered: errors refuse the request (each capability
 * answers them in its own 422 shape), warnings ride along with an accepted one where the capability has a place for
 * them (the builder's save answer, the PDF's warnings).
 *
 * @param errors what refuses the request, in order; empty to let it go on
 * @param warnings what the answer carries along, in order
 */
public record HookFindings(List<HookProblem> errors, List<HookProblem> warnings) {

    /** Nothing found. */
    public static final HookFindings NONE = new HookFindings(List.of(), List.of());

    public HookFindings {
        errors = errors == null ? List.of() : List.copyOf(errors);
        warnings = warnings == null ? List.of() : List.copyOf(warnings);
    }

    /** Errors only: the request is refused with them. */
    public static HookFindings errors(HookProblem... errors) {
        return new HookFindings(List.of(errors), List.of());
    }

    /** Warnings only: the request goes on and carries them. */
    public static HookFindings warnings(HookProblem... warnings) {
        return new HookFindings(List.of(), List.of(warnings));
    }

    /** Whether these findings refuse the request. */
    public boolean refuses() {
        return !errors.isEmpty();
    }
}
