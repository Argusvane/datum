package com.argusvane.datum.core.hooks;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import org.junit.jupiter.api.Test;

/** The hook model's one typed refusal: its kind is the wire's status, its code a safe machine word. */
class HookRefusedExceptionTest {

    @Test
    void eachKindCarriesItsStatusAndTheFirstProblemsCode() {
        assertThat(HookRefusedException.forbidden("tenant.closed", "Closed.").httpStatus()).isEqualTo(403);
        assertThat(HookRefusedException.conflict("tenant.moved", null).httpStatus()).isEqualTo(409);
        HookRefusedException invalid = HookRefusedException.invalid(List.of(HookProblem.at("name", "naming.prefix", "Start with acme-."),
            HookProblem.of("naming.length", "Too long.")));
        assertThat(invalid.httpStatus()).isEqualTo(422);
        assertThat(invalid.kind()).isEqualTo(HookRefusedException.Kind.INVALID);
        assertThat(invalid.code()).isEqualTo("naming.prefix");
        assertThat(invalid.getMessage()).isEqualTo("Start with acme-. Too long.");
        assertThat(invalid.problems()).extracting(HookProblem::field).containsExactly("name", null);
    }

    @Test
    void aCodeIsAMachineWordAndARefusalNamesAProblem() {
        assertThatThrownBy(() -> HookProblem.of("has space", null)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> HookProblem.of("1starts.with.digit", null)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> HookProblem.of("line\nbreak", null)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> HookProblem.of("x".repeat(129), null)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> HookRefusedException.invalid(List.of())).isInstanceOf(IllegalArgumentException.class);
        assertThat(HookProblem.of("a.b_c:d-e", null).code()).isEqualTo("a.b_c:d-e");
    }

    @Test
    void findingsRefuseOnlyWithErrors() {
        assertThat(HookFindings.NONE.refuses()).isFalse();
        assertThat(HookFindings.warnings(HookProblem.of("note", "n")).refuses()).isFalse();
        assertThat(HookFindings.errors(HookProblem.of("bad", "b")).refuses()).isTrue();
        assertThat(new HookFindings(null, null)).isEqualTo(HookFindings.NONE);
    }
}
