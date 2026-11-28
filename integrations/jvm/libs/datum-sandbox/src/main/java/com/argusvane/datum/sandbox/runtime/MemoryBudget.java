package com.argusvane.datum.sandbox.runtime;

import com.argusvane.datum.core.DatumStartupCheck;
import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import java.lang.management.ManagementFactory;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.OptionalLong;
import java.util.function.Supplier;

/**
 * Whether the sandbox slots fit the memory this JVM may use (integrations/jvm/README.md "Libraries and bindings"), in two
 * figures, each one WARN when it does not fit. It changes nothing: the slots and budgets stay what the operator set.
 *
 * <ul>
 *   <li><b>Native memory.</b> Each native run's WebAssembly memory lives outside the Java heap, so a container sized for the
 *       heap alone is killed by the kernel (no Java error, no log) when every slot fills at once. The check compares
 *       validation slots x the validation memory budget plus PDF slots x the PDF memory budget with what the JDK reports as
 *       the memory available to the process ({@code OperatingSystemMXBean#getTotalMemorySize}) less the heap's maximum.</li>
 *   <li><b>The heap.</b> Every run in flight also takes heap while its instance is set up and run: {@link #SETUP_HEAP} per
 *       slot, and, when the engine runs as bytecode, its linear memory too (the memory budget, on the heap there). The check
 *       compares every slot's share with the heap's maximum ({@code Runtime.maxMemory()}). A heap that runs out mid-run fails
 *       closed (the harness reports it as a host interruption, a 503), but every run in flight fails with it, not only one.</li>
 * </ul>
 *
 * <p>The available memory is the container's limit when the JVM runs under one (the JDK reads its own cgroup), and the host's
 * physical RAM when no limit applies; the JDK does not say which, so the WARN names both readings. On a bare host a
 * warning means the slots exceed the machine's RAM, and a silent start does not prove a container limit exists. A runtime without
 * {@code jdk.management} (a jlinked image) reports nothing and the native check stays silent; the heap check needs no such
 * module.
 *
 * <p>Neither figure counts a run's output, which the run's bounded streams hold on the heap up to its caps (32 MiB of stdout for
 * a validation, the memory budget for a PDF): a run reaches them only by writing that much, which an ordinary answer is far
 * from, so counting every slot at its caps would warn on every ordinary deployment. The streams never hold more than the caps
 * ({@link com.argusvane.datum.sandbox.wasi.BoundedOutputStream}).
 */
public final class MemoryBudget {

    private static final long MIB = ProgramLimits.MIB;

    /**
     * The heap one run in flight is counted for, beside its linear memory: 16 MiB. What one run allocates on the heap from
     * its set-up to its answer bounds what it can hold there at once, and on Endive 1.2.0 with quickjs-ng 0.16.2 that is
     * under 8 MiB a run on the Panama runner and under 2 MiB on JFFI, the sandbox program's copy in the run's file system
     * included (measured on warm runs of the real sandbox program; 32 such runs set up at once fitted in 24 MiB more heap
     * than one run needs). Twice the larger figure leaves room for another platform and a larger program. What the
     * engine loads once per JVM (the native code, about 80 MiB of allocation on the first run) is the application's
     * fixed heap, not a slot's.
     */
    public static final long SETUP_HEAP = 16 * MIB;

    private MemoryBudget() {
    }

    /**
     * What the slots may hold at once.
     *
     * @param validationSlots  validation runs at once
     * @param validationMemory the memory budget of one validation run, in bytes
     * @param pdfSlots         PDF runs at once
     * @param pdfMemory        the memory budget of one PDF run, in bytes
     * @param memoryOnHeap     whether the engine keeps the linear memory on the Java heap (bytecode) rather than off it
     */
    public record Use(int validationSlots, long validationMemory, int pdfSlots, long pdfMemory, boolean memoryOnHeap) {

        /** A native engine's use: the linear memory off the heap. */
        public Use(int validationSlots, long validationMemory, int pdfSlots, long pdfMemory) {
            this(validationSlots, validationMemory, pdfSlots, pdfMemory, false);
        }

        /** The bytes of linear memory every slot full at once may use. */
        public long bytes() {
            return validationSlots * validationMemory + pdfSlots * pdfMemory;
        }

        /** The native bytes every slot full at once may use: the linear memory, unless it is on the heap. */
        public long nativeBytes() {
            return memoryOnHeap ? 0 : bytes();
        }

        /** The heap every slot in flight at once may take: {@link #SETUP_HEAP} each, and the linear memory when it is on the heap. */
        public long heapBytes() {
            return (long) (validationSlots + pdfSlots) * SETUP_HEAP + (memoryOnHeap ? bytes() : 0);
        }
    }

    /**
     * The WARNs for a use this JVM cannot hold: none, one or both of the native and the heap figure.
     *
     * @param heapMax         the heap's maximum ({@code Runtime.maxMemory()})
     * @param availableMemory the memory the JVM may use (container limit, else host RAM), or empty when unknown
     */
    public static List<String> warnings(Use use, long heapMax, OptionalLong availableMemory) {
        List<String> warnings = new ArrayList<>(2);
        check(use, heapMax, availableMemory).ifPresent(warnings::add);
        heapCheck(use, heapMax).ifPresent(warnings::add);
        return List.copyOf(warnings);
    }

    /**
     * The WARN for linear memory the available memory cannot hold beside the heap, or none.
     *
     * @param heapMax         the heap's maximum ({@code Runtime.maxMemory()})
     * @param availableMemory the memory the JVM may use (container limit, else host RAM), or empty when unknown
     */
    public static Optional<String> check(Use use, long heapMax, OptionalLong availableMemory) {
        if (availableMemory.isEmpty() || use.memoryOnHeap()) {
            return Optional.empty();
        }
        long limit = availableMemory.getAsLong();
        long left = Math.max(0, limit - heapMax);
        if (use.nativeBytes() <= left) {
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
     * The WARN for slots whose runs in flight the heap cannot hold, or none.
     *
     * @param heapMax the heap's maximum ({@code Runtime.maxMemory()})
     */
    public static Optional<String> heapCheck(Use use, long heapMax) {
        if (use.heapBytes() <= heapMax) {
            return Optional.empty();
        }
        int slots = use.validationSlots() + use.pdfSlots();
        String memory = use.memoryOnHeap()
            ? " plus their linear memory, which this engine keeps on the heap (" + use.bytes() / MIB + " MiB)"
            : "";
        return Optional.of("Datum: the sandbox slots may take up to " + use.heapBytes() / MIB + " MiB of heap at once ("
            + slots + " slots x " + SETUP_HEAP / MIB + " MiB to set up and run an instance" + memory + "), more than the heap's"
            + " maximum of " + heapMax / MIB + " MiB, before the application's own heap. When every slot fills, the heap may run"
            + " out and every run in flight fails (503). Raise -Xmx, or lower datum.runtime.validation.concurrency or"
            + " datum.runtime.pdf.concurrency.");
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
        return startupCheck(runtime, limits, availableMemory, () -> Runtime.getRuntime().maxMemory());
    }

    /** As above with the heap's maximum supplied too (tests fake both figures). */
    static DatumStartupCheck startupCheck(DatumSandbox runtime, ProgramLimits limits, Supplier<OptionalLong> availableMemory,
                                          Supplier<Long> heapMax) {
        return () -> {
            Use use = new Use(runtime.validationSlots().size(), limits.validationMemory(), runtime.pdfSlots().size(), limits.pdfMemory(),
                runtime.engineInfo().isBytecode());
            return warnings(use, heapMax.get(), availableMemory.get()).stream()
                .map(message -> DatumStartupCheck.Notice.warn(MemoryBudget.class, message))
                .toList();
        };
    }
}
