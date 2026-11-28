package com.argusvane.datum.forms;

import com.argusvane.datum.core.DatumException;
import java.util.List;

/**
 * The kernel's {@code check} refused a definition: a structure problem, or a formula problem
 * under the {@code fail} policy. Maps to 422; {@link #errors()} is the save route's 422 {@code kernel} list (code,
 * where, limit; endpoint catalog {@code saveForm}) with the message of each finding beside it, in the kernel's order.
 */
public class DefinitionRefusedException extends DatumException {

    private static final long serialVersionUID = 1L;

    /**
     * Which of the kernel's two lists a finding came from. The builder's 422 words the two differently (a structure
     * problem as "message (at where)", a formula problem as "where: message"), so a caller that wants its words needs
     * to know.
     */
    public enum Kind {
        /** A structure problem (the kernel's {@code structure} list). */
        STRUCTURE,
        /** A formula problem under the {@code fail} policy (the kernel's {@code problems} list). */
        FORMULA
    }

    /**
     * One refusal: the kernel's code and path, its limit when it has one, a sentence for the author, and the
     * list it came from.
     */
    public record Refusal(String code, String where, Integer limit, String message, Kind kind) {

        public Refusal {
            kind = kind == null ? Kind.STRUCTURE : kind;
        }

        /** A structure refusal (the kind every refusal had before {@link Kind} existed). */
        public Refusal(String code, String where, Integer limit, String message) {
            this(code, where, limit, message, Kind.STRUCTURE);
        }
    }

    private final transient List<Refusal> errors;

    public DefinitionRefusedException(List<Refusal> errors) {
        super("definition.refused", 422, "The definition was refused: " + describe(errors));
        this.errors = List.copyOf(errors);
    }

    /** The findings that refuse the definition. */
    public List<Refusal> errors() {
        return errors;
    }

    private static String describe(List<Refusal> errors) {
        StringBuilder out = new StringBuilder();
        for (Refusal refusal : errors) {
            if (out.length() > 0) {
                out.append(' ');
            }
            out.append(refusal.where()).append(": ").append(refusal.message() != null ? refusal.message() : refusal.code());
            if (out.length() > 500) {
                out.append(" ...");
                break;
            }
        }
        return out.toString();
    }
}
