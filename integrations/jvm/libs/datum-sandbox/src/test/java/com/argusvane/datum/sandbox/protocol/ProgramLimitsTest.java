package com.argusvane.datum.sandbox.protocol;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.sandbox.wasi.Budget;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;
import org.junit.jupiter.api.Test;

/** ProgramLimits: defaults, set values, bounds, clamping and the warnings for a value not used as set. */
class ProgramLimitsTest {

    private static final long MIB = 1_048_576L;

    private static List<Long> read(ProgramLimits l) {
        return List.of((long) l.validationSeconds(), l.validationMemory(), (long) l.validationConcurrency(), l.maxBodyBytes(),
            (long) l.pdfSeconds(), l.pdfMemory(), (long) l.pdfConcurrency());
    }

    private static ProgramLimits all(Long value) {
        return all(value, new ArrayList<>());
    }

    private static ProgramLimits all(Long value, List<String> warnings) {
        return ProgramLimits.builder().warnings(warnings::add)
            .validationSeconds(value).validationMemory(value).validationConcurrency(value)
            .maxBodyBytes(value).pdfSeconds(value).pdfMemory(value)
            .pdfConcurrency(value).build();
    }

    private static final List<Long> DEFAULTS = List.of(5L, 32 * MIB, 0L, MIB, 15L, 256 * MIB, 0L);

    @Test
    void defaults() {
        ProgramLimits limits = ProgramLimits.defaults();
        assertThat(read(limits)).isEqualTo(DEFAULTS);
        assertThat(limits.validationWait()).isEqualTo(2);
        // Concurrency 0 is one run per CPU.
        assertThat(limits.validationSlots()).isEqualTo(ProgramLimits.cpus());
        assertThat(limits.pdfSlots()).isEqualTo(ProgramLimits.cpus());
        assertThat(ProgramLimits.cpus()).isGreaterThanOrEqualTo(1);
    }

    @Test
    void setValuesAndTheBoundsThemselves() {
        ProgramLimits set = ProgramLimits.builder().validationSeconds(9).validationMemory(64 * MIB).validationConcurrency(3)
            .maxBodyBytes(2 * MIB).pdfSeconds(90).pdfMemory(512 * MIB).pdfConcurrency(3).build();
        assertThat(read(set)).isEqualTo(List.of(9L, 64 * MIB, 3L, 2 * MIB, 90L, 512 * MIB, 3L));
        assertThat(set.pdfBudget()).isEqualTo(new Budget(90, 512 * MIB, 512 * MIB, Budget.STDERR_LIMIT));
        // The largest PDF memory (4 GiB): stdout stops at the longest array, where a buffer can still throw the cap.
        ProgramLimits most = ProgramLimits.builder().pdfMemory(4096 * MIB).build();
        assertThat(most.pdfMemory()).isEqualTo(4096 * MIB);
        assertThat(most.pdfBudget()).isEqualTo(new Budget(ProgramLimits.defaults().pdfSeconds(), 4096 * MIB, Budget.MAX_OUTPUT_CAP, Budget.STDERR_LIMIT));
        assertThat(set.validationSlots()).isEqualTo(3);

        ProgramLimits low = ProgramLimits.builder().validationSeconds(1).validationMemory(4 * MIB).validationConcurrency(1)
            .maxBodyBytes(16384).pdfSeconds(1).pdfMemory(32 * MIB).pdfConcurrency(1).build();
        assertThat(read(low)).isEqualTo(List.of(1L, 4 * MIB, 1L, 16384L, 1L, 32 * MIB, 1L));
        ProgramLimits high = ProgramLimits.builder().validationSeconds(60).validationMemory(1024 * MIB).validationConcurrency(64)
            .maxBodyBytes(64 * MIB).pdfSeconds(300).pdfMemory(4096 * MIB).pdfConcurrency(64).build();
        assertThat(read(high)).isEqualTo(List.of(60L, 1024 * MIB, 64L, 64 * MIB, 300L, 4096 * MIB, 64L));
    }

    /** Values out of range are read as the nearest bound; nonsense as the default; each set value not used warns. */
    @Test
    void clamping() {
        List<String> warnings = new ArrayList<>();
        ProgramLimits clamped = ProgramLimits.builder().warnings(warnings::add)
            .validationSeconds(3600).validationMemory(1024).validationConcurrency(1000).maxBodyBytes(64)
            .pdfSeconds(86400).pdfMemory(MIB).pdfConcurrency(1000).build();
        assertThat(read(clamped)).isEqualTo(List.of(60L, 4 * MIB, 64L, 16384L, 300L, 32 * MIB, 64L));
        assertThat(warnings).hasSize(7).allMatch(w -> w.startsWith("datum limit ") && w.contains("outside"));
        assertThat(warnings.get(0)).isEqualTo("datum limit validationSeconds = 3600 is outside [1, 60]; using 60.");

        // Zero, below zero and unset: the default (for concurrency, one per CPU).
        for (Long nonsense : new Long[] {0L, -5L, null}) {
            assertThat(read(all(nonsense))).as(String.valueOf(nonsense)).isEqualTo(DEFAULTS);
        }

        Function<Long, Long> clamp = v -> ProgramLimits.clamp(v, ProgramLimits.VALIDATION_SECONDS);
        assertThat(clamp.apply(10L)).isEqualTo(10);
        assertThat(clamp.apply(1L)).isEqualTo(1);
        assertThat(clamp.apply(61L)).isEqualTo(60);
        assertThat(clamp.apply(0L)).isEqualTo(5);
        assertThat(clamp.apply(null)).isEqualTo(5);
        assertThat(ProgramLimits.mib(8 * MIB)).isEqualTo("8");
        assertThat(ProgramLimits.mib(524288)).isEqualTo("0.5");
        assertThat(ProgramLimits.mib(1310720)).isEqualTo("1.25");
    }

    /** The wait: 0 is a choice (refuse at once); not a number is the default; within 0 to 10. */
    @Test
    void validationWait() {
        assertThat(ProgramLimits.builder().validationWait(0).build().validationWait()).isZero();
        assertThat(ProgramLimits.builder().validationWait(99).build().validationWait()).isEqualTo(10);
        assertThat(ProgramLimits.builder().validationWait(-3).build().validationWait()).isZero();
        assertThat(ProgramLimits.builder().validationWait((Long) null).build().validationWait()).isEqualTo(2);
        assertThat(ProgramLimits.builder().validationWait(4).build().validationWait()).isEqualTo(4);
    }

    @Test
    void valuesUsedAsSetDoNotWarn() {
        List<String> warnings = new ArrayList<>();
        ProgramLimits.builder().warnings(warnings::add).validationSeconds(9).validationConcurrency(0).validationWait(0).pdfMemory(64L).build();
        assertThat(warnings).hasSize(1);
        assertThat(warnings.get(0)).contains("pdfMemory = 64").contains("using " + 32 * MIB);
        warnings.clear();
        all(null, warnings);
        assertThat(warnings).as("unset is the default, not a warning").isEmpty();
    }

    /** A record built by hand is held to the bounds: nothing reaches a runtime unclamped. */
    @Test
    void theRecordRefusesValuesOutsideTheBounds() {
        ProgramLimits d = ProgramLimits.defaults();
        assertThatThrownBy(() -> new ProgramLimits(0, d.validationMemory(), 0, 2, d.pdfSeconds(), d.pdfMemory(), 0, d.maxBodyBytes()))
            .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("validationSeconds");
        assertThatThrownBy(() -> new ProgramLimits(5, 1, 0, 2, d.pdfSeconds(), d.pdfMemory(), 0, d.maxBodyBytes()))
            .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("validationMemory");
    }

    /** The output caps are what a validation run is held to. */
    @Test
    void aValidationRunIsHeldToTheOutputCaps() {
        Budget validation = ProgramLimits.defaults().validationBudget();
        assertThat(validation.stdoutCap()).isEqualTo(Budget.STDOUT_LIMIT);
        assertThat(validation.stderrCap()).isEqualTo(Budget.STDERR_LIMIT);
    }
}
