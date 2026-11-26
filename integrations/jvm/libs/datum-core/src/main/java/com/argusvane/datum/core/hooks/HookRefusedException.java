package com.argusvane.datum.core.hooks;

import com.argusvane.datum.core.DatumException;
import java.util.List;
import java.util.Objects;
import org.jspecify.annotations.Nullable;

/**
 * An application's hook refusing a request: what a {@code *Customizer} throws instead of letting a request
 * reach the engine or the store, and what a {@code *Validator}'s errors become. It is the one typed refusal of the hook
 * model, so a refusal means the same on every capability; anything else a hook throws fails the request instead (the
 * capability's failure answer: a 500, or a 503 where the capability names one).
 *
 * <p>The {@link Kind} says what kind of "no" it is, not how a transport words it: the HTTP routes answer
 * {@link Kind#FORBIDDEN} 403, {@link Kind#CONFLICT} 409 and {@link Kind#INVALID} 422 with the {@code errors} body (a
 * capability with its own 422 shape, the builder's {@code definition.refused}, answers its problems in that shape),
 * and a non-HTTP caller reads the kind. The timestamp server, whose wire is RFC 3161 and not JSON, answers every kind
 * as a {@code badRequest} rejection. The status a {@link DatumException} carries is that hint for the error mapper.
 */
public final class HookRefusedException extends DatumException {

    private static final long serialVersionUID = 1L;

    /** What kind of refusal: who may not, what clashes, what is not acceptable. */
    public enum Kind {
        /** The caller may not do this (HTTP 403). */
        FORBIDDEN(403),
        /** The request clashes with the state of things (HTTP 409). */
        CONFLICT(409),
        /** The content is not acceptable (HTTP 422, with the problems). */
        INVALID(422);

        private final int status;

        Kind(int status) {
            this.status = status;
        }
    }

    private final Kind kind;
    private final transient List<HookProblem> problems;

    private HookRefusedException(Kind kind, List<HookProblem> problems, @Nullable String message) {
        super(problems.get(0).code(), kind.status, message);
        this.kind = kind;
        this.problems = List.copyOf(problems);
    }

    /** The caller may not do this. */
    public static HookRefusedException forbidden(String code, @Nullable String message) {
        return new HookRefusedException(Kind.FORBIDDEN, List.of(HookProblem.of(code, message)), message);
    }

    /** The request clashes with the state of things. */
    public static HookRefusedException conflict(String code, @Nullable String message) {
        return new HookRefusedException(Kind.CONFLICT, List.of(HookProblem.of(code, message)), message);
    }

    /** The content is not acceptable, for one reason. */
    public static HookRefusedException invalid(String code, @Nullable String message) {
        return new HookRefusedException(Kind.INVALID, List.of(HookProblem.of(code, message)), message);
    }

    /**
     * The content is not acceptable, for these reasons (a validator's errors). The refusal's code is the first
     * problem's.
     *
     * @throws IllegalArgumentException for no problem
     */
    public static HookRefusedException invalid(List<HookProblem> problems) {
        Objects.requireNonNull(problems, "problems");
        if (problems.isEmpty()) {
            throw new IllegalArgumentException("A refusal names at least one problem.");
        }
        StringBuilder words = new StringBuilder();
        for (HookProblem problem : problems) {
            if (problem.message() == null) {
                continue;
            }
            if (words.length() > 0) {
                words.append(' ');
            }
            words.append(problem.message());
            if (words.length() > 500) {
                break;
            }
        }
        return new HookRefusedException(Kind.INVALID, problems, words.length() == 0 ? null : words.toString());
    }

    /** What kind of refusal. */
    public Kind kind() {
        return kind;
    }

    /** What the hook found, in order (one entry for a forbidden or conflicting request). */
    public List<HookProblem> problems() {
        return problems;
    }
}
