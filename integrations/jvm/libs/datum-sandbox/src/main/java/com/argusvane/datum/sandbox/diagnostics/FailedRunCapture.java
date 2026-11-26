package com.argusvane.datum.sandbox.diagnostics;

import com.argusvane.datum.core.DatumConfigurationException;
import java.io.IOException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.TreeMap;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;
import java.util.function.LongSupplier;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Keeps failed runs for debugging, within bounds that hold whatever the {@link RunCaptureSink}: the
 * queue of captures waiting to be written is bounded in bytes, the store in captures and in bytes.
 *
 * <p>A run never waits for a capture and never fails because of one. {@link #offer} is called on the run's thread and only
 * counts and enqueues: a capture larger than {@code max-bytes}, one that does not fit the queue's {@code queue-bytes}, or one
 * offered once the capture has stopped is dropped and counted, with one WARN a minute at most. One daemon thread writes the
 * queue through the sink; a write that fails, whatever it throws, is counted and WARNed (at most one a minute, naming the
 * capture id and the exception's class, never a path or a message), the writer goes on with the next, and the run's answer
 * was never waiting on it. After each write the oldest captures (by id, which sorts by time) other than the one just written
 * are removed until both {@code max-runs} and {@code max-bytes} hold, counting what the sink already held at start: so a clock
 * stepped back, which names the newest capture before older ones, never evicts the capture it just kept. A removal the sink
 * refuses leaves that capture held and counted, and the failure is counted once.
 *
 * <p>{@link #start()} opens the sink (the file sink checks its directory there and refuses the start with a
 * {@link DatumConfigurationException}) and logs the one WARN that a capture holds the submitted answers and the form definition
 * (personal data) in clear text. {@link #stop(Duration)} lets the writer drain the queue within the grace, then drops the rest.
 * Each start has a writer of its own, reading a queue of its own: a writer that outlived its stop (a sink that ignores
 * interrupts) reads only its own queue, which holds nothing but its end, and a new start is refused until it has finished.
 */
public final class FailedRunCapture {

    private static final Logger LOG = LoggerFactory.getLogger(FailedRunCapture.class);

    /** The shortest time between two WARNs of one kind (a dropped capture, a failed write). */
    public static final Duration WARN_EVERY = Duration.ofMinutes(1);

    /** The most of a stop's grace kept for the writer to end after its interrupt (half the grace when that is shorter). */
    static final Duration INTERRUPT_WAIT = Duration.ofSeconds(1);

    private static final AtomicInteger WRITERS = new AtomicInteger();

    /** A queue's end of input: what stop() hands a writer last. */
    private static final Item END = new Item(null);

    private record Item(@Nullable RunCapture capture) {
    }

    /** One start's writer and the queue only it reads. */
    private record Generation(Thread thread, LinkedBlockingQueue<Item> queue) {
    }

    /**
     * What the capture has done since it started.
     *
     * @param dropped captures not kept: too large, the queue full, the capture stopped, or still waiting after the grace
     * @param failed writes (and removals) the sink refused
     * @param written captures the sink stored
     * @param stored captures held now, counting those found at start
     */
    public record Counts(long dropped, long failed, long written, int stored) {
    }

    private final CaptureSettings settings;
    private final RunCaptureSink sink;
    private final Consumer<String> warnings;
    private final LongSupplier nanos;
    private final AtomicLong pending = new AtomicLong();
    private final AtomicLong dropped = new AtomicLong();
    private final AtomicLong failed = new AtomicLong();
    private final AtomicLong written = new AtomicLong();
    private final AtomicLong lastDropWarning = new AtomicLong(Long.MIN_VALUE);
    private final AtomicLong lastFailureWarning = new AtomicLong(Long.MIN_VALUE);
    /** What the store holds, id to bytes, oldest first: the running writer thread's own. */
    private final TreeMap<String, Long> stored = new TreeMap<>();
    private long storedBytes;
    private volatile int storedCount;
    private final Object gate = new Object();
    /** The running start's writer and queue, or null while stopped. */
    private @Nullable Generation current;
    /** The last stopped start's writer, which a sink that ignores interrupts may keep going past its stop. */
    private @Nullable Thread previous;

    /** A capture over a sink, warning on the SLF4J logger. */
    public FailedRunCapture(CaptureSettings settings, RunCaptureSink sink) {
        this(settings, sink, LOG::warn, System::nanoTime);
    }

    /**
     * A capture over a sink, its WARNs handed to {@code warnings} and the one-a-minute limit read from {@code nanos}: a host
     * with its own log, and the tests.
     */
    public FailedRunCapture(CaptureSettings settings, RunCaptureSink sink, Consumer<String> warnings, LongSupplier nanos) {
        this.settings = Objects.requireNonNull(settings, "settings");
        this.sink = Objects.requireNonNull(sink, "sink");
        this.warnings = Objects.requireNonNull(warnings, "warnings");
        this.nanos = Objects.requireNonNull(nanos, "nanos");
    }

    /** The bounds. */
    public CaptureSettings settings() {
        return settings;
    }

    /** The sink. */
    public RunCaptureSink sink() {
        return sink;
    }

    /** What the sink says it stores to, guarded and scrubbed ({@link Guarded#describe(RunCaptureSink)}). */
    public String describe() {
        return Guarded.describe(sink);
    }

    /**
     * Opens the sink, counts what it holds, starts the writer and logs the personal-data WARN. Starting a started capture does
     * nothing. A start that fails after its writer began stops that writer before the failure is thrown.
     *
     * @throws DatumConfigurationException when the sink refuses to open (the file sink's directory checks), or cannot list what
     *     it holds
     * @throws IllegalStateException while the writer of the last start is still going (a sink that ignored its interrupt is
     *     finishing a write): two writers never share the store's bookkeeping
     */
    public void start() {
        Generation started;
        synchronized (gate) {
            if (current != null) {
                return;
            }
            Thread before = previous;
            if (before != null && before.isAlive()) {
                throw new IllegalStateException("The failed-run capture's previous writer (" + before.getName() + ") is still finishing a "
                    + "write after its stop (a sink that ignores interrupts); start the capture again once it has ended.");
            }
            List<RunCaptureSink.Stored> existing;
            try {
                existing = sink.open();
            } catch (IOException e) {
                throw new DatumConfigurationException(DirectoryCaptureSink.PROPERTY, "The failed-run capture cannot read what " + describe()
                    + " holds (" + e.getClass().getSimpleName() + ").", "Fix the capture's storage, or set datum.runtime.diagnostics.capture.enabled=false.", e);
            }
            stored.clear();
            storedBytes = 0;
            for (RunCaptureSink.Stored one : existing) {
                stored.put(one.id(), one.bytes());
                storedBytes += one.bytes();
            }
            storedCount = stored.size();
            LinkedBlockingQueue<Item> queue = new LinkedBlockingQueue<>();
            Thread thread = new Thread(() -> drain(queue), "datum-sandbox-capture-" + WRITERS.incrementAndGet());
            thread.setDaemon(true);
            started = new Generation(thread, queue);
            current = started;
            thread.start();
        }
        try {
            int incomplete = sink instanceof DirectoryCaptureSink directory ? directory.incomplete() : 0;
            warnings.accept("Datum: failed-run capture is ON, into " + describe() + " (at most " + settings.maxRuns() + " runs, "
                + settings.maxBytes() + " bytes). Captured runs contain the submitted answers and the form definition (personal data) in "
                + "clear text: turn datum.runtime.diagnostics.capture.enabled off after debugging."
                + (sink instanceof DirectoryCaptureSink ? " The directory must stay the JVM user's alone: mode 700 and, on macOS, no access "
                    + "control list (ls -lde lists none); either is checked again before every write." : "")
                + (storedCount > 0 ? " " + storedCount + " capture(s) from before are kept." : "")
                + (incomplete > 0 ? " " + incomplete + " incomplete capture(s) (.partial-* from a JVM that stopped mid-write, .evict-* from "
                    + "a removal that failed) are left as they are; remove them by hand." : ""));
        } catch (Throwable e) {
            // The writer is already running: a start that fails must not leave it behind, waiting on a queue nobody stops. Its
            // queue is empty, so it takes its end at once.
            stop(INTERRUPT_WAIT);
            throw e;
        }
    }

    /**
     * Queues one failed run's capture, or drops it: never waits, never throws for the run.
     *
     * @return true when it was queued; false when it was dropped (counted)
     */
    public boolean offer(RunCapture capture) {
        Objects.requireNonNull(capture, "capture");
        long bytes = capture.bytes();
        String refused;
        // Only the checks and the hand-off hold the gate (stop() flips it): the WARN of a drop is logged outside it.
        synchronized (gate) {
            Generation running = current;
            if (running == null) {
                refused = "the capture is not running";
            } else if (bytes > settings.maxBytes()) {
                refused = "it is " + bytes + " bytes, more than max-bytes " + settings.maxBytes();
            } else if (pending.addAndGet(bytes) > settings.queueBytes()) {
                pending.addAndGet(-bytes);
                refused = "the write queue is full (queue-bytes " + settings.queueBytes() + ")";
            } else {
                running.queue().add(new Item(capture));
                return true;
            }
        }
        return drop(refused);
    }

    /** Counts a capture that never reached {@link #offer} (it could not be assembled) as dropped, with the same WARN. */
    public void lost(String why) {
        drop(why);
    }

    private boolean drop(String why) {
        long count = dropped.incrementAndGet();
        warnAtMostOnceAMinute(lastDropWarning, "Datum: a failed run's capture was dropped: " + why + " (" + count
            + " dropped so far; at most one such WARN a minute). The run's answer is unchanged.");
        return false;
    }

    /**
     * Stops taking captures and lets the writer drain the queue, all within {@code grace}: the writer has the grace less a
     * short wait kept back (half the grace, at most {@link #INTERRUPT_WAIT}), then what is still queued is dropped (counted,
     * one WARN), the writer is interrupted and waited for that short time. So a stop never takes longer than its grace, and a
     * zero grace drops everything queued at once. Stopping a stopped capture does nothing.
     *
     * <p>A sink that ignores interrupts may still finish the write it is in after this returns; it writes nothing more (its
     * queue holds only its end), and {@link #start()} is refused until it has finished.
     */
    public void stop(Duration grace) {
        long budget = Math.max(0, Objects.requireNonNull(grace, "grace").toNanos());
        long deadline = System.nanoTime() + budget;
        Generation stopping;
        synchronized (gate) {
            stopping = current;
            if (stopping == null) {
                return;
            }
            current = null;
            previous = stopping.thread();
            stopping.queue().add(END);
        }
        Thread thread = stopping.thread();
        long reserve = Math.min(budget / 2, INTERRUPT_WAIT.toNanos());
        boolean interrupted = false;
        try {
            join(thread, deadline - reserve - System.nanoTime());
        } catch (InterruptedException e) {
            interrupted = true;
        }
        int left = 0;
        if (thread.isAlive()) {
            // Out of time: what is still queued is dropped before the writer can take it, its end goes back for it to find.
            for (Item item = stopping.queue().poll(); item != null; item = stopping.queue().poll()) {
                RunCapture capture = item.capture();
                if (capture != null) {
                    left++;
                    pending.addAndGet(-capture.bytes());
                }
            }
            stopping.queue().add(END);
            thread.interrupt();
            if (!interrupted) {
                try {
                    join(thread, deadline - System.nanoTime());
                } catch (InterruptedException e) {
                    interrupted = true;
                }
            }
        }
        if (left > 0) {
            long count = dropped.addAndGet(left);
            warn("Datum: " + left + " failed-run capture(s) were still waiting after the " + grace.toMillis()
                + " ms the shutdown left them and were dropped (" + count + " dropped in all).");
        }
        if (interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    /** Waits for a thread up to {@code nanos}; not at all when there is no time left ({@code join(0)} would wait for ever). */
    private static void join(Thread thread, long nanos) throws InterruptedException {
        if (nanos <= 0) {
            return;
        }
        long millis = TimeUnit.NANOSECONDS.toMillis(nanos);
        thread.join(millis, (int) (nanos - TimeUnit.MILLISECONDS.toNanos(millis)));
    }

    /** The counters: health shows {@code dropped} and {@code failed}. */
    public Counts counts() {
        return new Counts(dropped.get(), failed.get(), written.get(), storedCount);
    }

    /** The bytes queued and not yet written. */
    public long pendingBytes() {
        return pending.get();
    }

    // ---------------------------------------------------------------------------------------------- the writer thread

    private void drain(LinkedBlockingQueue<Item> queue) {
        while (true) {
            Item item;
            try {
                item = queue.take();
            } catch (InterruptedException e) {
                return;
            }
            RunCapture capture = item.capture();
            if (capture == null) {
                return;
            }
            try {
                long bytes = sink.write(capture);
                written.incrementAndGet();
                Long before = stored.put(capture.id(), bytes);
                storedBytes += bytes - (before == null ? 0 : before);
                evict(capture.id());
            } catch (Throwable e) {
                // Whatever the sink throws (an Error included), the writer counts it and goes on: a writer that died here
                // would leave every later capture counted as a full queue, and its pending bytes stuck.
                long count = failed.incrementAndGet();
                warnAtMostOnceAMinute(lastFailureWarning, "Datum: writing failed-run capture " + capture.id() + " failed ("
                    + e.getClass().getName() + "; " + count + " failed so far; at most one such WARN a minute). The run's answer is unchanged.");
            } finally {
                pending.addAndGet(-capture.bytes());
                storedCount = stored.size();
            }
        }
    }

    /**
     * The oldest captures but {@code kept} (the one just written) go until both bounds hold, or nothing else is left to remove.
     * A removal the sink refuses keeps its capture held and counted (and not asked again in this pass); one the sink did only
     * in part ({@link RunCaptureSink.PartlyRemovedException}) is out of the names and no longer counted. Either is one failure.
     */
    private void evict(String kept) {
        List<String> refused = new ArrayList<>();
        while (stored.size() > settings.maxRuns() || storedBytes > settings.maxBytes()) {
            Map.Entry<String, Long> oldest = null;
            for (Map.Entry<String, Long> entry : stored.entrySet()) {
                if (!entry.getKey().equals(kept) && !refused.contains(entry.getKey())) {
                    oldest = entry;
                    break;
                }
            }
            if (oldest == null) {
                break;
            }
            String id = oldest.getKey();
            long bytes = oldest.getValue();
            try {
                sink.remove(id);
                stored.remove(id);
                storedBytes -= bytes;
            } catch (RunCaptureSink.PartlyRemovedException e) {
                stored.remove(id);
                storedBytes -= bytes;
                removalFailed(id, e);
            } catch (Throwable e) {
                refused.add(id);
                removalFailed(id, e);
            }
        }
        storedCount = stored.size();
    }

    private void removalFailed(String id, Throwable e) {
        long count = failed.incrementAndGet();
        warnAtMostOnceAMinute(lastFailureWarning, "Datum: removing failed-run capture " + id + " failed (" + e.getClass().getName()
            + "; " + count + " failed so far; at most one such WARN a minute).");
    }

    private void warnAtMostOnceAMinute(AtomicLong last, String text) {
        long now = nanos.getAsLong();
        long previousWarning = last.get();
        if (previousWarning != Long.MIN_VALUE && now - previousWarning < WARN_EVERY.toNanos()) {
            return;
        }
        if (last.compareAndSet(previousWarning, now)) {
            warn(text);
        }
    }

    /**
     * A WARN from the run path, the writer or the stop: a host's warning sink that throws never reaches a run ({@link #offer}
     * never throws for it), the writer or the shutdown. Only the start's WARN is the start's own, and may fail it.
     */
    private void warn(String text) {
        try {
            warnings.accept(text);
        } catch (Throwable e) {
            Guarded.rethrowFatal(e);
        }
    }
}
