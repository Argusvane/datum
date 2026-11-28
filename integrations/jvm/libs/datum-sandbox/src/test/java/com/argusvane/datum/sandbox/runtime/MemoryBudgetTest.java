package com.argusvane.datum.sandbox.runtime;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.OptionalLong;
import org.junit.jupiter.api.Test;

/** The memory check (integrations/jvm/README.md "Libraries and bindings") over the JDK's available-memory figure. */
class MemoryBudgetTest {

    private static final long MIB = 1_048_576L;

    @Test
    void slotsThatFitBesideTheHeapSayNothing() {
        MemoryBudget.Use use = new MemoryBudget.Use(4, 32 * MIB, 2, 256 * MIB);
        assertThat(use.bytes()).isEqualTo(640 * MIB);
        assertThat(MemoryBudget.check(use, 1024 * MIB, OptionalLong.of(2048 * MIB))).isEmpty();
        assertThat(MemoryBudget.check(use, 1024 * MIB, OptionalLong.of(1664 * MIB))).as("exactly full").isEmpty();
        assertThat(MemoryBudget.check(use, 1024 * MIB, OptionalLong.empty())).as("unknown memory").isEmpty();
    }

    @Test
    void slotsThatDoNotFitAreOneWarnNamingTheNumbersAndTheProperties() {
        MemoryBudget.Use use = new MemoryBudget.Use(8, 32 * MIB, 2, 256 * MIB);
        String warn = MemoryBudget.check(use, 768 * MIB, OptionalLong.of(1024 * MIB)).orElseThrow();
        assertThat(warn).contains("768 MiB of native memory").contains("8 validation slots x 32 MiB").contains("2 PDF slots x 256 MiB")
            .contains("the 1024 MiB available to this JVM").contains("maximum of 768 MiB (256 MiB)").contains("datum.runtime.pdf.concurrency");
        assertThat(MemoryBudget.check(use, 2048 * MIB, OptionalLong.of(1024 * MIB)).orElseThrow()).as("a heap above the limit leaves 0")
            .contains("(0 MiB)");
    }

    @Test
    void theJdkReportsTheMemoryAvailableToThisJvm() {
        assertThat(MemoryBudget.availableMemory()).isPresent();
        assertThat(MemoryBudget.availableMemory().getAsLong()).isPositive();
    }

    @Test
    void theWarnNamesTheContainerLimitOrHostRamAndAFakedFigureDrivesTheStartupCheck() {
        MemoryBudget.Use use = new MemoryBudget.Use(8, 32 * MIB, 2, 256 * MIB);
        String warn = MemoryBudget.check(use, 768 * MIB, OptionalLong.of(1024 * MIB)).orElseThrow();
        assertThat(warn).contains("the host's RAM when no container limit applies");
        long heap = Runtime.getRuntime().maxMemory();
        // A faked figure far above heap plus use: silent. One just under the heap: the WARN, with the faked figure in it.
        assertThat(MemoryBudget.check(use, heap, OptionalLong.of(heap + use.bytes()))).isEmpty();
        assertThat(MemoryBudget.check(use, heap, OptionalLong.of(heap + use.bytes() - 1))).isPresent();
    }

    /** Every slot in flight takes the set-up heap; a heap that cannot hold them all is one WARN of its own. */
    @Test
    void aHeapThatCannotHoldEverySlotsSetUpIsOneWarn() {
        assertThat(MemoryBudget.SETUP_HEAP).isEqualTo(16 * MIB);
        MemoryBudget.Use use = new MemoryBudget.Use(8, 32 * MIB, 2, 256 * MIB);
        assertThat(use.heapBytes()).isEqualTo(10 * 16 * MIB);
        assertThat(MemoryBudget.heapCheck(use, 160 * MIB)).as("exactly full").isEmpty();
        String warn = MemoryBudget.heapCheck(use, 160 * MIB - 1).orElseThrow();
        assertThat(warn).contains("160 MiB of heap").contains("10 slots x 16 MiB").contains("heap's maximum of 159 MiB")
            .contains("-Xmx").contains("datum.runtime.validation.concurrency");
        // Native memory to spare does not make up for a small heap, nor a large heap for too little native memory.
        assertThat(MemoryBudget.warnings(use, 128 * MIB, OptionalLong.of(64_000 * MIB))).singleElement().asString().contains("of heap");
        assertThat(MemoryBudget.warnings(use, 1024 * MIB, OptionalLong.of(1024 * MIB))).singleElement().asString().contains("native memory");
        assertThat(MemoryBudget.warnings(use, 128 * MIB, OptionalLong.of(512 * MIB))).hasSize(2);
        assertThat(MemoryBudget.warnings(use, 1024 * MIB, OptionalLong.of(4096 * MIB))).isEmpty();
    }

    /** Under bytecode the linear memory is on the heap: it counts there, and not as native memory. */
    @Test
    void aBytecodeEnginesLinearMemoryCountsOnTheHeap() {
        MemoryBudget.Use use = new MemoryBudget.Use(4, 32 * MIB, 0, 256 * MIB, true);
        assertThat(use.nativeBytes()).isZero();
        assertThat(use.heapBytes()).isEqualTo(4 * 16 * MIB + 4 * 32 * MIB);
        assertThat(MemoryBudget.check(use, 1024 * MIB, OptionalLong.of(1024 * MIB))).as("nothing native to fit").isEmpty();
        assertThat(MemoryBudget.heapCheck(use, 191 * MIB).orElseThrow()).contains("192 MiB of heap").contains("keeps on the heap (128 MiB)");
        assertThat(MemoryBudget.heapCheck(use, 192 * MIB)).isEmpty();
    }

    /** The start-up check reads the runtime's real slots and its engine's mode. */
    @Test
    void theStartupCheckReadsTheSlotsAndTheEnginesMode() {
        com.argusvane.datum.sandbox.protocol.ProgramLimits limits = com.argusvane.datum.sandbox.protocol.ProgramLimits.defaults();
        OptionalLong plenty = OptionalLong.of(1L << 50);
        try (DatumSandbox sandbox = sandbox(new TestRuntime(), limits)) {
            long slots = sandbox.validationSlots().size() + sandbox.pdfSlots().size();
            assertThat(MemoryBudget.startupCheck(sandbox, limits, () -> plenty, () -> slots * MemoryBudget.SETUP_HEAP).check()).isEmpty();
            assertThat(MemoryBudget.startupCheck(sandbox, limits, () -> plenty, () -> slots * MemoryBudget.SETUP_HEAP - 1).check())
                .singleElement().satisfies(notice -> assertThat(notice.message()).contains(slots + " slots x 16 MiB"));
        }
        TestRuntime bytecode = new TestRuntime();
        bytecode.mode = "bytecode";
        try (DatumSandbox sandbox = sandbox(bytecode, limits)) {
            long slots = sandbox.validationSlots().size() + sandbox.pdfSlots().size();
            assertThat(MemoryBudget.startupCheck(sandbox, limits, () -> plenty, () -> slots * MemoryBudget.SETUP_HEAP).check())
                .as("the bytecode engine's linear memory is on the heap").singleElement()
                .satisfies(notice -> assertThat(notice.message()).contains("keeps on the heap"));
        }
    }

    private static DatumSandbox sandbox(TestRuntime engine, com.argusvane.datum.sandbox.protocol.ProgramLimits limits) {
        return DatumSandbox.builder().runtime(engine).store(Programs.packaged().store()).limits(limits)
            .hostOptions(com.argusvane.datum.sandbox.protocol.HostOptions.defaults())
            .settings(TestSettings.of("endive", true, 0, java.time.Duration.ofSeconds(1), 1, java.time.Duration.ZERO)).build();
    }
}
