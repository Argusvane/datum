package com.argusvane.datum.sandbox.protocol;

import com.argusvane.datum.sandbox.diagnostics.Guarded;
import com.argusvane.datum.sandbox.protocol.SandboxException.Reason;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.jspecify.annotations.Nullable;

/**
 * At most so many runs at once; the rest wait a little, then are refused as busy.
 *
 * <p>A fair {@link Semaphore}: a run holds a request thread and up to its memory budget, so a flood of submissions
 * must not start as many runs as there are threads; a short wait absorbs a
 * burst instead of answering it with 503s. A JVM that dies frees every slot, so no slot outlives its
 * holder. The bound is a semaphore, not a pool size, so it holds under {@code spring.threads.virtual.enabled}, where
 * request threads are not scarce; the harness runs the guest on its own platform threads on purpose (see {@code RunHarness}).
 */
public final class RunSlots {

    private final Semaphore semaphore;
    private final int slots;
    private final Duration wait;
    private final String what;
    private final @Nullable Runnable onBusy;
    /**
     * The wait of the permit the current thread holds, when these slots are measured (a host that traces its runs); null otherwise, so unmeasured slots read no clock and keep nothing per thread.
     */
    private final @Nullable ThreadLocal<Held> held;

    /** The permit a thread holds, when measured: how long it was waited for, and what runs once it is released. */
    private static final class Held {

        final long waitNanos;
        @Nullable List<Runnable> afterRelease;

        Held(long waitNanos) {
            this.waitNanos = waitNanos;
        }
    }

    /**
     * @param slots how many runs at once, at least one
     * @param wait how long a run waits for a free slot; zero refuses at once
     * @param what "validation" or "PDF render", for the message
     */
    public RunSlots(int slots, Duration wait, String what) {
        this(slots, wait, what, null);
    }

    /**
     * Slots that say when they refuse: {@code onBusy} is told of every busy
     * refusal before it is thrown, whoever asked (the HTTP routes, a queue consumer, a batch, the definition service), which
     * is where a host counts them; a count kept in the HTTP error mapper missed every caller that does not go through it.
     *
     * @param onBusy told of each busy refusal, or null; one that throws is ignored, and the refusal stays busy
     */
    public RunSlots(int slots, Duration wait, String what, @Nullable Runnable onBusy) {
        this(slots, wait, what, onBusy, false);
    }

    /**
     * Slots that also remember, per thread, how long the permit it holds was waited for ({@link #heldWaitNanos()}): the
     * run trace's {@code slotWaitMs}, read by the run's own thread while it holds the permit.
     *
     * @param measured whether to measure; false costs nothing per acquire
     */
    public RunSlots(int slots, Duration wait, String what, @Nullable Runnable onBusy, boolean measured) {
        if (slots < 1) {
            throw new IllegalArgumentException("At least one slot.");
        }
        this.semaphore = new Semaphore(slots, true);
        this.slots = slots;
        this.wait = wait.isNegative() ? Duration.ZERO : wait;
        this.what = what;
        this.onBusy = onBusy;
        this.held = measured ? new ThreadLocal<>() : null;
    }

    /** The validation slots of a set of limits: their concurrency (0: one per CPU) and wait. */
    public static RunSlots validation(ProgramLimits limits) {
        return validation(limits, null);
    }

    /** {@link #validation(ProgramLimits)} telling {@code onBusy} of each busy refusal ({@link #RunSlots(int, Duration, String, Runnable)}). */
    public static RunSlots validation(ProgramLimits limits, Runnable onBusy) {
        return new RunSlots(limits.validationSlots(), Duration.ofSeconds(limits.validationWait()), "validation", onBusy);
    }

    /** A taken slot; closing it frees the slot, once. */
    public interface Permit extends AutoCloseable {
        @Override
        void close();
    }

    /**
     * Takes a free slot, waiting up to the wait for one.
     *
     * @throws SandboxException {@link Reason#BUSY} when every slot stayed taken; {@link Reason#INTERRUPTED}
     *     (the thread's interrupt kept) when the wait was interrupted
     */
    public Permit acquire() {
        return take(wait);
    }

    /**
     * Takes a free slot, waiting up to the longer of the slots' own wait and {@code patience}: for work that must not
     * be thrown away half done (the second half of a PDF seal waits as long as one render may take). One timed wait on
     * the fair semaphore, so a patient caller keeps its place in the queue.
     *
     * @throws SandboxException {@link Reason#BUSY} when every slot stayed taken; {@link Reason#INTERRUPTED}
     *     (the thread's interrupt kept) when the wait was interrupted
     */
    public Permit acquire(@Nullable Duration patience) {
        return take(patience == null || patience.compareTo(wait) <= 0 ? wait : patience);
    }

    private Permit take(Duration within) {
        long asked = held != null ? System.nanoTime() : 0;
        boolean taken;
        try {
            taken = within.isZero() ? semaphore.tryAcquire() : semaphore.tryAcquire(within.toNanos(), TimeUnit.NANOSECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new SandboxException(Reason.INTERRUPTED, "The wait for a " + what + " slot was interrupted.");
        }
        if (!taken) {
            busy();
            throw new SandboxException(Reason.BUSY, "Every " + what + " slot (" + slots + ") is taken"
                + (within.isZero() ? "" : " (waited " + within.toSeconds() + " s)") + ".");
        }
        AtomicBoolean released = new AtomicBoolean();
        ThreadLocal<Held> waits = held;
        if (waits == null) {
            return () -> {
                if (released.compareAndSet(false, true)) {
                    semaphore.release();
                }
            };
        }
        Held previous = waits.get();
        Held mine = new Held(System.nanoTime() - asked);
        waits.set(mine);
        return () -> {
            if (released.compareAndSet(false, true)) {
                // The holder's own record goes, and the one of a permit it held around this one comes back.
                if (waits.get() == mine) {
                    if (previous == null) {
                        waits.remove();
                    } else {
                        waits.set(previous);
                    }
                }
                semaphore.release();
                List<Runnable> after = mine.afterRelease;
                mine.afterRelease = null;
                if (after != null) {
                    for (Runnable work : after) {
                        runObserver(work);
                    }
                }
            }
        };
    }

    /**
     * How long the permit the current thread holds was waited for, in nanoseconds; -1 when these slots are not measured or
     * the thread holds none of their permits (the runtime's own ABI proof takes no slot).
     */
    public long heldWaitNanos() {
        ThreadLocal<Held> waits = held;
        if (waits == null) {
            return -1;
        }
        Held wait = waits.get();
        return wait == null ? -1 : wait.waitNanos;
    }

    /**
     * Runs {@code work} on this thread once the permit it holds of these slots is released, or now when it holds none (or the
     * slots are not measured): how the run diagnostics trace a run and assemble its capture after
     * the run's slot is free again, so a slow trace sink or a large capture never holds a slot another run is waiting for. An
     * observer: whatever it throws is dropped (an Error that says the JVM is broken excepted), and the permit is released
     * first either way.
     */
    public void afterRelease(Runnable work) {
        java.util.Objects.requireNonNull(work, "work");
        ThreadLocal<Held> waits = held;
        Held holding = waits == null ? null : waits.get();
        if (holding == null) {
            runObserver(work);
            return;
        }
        if (holding.afterRelease == null) {
            holding.afterRelease = new ArrayList<>(1);
        }
        holding.afterRelease.add(work);
    }

    private static void runObserver(Runnable work) {
        try {
            work.run();
        } catch (Throwable e) {
            // The caller guards its own work; this keeps a permit's close() from ever throwing what it ran.
            Guarded.rethrowFatal(e);
        }
    }

    /** Tells the listener of a busy refusal; the refusal is thrown whatever it does (a metric never changes an answer). */
    private void busy() {
        if (onBusy == null) {
            return;
        }
        try {
            onBusy.run();
        } catch (RuntimeException ignored) {
            // An observer: the caller is refused as busy either way.
        }
    }

    /** How many slots there are. */
    public int size() {
        return slots;
    }

    /** How many are free now (for health). */
    public int available() {
        return semaphore.availablePermits();
    }
}
