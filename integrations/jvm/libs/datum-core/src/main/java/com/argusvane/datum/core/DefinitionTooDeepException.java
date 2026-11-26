package com.argusvane.datum.core;

/**
 * A definition nests past the depth guard (components 32, raw JSON 256) and was refused before any guest
 * started. Same word as the kernel's {@code definition.tooDeep} inspect error.
 *
 * <p>Whose definition it is decides the status. One a caller hands in to be checked or inspected (a builder's save, an
 * operator's {@code POST /inspect}) is that caller's to fix: 422. The registered form a submission is judged by is the
 * server's own, so on the submission, check, dry-run and PDF routes it is a server fault and no judgement of the
 * answers: {@link #registered} makes the 503 the submission service answers (a 422 there
 * would read in a browser as "your answers are wrong").
 */
public class DefinitionTooDeepException extends DatumException {

    private static final long serialVersionUID = 1L;

    private final int limit;

    public DefinitionTooDeepException(int limit, String message) {
        this(limit, message, 422, null);
    }

    private DefinitionTooDeepException(int limit, String message, int status, Throwable cause) {
        super("definition.tooDeep", status, message, cause);
        this.limit = limit;
    }

    /** The same refusal for a registered form the server judges answers by: 503, the original as the cause. */
    public static DefinitionTooDeepException registered(DefinitionTooDeepException deep) {
        if (deep.httpStatus() == 503) {
            return deep;
        }
        return new DefinitionTooDeepException(deep.limit(), deep.getMessage(), 503, deep);
    }

    /** The depth that was exceeded. */
    public int limit() {
        return limit;
    }
}
