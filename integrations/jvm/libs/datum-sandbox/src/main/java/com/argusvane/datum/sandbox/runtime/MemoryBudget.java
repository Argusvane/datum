package com.argusvane.datum.sandbox.runtime;

import com.argusvane.datum.core.DatumStartupCheck;
import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import java.lang.management.ManagementFactory;
import java.util.List;
import java.util.Optional;
import java.util.OptionalLong;
import java.util.function.Supplier;

/**
 * Whether the sandbox slots fit the memory this JVM may use (integrations/jvm/README.md "Libraries and bindings"). Each native run's WebAssembly memory lives outside the Java heap, so a container sized for the heap alone
 * is killed by the kernel (no Java error, no log) when every slot fills at once. At start the check compares
 * validation slots x the validation memory budget plus PDF slots x the PDF memory budget with what the JDK reports
 * as the memory available to the process ({@code OperatingSystemMXBean#getTotalMemorySize}) less the heap's maximum,
 * and says so in one WARN.
 *
 * <p>That figure is the container's limit when the JVM runs under one (the JDK reads its own cgroup), and the host's
 * physical RAM when no limit applies; the JDK does not say which, so the WARN names both readings. On a bare host a
 * warning means the slots exceed the machine's RAM, and a silent start does not prove a container limit exists. A runtime without
 * {@code jdk.management} (a jlinked image) reports nothing and the check stays silent. It changes nothing: the slots
 * and budgets stay what the operator set.
 */
public final class MemoryBudget {

    private static final long MIB = ProgramLimits.MIB;

    private MemoryBudget() {
    }

    /**
     * What the slots may hold at once.
     *
     * @param validationSlots  validation runs at once
     * @param validationMemory the memory budget of one validation run, in bytes
     * @param pdfSlots         PDF runs at once
     * @param pdfMemory        the memory budget of one PDF run, in bytes
     */
    public record Use(int validationSlots, long validationMemory, int pdfSlots, long pdfMemory) {

        /** The bytes every slot full at once may use. */
        public long bytes() {
            return validationSlots * validationMemory + pdfSlots * pdfMemory;
        }
    }

    /**
     * The WARN for a use the available memory cannot hold beside the heap, or none.
     *
     * @param heapMax         the heap's maximum ({@code Runtime.maxMemory()})
     * @param availableMemory the memory the JVM may use (container limit, else host RAM), or empty when unknown
     */
    public static Optional<String> check(Use use, long heapMax, OptionalLong availableMemory) {
        if (availableMemory.isEmpty()) {
            return Optional.empty();
        }
        long limit = availableMemory.getAsLong();
        long left = Math.max(0, limit - heapMax);
        if (use.bytes() <= left) {
            return Optional.empty();
        }
        return Optional.of("Datum: the sandbox slots may use up to " + use.bytes() / MIB + " MiB of native memory at once ("
            + use.validationSlots() + " validation slots x " + use.validationMemory() / MIB + " MiB + " + use.pdfSlots()
            + " PDF slots x " + use.pdfMemory() / MIB + " MiB), more than the " + limit / MIB + " MiB available to this JVM"
            + " (the container's memory limit, or the host's RAM when no container limit applies) leaves beside the heap's maximum of "
            + heapMax / MIB + " MiB (" + left / MIB + " MiB). When every slot fills, the kernel may stop the process without a"
            + " Java error. Lower datum.runtime.validation.concurrency, datum.runtime.pdf.concurrency or their memory budgets,"
            + " lower -Xmx, or give the container more memory.");
    }

    /**
     * The memory available to this JVM as the JDK reports it: the container's limit, else the host's RAM; empty
     * when the runtime has no {@code jdk.management} to ask.
     */
    public static OptionalLong availableMemory() {
        try {
            if (ManagementFactory.getOperatingSystemMXBean() instanceof com.sun.management.OperatingSystemMXBean os) {
                long total = os.getTotalMemorySize();
                return total > 0 ? OptionalLong.of(total) : OptionalLong.empty();
            }
        } catch (LinkageError | SecurityException e) {
            // A jlinked runtime without the module: the check has nothing to compare with.
        }
        return OptionalLong.empty();
    }

    /** The start-up check over a runtime's real slots and the budgets, this JVM's heap and the memory the JDK reports. */
    public static DatumStartupCheck startupCheck(DatumSandbox runtime, ProgramLimits limits) {
        return startupCheck(runtime, limits, MemoryBudget::availableMemory);
    }

    /** As above with the available memory supplied (tests fake the JDK's figure). */
    public static DatumStartupCheck startupCheck(DatumSandbox runtime, ProgramLimits limits, Supplier<OptionalLong> availableMemory) {
        return () -> {
            Use use = new Use(runtime.validationSlots().size(), limits.validationMemory(), runtime.pdfSlots().size(), limits.pdfMemory());
            return check(use, Runtime.getRuntime().maxMemory(), availableMemory.get())
                .map(message -> List.of(DatumStartupCheck.Notice.warn(MemoryBudget.class, message)))
                .orElse(List.of());
        };
    }
}
