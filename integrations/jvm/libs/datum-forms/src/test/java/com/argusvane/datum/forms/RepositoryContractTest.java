package com.argusvane.datum.forms;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.contracts.DefinitionProblem;
import com.argusvane.datum.core.contracts.FormulaProblem;
import java.util.List;
import org.junit.jupiter.api.Test;

/** The kind of a refusal. */
class RepositoryContractTest {

    @Test
    void aVerdictsRefusalsSayWhichListTheyCameFrom() {
        DefinitionVerdict verdict = new DefinitionVerdict("fail",
            List.of(new DefinitionProblem("component.id.duplicate", "root > content > a", "Another component already has this id.", null, null)),
            List.of(),
            List.of(new FormulaProblem("rules:a:visibleWhen", "formula.parse", "error", "Unexpected token.", null, null, null, null, null)),
            List.of());

        List<DefinitionRefusedException.Refusal> refusals = verdict.refusals();

        assertThat(refusals).extracting(DefinitionRefusedException.Refusal::kind)
            .containsExactly(DefinitionRefusedException.Kind.STRUCTURE, DefinitionRefusedException.Kind.FORMULA);
        assertThat(new DefinitionRefusedException.Refusal("c", "w", null, "m").kind()).as("the four-argument form").isEqualTo(DefinitionRefusedException.Kind.STRUCTURE);
        assertThat(new DefinitionRefusedException.Refusal("c", "w", null, "m", null).kind()).isEqualTo(DefinitionRefusedException.Kind.STRUCTURE);
    }
}
