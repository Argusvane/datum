package com.argusvane.datum.sandbox.protocol;

import com.argusvane.datum.sandbox.wasi.Budget;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.Objects;
import java.util.function.Consumer;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The budgets of the programs the server runs, within the bounds below.
 *
 * <p>Every reader goes through here, so a value that is missing or out of range never reaches a runtime or a
 * size check as it is: a missing or zero value is the default, and one out of range is the nearest bound. Each
 * value that is set but not used as set is logged once at WARN when the limits are built (a documented safety
 * clamp; the host binding decides whether any of them should fail the start instead).
 *
 * <ul>
 *   <li>Validation (the sandbox program): {@code validationSeconds}, {@code validationMemory} per run,
 *       {@code validationConcurrency} runs at once (0: one per CPU) and {@code validationWait} seconds a run
 *       waits for a free slot (0 refuses at once).</li>
 *   <li>PDF generation: {@code pdfSeconds}, {@code pdfMemory}, {@code pdfConcurrency} (0: one per CPU).</li>
 *   <li>Sizes: {@code maxBodyBytes} (the PDF verify route's own cap is datum-pdf's {@code PdfSettings}). Fields that nothing read (a definition size, an
 *       attachment size, server-draft caps) are not here; the builder's own cap is
 *       {@code datum.builder.max-definition-size}.</li>
 * </ul>
 */
public record ProgramLimits(
    int validationSeconds,
    long validationMemory,
    int validationConcurrency,
    int validationWait,
    int pdfSeconds,
    long pdfMemory,
    int pdfConcurrency,
    long maxBodyBytes
) {

    private static final Logger LOG = LoggerFactory.getLogger(ProgramLimits.class);

    /** One mebibyte. */
    public static final long MIB = 1_048_576L;

    /** A setting's smallest, largest and default value. */
    public record Bounds(long min, long max, long defaultValue) {
    }

    /** Seconds one validation may take: 1 to 60, default 5. */
    public static final Bounds VALIDATION_SECONDS = new Bounds(1, 60, 5);
    /** Bytes of memory one validation may use: 4 MiB to 1 GiB, default 32 MiB. */
    public static final Bounds VALIDATION_MEMORY = new Bounds(4 * MIB, 1024 * MIB, 32 * MIB);
    /**
     * Validation runs at once: up to 64, default 0 (one per CPU). A run
     * holds a request thread and up to the memory budget, so a flood of submissions could start as many as
     * there are threads.
     */
    public static final Bounds VALIDATION_CONCURRENCY = new Bounds(0, 64, 0);
    /** Seconds a run waits for a free validation slot: 0 to 10, default 2. */
    public static final Bounds VALIDATION_WAIT = new Bounds(0, 10, 2);
    /** Seconds one PDF render may take: 1 to 300, default 15. */
    public static final Bounds PDF_SECONDS = new Bounds(1, 300, 15);
    /** Bytes of memory one PDF render may use: 32 MiB to 4 GiB, default 256 MiB. */
    public static final Bounds PDF_MEMORY = new Bounds(32 * MIB, 4096 * MIB, 256 * MIB);
    /** PDF renders at once: up to 64, default 0 (one per CPU). */
    public static final Bounds PDF_CONCURRENCY = new Bounds(0, 64, 0);
    /** The largest submission body: 16 KiB to 64 MiB, default 1 MiB. */
    public static final Bounds BODY_BYTES = new Bounds(16 * 1024, 64 * MIB, MIB);

    public ProgramLimits {
        // A record built directly is held to the bounds as well: nothing reaches a runtime unclamped.
        check("validationSeconds", validationSeconds, VALIDATION_SECONDS);
        check("validationMemory", validationMemory, VALIDATION_MEMORY);
        check("validationConcurrency", validationConcurrency, VALIDATION_CONCURRENCY);
        check("validationWait", validationWait, VALIDATION_WAIT);
        check("pdfSeconds", pdfSeconds, PDF_SECONDS);
        check("pdfMemory", pdfMemory, PDF_MEMORY);
        check("pdfConcurrency", pdfConcurrency, PDF_CONCURRENCY);
        check("maxBodyBytes", maxBodyBytes, BODY_BYTES);
    }

    /** Every default: what a site that set nothing runs with. */
    public static ProgramLimits defaults() {
        return builder().build();
    }

    /** A builder taking typed values, clamped by {@link Builder#build()}. */
    public static Builder builder() {
        return new Builder();
    }

    /** The budget of one validation or inspect run: the validation time and memory, 32 MiB / 64 KiB of output. */
    public Budget validationBudget() {
        return new Budget(validationSeconds, validationMemory, Budget.STDOUT_LIMIT, Budget.STDERR_LIMIT);
    }

    /**
     * The budget of one PDF run. The wire caps no PDF output; a runtime that buffers it must, so stdout is
     * capped at the memory budget (the answer is a string the guest held in that memory), but never above
     * {@link Budget#MAX_OUTPUT_CAP} (a buffer stops near 2 GiB while {@code pdfMemory} may be 4 GiB, so a
     * larger cap could never trigger), and stderr at 64 KiB.
     */
    public Budget pdfBudget() {
        return new Budget(pdfSeconds, pdfMemory, Math.min(pdfMemory, Budget.MAX_OUTPUT_CAP), Budget.STDERR_LIMIT);
    }

    /** Validation slots: the setting, or the CPUs this JVM may use when it is 0. */
    public int validationSlots() {
        return validationConcurrency > 0 ? validationConcurrency : cpus();
    }

    /** PDF slots: the setting, or the CPUs this JVM may use when it is 0. */
    public int pdfSlots() {
        return pdfConcurrency > 0 ? pdfConcurrency : cpus();
    }

    /**
     * The CPUs this JVM may use, at least one. The JVM already reads the container's quota and the CPUs the
     * process is pinned to, so nothing reads them by hand.
     */
    public static int cpus() {
        return Math.max(1, Runtime.getRuntime().availableProcessors());
    }

    /**
     * A setting within its bounds.
     *
     * @return the default when the value is missing or not above 0 (a zero or negative budget is no value);
     *     otherwise the value, raised or lowered to the nearest bound
     */
    public static long clamp(@Nullable Long value, Bounds bounds) {
        if (value == null || value <= 0) {
            return bounds.defaultValue();
        }
        return Math.max(bounds.min(), Math.min(bounds.max(), value));
    }

    /** A concurrency setting: 0 (one per CPU) unless a number above 0, then at most the bound's max. */
    public static long concurrency(@Nullable Long value, Bounds bounds) {
        if (value == null || value <= 0) {
            return 0;
        }
        return Math.min(value, bounds.max());
    }

    /** The wait setting: 0 is a choice here (refuse at once), unlike {@link #clamp}'s "unset". */
    public static long waitSeconds(@Nullable Long value) {
        return value == null ? VALIDATION_WAIT.defaultValue() : Math.max(VALIDATION_WAIT.min(), Math.min(VALIDATION_WAIT.max(), value));
    }

    /** Bytes as whole mebibytes, for a message: "8", or "0.5" below one.  */
    public static String mib(long bytes) {
        BigDecimal value = BigDecimal.valueOf(bytes).divide(BigDecimal.valueOf(MIB), 2, RoundingMode.HALF_UP).stripTrailingZeros();
        return value.scale() <= 0 ? value.toBigInteger().toString() : value.toPlainString();
    }

    /**
     * The WARN text of a value that is set but not used as set: {@code datum limit validationSeconds = 3600 is outside [1, 60];
     * using 60.} One text for {@link Builder} and for the settings' report, so what a host logs is what it can read back.
     */
    public static String clampWarning(String name, long value, long result, Bounds bounds) {
        return "datum limit " + name + " = " + value + " is outside [" + bounds.min() + ", " + bounds.max() + "]; using " + result + ".";
    }

    private static void check(String name, long value, Bounds bounds) {
        boolean zeroAllowed = bounds == VALIDATION_CONCURRENCY || bounds == PDF_CONCURRENCY || bounds == VALIDATION_WAIT;
        boolean ok = (zeroAllowed && value == 0) || (value >= bounds.min() && value <= bounds.max());
        if (!ok) {
            throw new IllegalArgumentException(name + " = " + value + " is outside [" + bounds.min() + ", " + bounds.max() + "]: build limits with ProgramLimits.builder().");
        }
    }

    /**
     * Typed settings in, clamped limits out. Every setter takes a number (or null for "not set", which is the
     * default); a Spring property, a Quarkus config value or a JDBC row is already typed by the time it gets here,
     * so no text is ever read as a number on this path.
     */
    public static final class Builder {

        private @Nullable Long validationSeconds;
        private @Nullable Long validationMemory;
        private @Nullable Long validationConcurrency;
        private @Nullable Long validationWait;
        private @Nullable Long pdfSeconds;
        private @Nullable Long pdfMemory;
        private @Nullable Long pdfConcurrency;
        private @Nullable Long maxBodyBytes;
        private Consumer<String> warn = LOG::warn;

        private Builder() {
        }

        public Builder validationSeconds(long value) { this.validationSeconds = value; return this; }
        public Builder validationSeconds(@Nullable Long value) { this.validationSeconds = value; return this; }
        public Builder validationMemory(long value) { this.validationMemory = value; return this; }
        public Builder validationMemory(@Nullable Long value) { this.validationMemory = value; return this; }
        public Builder validationConcurrency(long value) { this.validationConcurrency = value; return this; }
        public Builder validationConcurrency(@Nullable Long value) { this.validationConcurrency = value; return this; }
        public Builder validationWait(long value) { this.validationWait = value; return this; }
        public Builder validationWait(@Nullable Long value) { this.validationWait = value; return this; }
        public Builder pdfSeconds(long value) { this.pdfSeconds = value; return this; }
        public Builder pdfSeconds(@Nullable Long value) { this.pdfSeconds = value; return this; }
        public Builder pdfMemory(long value) { this.pdfMemory = value; return this; }
        public Builder pdfMemory(@Nullable Long value) { this.pdfMemory = value; return this; }
        public Builder pdfConcurrency(long value) { this.pdfConcurrency = value; return this; }
        public Builder pdfConcurrency(@Nullable Long value) { this.pdfConcurrency = value; return this; }
        public Builder maxBodyBytes(long value) { this.maxBodyBytes = value; return this; }
        public Builder maxBodyBytes(@Nullable Long value) { this.maxBodyBytes = value; return this; }

        /** Where the "set but not used as set" warnings go (SLF4J WARN by default). */
        public Builder warnings(Consumer<String> sink) {
            this.warn = Objects.requireNonNull(sink, "sink");
            return this;
        }

        /** The limits, each value clamped to its bounds; one warning per value not used as set. */
        public ProgramLimits build() {
            return new ProgramLimits(
                (int) clamped("validationSeconds", validationSeconds, VALIDATION_SECONDS),
                clamped("validationMemory", validationMemory, VALIDATION_MEMORY),
                (int) concurrencyOf("validationConcurrency", validationConcurrency, VALIDATION_CONCURRENCY),
                (int) waitOf("validationWait", validationWait),
                (int) clamped("pdfSeconds", pdfSeconds, PDF_SECONDS),
                clamped("pdfMemory", pdfMemory, PDF_MEMORY),
                (int) concurrencyOf("pdfConcurrency", pdfConcurrency, PDF_CONCURRENCY),
                clamped("maxBodyBytes", maxBodyBytes, BODY_BYTES));
        }

        private long clamped(String name, @Nullable Long value, Bounds bounds) {
            long result = clamp(value, bounds);
            report(name, value, result, bounds);
            return result;
        }

        private long concurrencyOf(String name, @Nullable Long value, Bounds bounds) {
            long result = concurrency(value, bounds);
            report(name, value, result, bounds);
            return result;
        }

        private long waitOf(String name, @Nullable Long value) {
            long result = waitSeconds(value);
            report(name, value, result, VALIDATION_WAIT);
            return result;
        }

        private void report(String name, @Nullable Long value, long result, Bounds bounds) {
            if (value == null || value == result) {
                return;
            }
            warn.accept(clampWarning(name, value, result, bounds));
        }
    }
}
