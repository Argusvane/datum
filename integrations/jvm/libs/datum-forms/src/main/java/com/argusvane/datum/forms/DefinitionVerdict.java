package com.argusvane.datum.forms;

import com.argusvane.datum.core.contracts.DefinitionProblem;
import com.argusvane.datum.core.contracts.FormulaProblem;
import com.argusvane.datum.core.contracts.InspectCheckAnswer;
import java.util.ArrayList;
import java.util.List;

/**
 * What the kernel's {@code check} op said of a definition. {@code verdict} is the kernel's {@code ok},
 * {@code warn} or {@code fail} under the host's formula
 * policy. A definition that is {@link #refused()} is not saved; {@code structureWarnings} and {@code warnings}
 * never refuse and ride back to the author.
 */
public record DefinitionVerdict(
    String verdict,
    List<DefinitionProblem> structure,
    List<DefinitionProblem> structureWarnings,
    List<FormulaProblem> problems,
    List<FormulaProblem> warnings
) {

    public DefinitionVerdict {
        verdict = verdict == null ? "fail" : verdict;
        structure = orEmpty(structure);
        structureWarnings = orEmpty(structureWarnings);
        problems = orEmpty(problems);
        warnings = orEmpty(warnings);
    }

    static DefinitionVerdict of(InspectCheckAnswer answer) {
        return new DefinitionVerdict(answer.verdict(), answer.structure(), answer.structureWarnings(), answer.problems(), answer.warnings());
    }

    /**
     * Whether the save is refused: any structure problem, or a formula failure (a formula failure refuses
     * the save).
     */
    public boolean refused() {
        return !structure.isEmpty() || "fail".equals(verdict);
    }

    /** The refusals in the kernel's order: the structure problems, then the formula problems. */
    public List<DefinitionRefusedException.Refusal> refusals() {
        List<DefinitionRefusedException.Refusal> out = new ArrayList<>();
        for (DefinitionProblem problem : structure) {
            out.add(new DefinitionRefusedException.Refusal(problem.code(), nullToEmpty(problem.where()), problem.limit(), problem.message(), DefinitionRefusedException.Kind.STRUCTURE));
        }
        for (FormulaProblem problem : problems) {
            out.add(new DefinitionRefusedException.Refusal(problem.code(), nullToEmpty(problem.where()), null, problem.message(), DefinitionRefusedException.Kind.FORMULA));
        }
        if (out.isEmpty() && "fail".equals(verdict)) {
            out.add(new DefinitionRefusedException.Refusal("definition.verdict.fail", "definition", null, "The definition failed its check.", DefinitionRefusedException.Kind.FORMULA));
        }
        return out;
    }

    private static String nullToEmpty(String text) {
        return text == null ? "" : text;
    }

    private static <T> List<T> orEmpty(List<T> list) {
        return list == null ? List.of() : List.copyOf(list);
    }
}
