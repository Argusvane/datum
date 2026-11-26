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
}
