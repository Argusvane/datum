package com.argusvane.datum.sandbox.wasi;

import com.google.common.jimfs.Configuration;
import com.google.common.jimfs.Jimfs;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.SeekableByteChannel;
import java.nio.file.FileSystem;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.FileTime;
import java.time.Duration;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Predicate;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The engine-neutral half of a run: a
 * {@link GuestRuntime} over a {@link GuestEngine}, one module instance per run.
 *
 * <p>What a run gets, as a wasmtime host's sandbox runner gives it:
 * <ul>
 *   <li>a fresh Jimfs file system holding only the {@link GuestRun}'s files under {@code /app} (copied from the run's
 *       bytes, so the guest reads exactly what the caller handed over, never a path on disk: the Datum protocol hands it the
 *       program it hashed and proved, and {@code run.js}), its only preopen, closed when the run is answered. The guest
 *       sees it through {@link ReadOnlyFileSystem}: it can create, change or remove nothing there, so neither file content
 *       nor names (which Jimfs keeps on the heap) can grow the JVM heap. The file system's content is also capped at those
 *       files, a second fence. Its file times are {@link GuestIo#GUEST_TIME};</li>
 *   <li>the argv and stdin of the run, a realtime clock that reads {@link GuestIo#GUEST_TIME} and a {@code random_get}
 *       stream that is the same for every run ({@link GuestIo}): the guest learns neither the date nor real entropy;</li>
 *   <li>stdout and stderr through {@link BoundedOutputStream}s at the budget's caps: the write past a cap
 *       throws {@link OutputCapExceededException} out of the guest's write, which ends the run at once;</li>
 *   <li>the time budget, set-up included, as a wait on the run's {@link Future}; past it the run is stopped.</li>
 * </ul>
 *
 * <p>A stop never interrupts set-up. The future is cancelled without an interrupt, and the worker thread is interrupted
 * only while {@link GuestEngine.Instance#start()} runs: an engine that maps the linear memory before it constructs the
 * instance would leak it to an interrupt landing in set-up (repeated stops during set-up
 * leaked a whole memory limit of address space each). A stop during set-up marks the run abandoned instead; the thread
 * finishes {@link GuestEngine.Prepared#instantiate()}, sees the mark and closes the instance without starting it.
 *
 * <p>How the run ended is reported structurally ({@link Termination}); what the output means is the layer above's (the
 * Datum protocol's {@code RunClassifier} reads its frame). Every termination hands back what the guest wrote so far: after a stop the run's thread is
 * given the stop grace to end (it closes the instance on its way out) before the buffers are read, so the "started"
 * marker of a run stopped at its budget is there for the classifier. The reading, in order: a passed cap is
 * {@link Termination#OUTPUT_CAP}; no failure is an exit with 0 (or, never started, {@link Termination#INTERRUPTED}); a
 * host interrupt or shutdown is {@link Termination#INTERRUPTED}; the JVM out of heap is {@link Termination#INTERRUPTED}
 * too (the host's capacity, not the guest's budget, so a definition is never called too costly and no program is
 * remembered as unavailable for another request's heap); a failure before {@code _start} is
 * {@link GuestUnavailableException}; then the engine's own {@link GuestEngine#ended reading} (an exit with its code, a
 * trap); a JVM stack overflow is a {@link Termination#TRAP}; a {@link LinkageError} is unavailable; another
 * {@link Error} propagates; anything else is a logged {@link Termination#TRAP}. The harness never reports
 * {@link Termination#MEMORY}: the instance's memory limit makes QuickJS exit with its own "out of memory", which the
 * classifier reads.
 *
 * <p>Runs execute on the harness's own platform threads, one per run in flight; the caller bounds how many with its
 * slots ({@code RunSlots}), so the harness owns no semaphore. Platform threads on purpose, so they stay platform threads under
 * {@code spring.threads.virtual.enabled}: the stop interrupts a worker only during {@code _start} (above), and a native
 * downcall into the engine pins a virtual thread's carrier, so a virtual worker would hold a carrier for the whole run. A stopped run whose thread outlives the grace no longer
 * holds its caller's slot, so the harness counts such strays and refuses new runs with
 * {@link GuestUnavailableException} while there are {@link EngineSettings#maxStrays()} of them.
 *
 * <p>A run that asks to be timed ({@link GuestRun#timed()}) hands back {@link RunTimings}: its set-up, instantiation and
 * {@code _start}, each measured around the engine's own call, so the numbers mean the same whatever engine is behind
 * {@link GuestEngine}. A run that does not ask reads no clock for it.
 */
public final class RunHarness implements GuestRuntime, AutoCloseable {

    private static final Logger LOG = LoggerFactory.getLogger(RunHarness.class);

    /** The block size of a run's file system. */
    private static final int BLOCK = 8192;

    private static final AtomicInteger HARNESSES = new AtomicInteger();

    /** A clock reading not taken. */
    private static final long UNSET = Long.MIN_VALUE;

    private final GuestEngine engine;
    private final EngineInfo info;
    private final String label;
    private final ThreadPoolExecutor executor;
    private final Duration stopGrace;
    private final int maxStrays;
    /** The runs in flight, so close() can stop each the same way a budget does. */
    private final Set<Attempt> inFlight = ConcurrentHashMap.newKeySet();
    /** Stopped runs whose thread outlived the grace and is still alive. */
    private final AtomicInteger strays = new AtomicInteger();
    private volatile boolean closed;

    /**
     * @param engine the engine's half of a run
     * @param settings the stop grace and the stray bound
     */
    public RunHarness(GuestEngine engine, EngineSettings settings) {
        this.engine = Objects.requireNonNull(engine, "engine");
        Objects.requireNonNull(settings, "settings");
        this.stopGrace = settings.stopGrace();
        this.maxStrays = settings.maxStrays();
        this.info = Objects.requireNonNull(engine.info(), "engine.info()");
        this.label = "Datum " + info.id() + " runtime";
        int id = HARNESSES.incrementAndGet();
        AtomicInteger threads = new AtomicInteger();
        String prefix = "datum-" + info.id().toLowerCase(Locale.ROOT) + "-" + id + "-run-";
        ThreadFactory factory = runnable -> {
            Thread thread = new Thread(runnable, prefix + threads.incrementAndGet());
            thread.setDaemon(true);
            return thread;
        };
        // No core threads and no queue: one platform thread per run in flight, kept a while for the next one. The
        // caller's slots bound how many there are.
        this.executor = new ThreadPoolExecutor(0, Integer.MAX_VALUE, 60, TimeUnit.SECONDS, new SynchronousQueue<>(), factory);
    }

    @Override
    public EngineInfo engineInfo() {
        return info;
    }

    /** Stopped runs whose thread is still alive past the grace (health reports it). */
    @Override
    public int strayRuns() {
        return strays.get();
    }

    /** The stop grace this harness gives a stopped run. */
    public Duration stopGrace() {
        return stopGrace;
    }

    @Override
    public RunOutput run(GuestRun run) {
        Objects.requireNonNull(run, "run");
        Budget budget = run.budget();
        engine.admit(run, budget);
        BoundedOutputStream out = new BoundedOutputStream("stdout", budget.stdoutCap());
        BoundedOutputStream err = new BoundedOutputStream("stderr", budget.stderrCap());
        if (closed) {
            return stopped(Termination.INTERRUPTED, out, err);
        }
        int stray = strays.get();
        if (stray >= maxStrays) {
            // The slots no longer bound the live instances: refuse until the strays have ended.
            LOG.error("{}: {} stopped runs are still alive past their {} s grace; new runs are refused until they end.", label, stray,
                stopGrace.toSeconds());
            throw new GuestUnavailableException("The runtime is refusing runs: " + stray + " stopped runs have not ended yet.");
        }
        FileSystem workspace = workspace(run);
        try {
            GuestIo io = new GuestIo(run.argv(), run.openStdin(), out, err,
                ReadOnlyFileSystem.over(workspace).getPath(GuestIo.GUEST_APP), GuestIo.guestRandom(), GuestIo.guestClock());
            long preparing = run.timed() ? System.nanoTime() : 0;
            try (GuestEngine.Prepared prepared = engine.prepare(io, budget)) {
                Attempt attempt = new Attempt(prepared, run.timed() ? System.nanoTime() - preparing : UNSET);
                inFlight.add(attempt);
                try {
                    if (closed) {
                        // close() may have walked the set before this run joined it.
                        attempt.abandon();
                    }
                    Future<Void> future;
                    try {
                        future = executor.submit(attempt);
                    } catch (RejectedExecutionException e) {
                        // Closed under us: the host is shutting down.
                        return stopped(Termination.INTERRUPTED, out, err, attempt.timings());
                    }
                    return await(future, attempt, budget, out, err);
                } finally {
                    inFlight.remove(attempt);
                }
            }
        } finally {
            try {
                workspace.close();
            } catch (IOException e) {
                LOG.debug("{}: closing a run's file system failed.", label, e);
            }
        }
    }

    /**
     * The run's private {@code /app}: the run's files, from their bytes, in their order. The guest gets it read-only
     * ({@link ReadOnlyFileSystem}); the storage is also capped at what those files take (a block of slack each, two at
     * least), so content could not grow the heap even past that view.
     */
    static FileSystem workspace(GuestRun run) {
        Map<String, ByteBuffer> files = run.appFiles();
        long blocks = Math.max(2, files.size());
        for (ByteBuffer content : files.values()) {
            blocks += blocksOf(content.remaining());
        }
        FileSystem fs = Jimfs.newFileSystem(Configuration.unix().toBuilder()
            .setWorkingDirectory(GuestIo.GUEST_APP)
            .setBlockSize(BLOCK)
            .setMaxSize(blocks * BLOCK)
            // A file's times would tell the guest when its run was made: every one is the guest's fixed time.
            .setFileTimeSource(() -> FileTime.from(GuestIo.GUEST_TIME))
            .build());
        try {
            Path app = Files.createDirectories(fs.getPath(GuestIo.GUEST_APP));
            for (Map.Entry<String, ByteBuffer> file : files.entrySet()) {
                // CREATE_NEW: a name is one plain file name (GuestRun), written once, nothing outside /app.
                try (SeekableByteChannel channel = Files.newByteChannel(app.resolve(file.getKey()), StandardOpenOption.CREATE_NEW,
                    StandardOpenOption.WRITE)) {
                    ByteBuffer content = file.getValue();
                    while (content.hasRemaining()) {
                        channel.write(content);
                    }
                }
            }
            return fs;
        } catch (IOException | RuntimeException e) {
            try {
                fs.close();
            } catch (IOException closing) {
                e.addSuppressed(closing);
            }
            throw new GuestUnavailableException("The run's file system could not be prepared.", e);
        }
    }

    private static long blocksOf(long bytes) {
        return (bytes + BLOCK - 1) / BLOCK;
    }

    /** Waits for the run up to its budget and reports how it ended. */
    private RunOutput await(Future<Void> future, Attempt attempt, Budget budget, BoundedOutputStream out, BoundedOutputStream err) {
        try {
            future.get(budget.seconds(), TimeUnit.SECONDS);
            return finished(null, attempt, out, err);
        } catch (ExecutionException e) {
            return finished(e.getCause(), attempt, out, err);
        } catch (TimeoutException e) {
            if (stop(future, attempt)) {
                // It ended on its own between the timeout and the cancel: what it did stands.
                return completed(future, attempt, out, err);
            }
            return stopped(out.exceeded() || err.exceeded() ? Termination.OUTPUT_CAP : Termination.BUDGET, out, err, attempt.timings());
        } catch (InterruptedException e) {
            if (stop(future, attempt)) {
                Thread.currentThread().interrupt();
                return completed(future, attempt, out, err);
            }
            Thread.currentThread().interrupt();
            return stopped(Termination.INTERRUPTED, out, err, attempt.timings());
        } catch (CancellationException e) {
            // Only stop() cancels, after this wait; kept so a cancellation can never read as an answer.
            return stopped(Termination.INTERRUPTED, out, err, attempt.timings());
        }
    }

    /** The outcome of a future that is known to have completed (not cancelled). */
    private RunOutput completed(Future<Void> future, Attempt attempt, BoundedOutputStream out, BoundedOutputStream err) {
        try {
            future.get(0, TimeUnit.NANOSECONDS);
            return finished(null, attempt, out, err);
        } catch (ExecutionException e) {
            return finished(e.getCause(), attempt, out, err);
        } catch (InterruptedException | TimeoutException | CancellationException e) {
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            return stopped(Termination.INTERRUPTED, out, err, attempt.timings());
        }
    }

    /**
     * Stops the run and gives its thread the stop grace to end, without giving up early on an interrupt of the caller
     * (it is kept). The future is cancelled without an interrupt; {@link Attempt#abandon()} interrupts the thread only
     * once {@code _start} runs, so set-up is never cut short (see the class comment). Returns true when the run had
     * already completed on its own and was not cancelled.
     */
    private boolean stop(Future<Void> future, Attempt attempt) {
        boolean cancelled = future.cancel(false);
        if (!cancelled && future.isDone() && !future.isCancelled()) {
            return true;
        }
        if (!attempt.abandon()) {
            return false;
        }
        long deadline = System.nanoTime() + stopGrace.toNanos();
        boolean interrupted = false;
        try {
            while (true) {
                long left = deadline - System.nanoTime();
                if (left <= 0) {
                    if (attempt.stray()) {
                        LOG.warn("{}: a stopped run did not end within {} s; its output is read as it stands and its thread is left "
                            + "to end ({} such runs alive).", label, stopGrace.toSeconds(), strays.get());
                    }
                    return false;
                }
                try {
                    if (attempt.done.await(left, TimeUnit.NANOSECONDS)) {
                        return false;
                    }
                } catch (InterruptedException e) {
                    interrupted = true;
                }
            }
        } finally {
            if (interrupted) {
                Thread.currentThread().interrupt();
            }
        }
    }

    /** How a run that ended by itself (normally or with an exception) ended. */
    private RunOutput finished(Throwable failure, Attempt attempt, BoundedOutputStream out, BoundedOutputStream err) {
        // A cap's exception may arrive wrapped by the machine; the streams know structurally that a cap was passed.
        RunTimings timings = attempt.timings();
        if (out.exceeded() || err.exceeded() || causedBy(failure, OutputCapExceededException.class::isInstance)) {
            return stopped(Termination.OUTPUT_CAP, out, err, timings);
        }
        if (failure == null) {
            if (!attempt.started) {
                // close() abandoned it during set-up: it was closed without being started.
                return stopped(Termination.INTERRUPTED, out, err, timings);
            }
            return new RunOutput(Termination.EXITED, 0, out.toByteArray(), err.toByteArray(), null, timings);
        }
        if (closed || causedBy(failure, engine::interruptedBy) || causedBy(failure, InterruptedException.class::isInstance)) {
            // Only the host interrupts a run's thread: a stop, or shutdown. Looked for in the causes too: an interrupt
            // that lands in an engine's set-up may arrive wrapped in its own exception.
            return stopped(Termination.INTERRUPTED, out, err, timings);
        }
        if (outOfHeap(failure, engine::outOfHeap)) {
            // The JVM's heap, not the instance's memory limit: the host's capacity ran out, whoever's request filled
            // it. Reported as the host's stop (503 server.unavailable), never as the guest's memory budget (which would
            // call a definition too costly) nor as an unavailable program (which PdfProgram would remember).
            LOG.warn("{}: the JVM ran out of heap during a run ({}, {} _start); it is reported as a host interruption. Give the "
                + "JVM more heap or fewer run slots.", label, failure, attempt.started ? "after" : "before");
            return new RunOutput(Termination.INTERRUPTED, -1, out.toByteArray(), err.toByteArray(), "host out of heap: " + failure, timings);
        }
        if (!attempt.started) {
            // The module never ran: not instantiable, a runner that cannot link (a missing native library). Nothing
            // about the guest is known; the runtime is the one that failed.
            if (failure instanceof Error error && !(failure instanceof LinkageError) && !(failure instanceof StackOverflowError)) {
                throw error;
            }
            throw new GuestUnavailableException("The QuickJS module could not be started on " + engine.where() + ": " + failure, failure);
        }
        GuestEngine.Ending ending = engine.ended(failure);
        if (ending != null) {
            return new RunOutput(ending.termination(), ending.exitCode(), out.toByteArray(), err.toByteArray(), ending.trapMessage(), timings);
        }
        if (failure instanceof StackOverflowError) {
            return new RunOutput(Termination.TRAP, -1, out.toByteArray(), err.toByteArray(), "call stack exhausted (JVM stack)", timings);
        }
        if (failure instanceof LinkageError) {
            String where = engine.where();
            throw new GuestUnavailableException(Character.toUpperCase(where.charAt(0)) + where.substring(1)
                + " failed to link during a run: " + failure, failure);
        }
        if (failure instanceof Error error) {
            throw error;
        }
        // A fault outside the engine's own types (a WASI call the layer does not handle, an engine bug): the guest
        // started and gave no answer, so a failed run, never an answer; logged in full because it may be the engine's.
        LOG.warn("{}: a run ended with an unexpected exception; it is reported as a trap.", label, failure);
        return new RunOutput(Termination.TRAP, -1, out.toByteArray(), err.toByteArray(), failure.toString(), timings);
    }

    /**
     * Whether a failure is the JVM out of heap: an {@link OutOfMemoryError} anywhere in its causes, or a link the engine
     * calls its wrap of one.
     */
    public static boolean outOfHeap(Throwable failure, Predicate<Throwable> engineWrap) {
        return causedBy(failure, OutOfMemoryError.class::isInstance) || causedBy(failure, engineWrap);
    }

    private static RunOutput stopped(Termination termination, BoundedOutputStream out, BoundedOutputStream err) {
        return stopped(termination, out, err, null);
    }

    private static RunOutput stopped(Termination termination, BoundedOutputStream out, BoundedOutputStream err, @Nullable RunTimings timings) {
        return new RunOutput(termination, -1, out.toByteArray(), err.toByteArray(), null, timings);
    }

    private static boolean causedBy(Throwable failure, Predicate<Throwable> link) {
        for (Throwable at = failure; at != null; at = at.getCause() == at ? null : at.getCause()) {
            if (link.test(at)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Stops every run in flight the way a budget does (they end as {@link Termination#INTERRUPTED}; one still in set-up
     * is closed without starting) and refuses new ones the same way. Waits up to the stop grace for their threads.
     */
    @Override
    public void close() {
        closed = true;
        for (Attempt attempt : inFlight) {
            attempt.abandon();
        }
        // Not shutdownNow(): its interrupt would reach a thread in set-up (see the class comment).
        executor.shutdown();
        try {
            if (!executor.awaitTermination(stopGrace.toMillis(), TimeUnit.MILLISECONDS)) {
                LOG.warn("{}: runs still in flight {} s after shutdown.", label, stopGrace.toSeconds());
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /**
     * One run on a pool thread: build the instance without its start function, then call {@code _start} inside the
     * try-with-resources so the instance (and its linear memory) is closed however {@code _start} ends.
     *
     * <p>Its states, under {@code lock}: not entered; building ({@code entered}); running ({@code started}, the only
     * state in which {@link #abandon()} interrupts the thread); settled (after {@code _start}, so an interrupt cannot
     * reach the instance's close).
     */
    private final class Attempt implements Callable<Void> {

        private final GuestEngine.Prepared prepared;
        private final Object lock = new Object();
        /** Counted down when the run's thread is done with the instance. */
        final CountDownLatch done = new CountDownLatch(1);
        /** Set just before {@code _start}: whatever fails before it is the runtime's failure, not the guest's. */
        volatile boolean started;
        private boolean entered;
        private boolean running;
        private boolean abandoned;
        private boolean finished;
        private boolean strayCounted;
        private Thread thread;
        /** The set-up's nanoseconds, or {@link #UNSET} for a run that is not timed (then nothing below is read). */
        private final long prepareNanos;
        private volatile long instantiating = UNSET;
        private volatile long instantiated = UNSET;
        private volatile long starting = UNSET;
        private volatile long startEnded = UNSET;

        Attempt(GuestEngine.Prepared prepared, long prepareNanos) {
            this.prepared = prepared;
            this.prepareNanos = prepareNanos;
        }

        private boolean timed() {
            return prepareNanos != UNSET;
        }

        /**
         * Where the run's time went, read when the run is answered; null for a run that is not timed. A step still going (a
         * stopped run whose thread has not ended) is measured up to now.
         */
        @Nullable RunTimings timings() {
            if (!timed()) {
                return null;
            }
            long now = System.nanoTime();
            return new RunTimings(prepareNanos, span(instantiating, instantiated, now), span(starting, startEnded, now));
        }

        private static long span(long from, long to, long now) {
            if (from == UNSET) {
                return RunTimings.NOT_RUN;
            }
            return (to == UNSET ? now : to) - from;
        }

        @Override
        public Void call() throws Exception {
            synchronized (lock) {
                if (abandoned) {
                    // Stopped before it began: there is nothing to close.
                    finish();
                    return null;
                }
                entered = true;
                thread = Thread.currentThread();
            }
            boolean timed = timed();
            try {
                if (timed) {
                    instantiating = System.nanoTime();
                }
                try (GuestEngine.Instance instance = prepared.instantiate()) {
                    if (timed) {
                        instantiated = System.nanoTime();
                    }
                    if (!begin()) {
                        // Abandoned during set-up: closed here without being started.
                        return null;
                    }
                    try {
                        if (timed) {
                            starting = System.nanoTime();
                        }
                        instance.start();
                    } finally {
                        if (timed) {
                            startEnded = System.nanoTime();
                        }
                        settle();
                    }
                }
                return null;
            } finally {
                finish();
            }
        }

        /** Enters {@code _start} unless the run was abandoned during set-up. */
        private boolean begin() {
            synchronized (lock) {
                if (abandoned) {
                    return false;
                }
                running = true;
                started = true;
                return true;
            }
        }

        /** Leaves {@code _start}: no interrupt is sent from here on, and one already sent is dropped before the close. */
        private void settle() {
            synchronized (lock) {
                running = false;
            }
            Thread.interrupted();
        }

        private void finish() {
            boolean wasStray;
            synchronized (lock) {
                finished = true;
                thread = null;
                wasStray = strayCounted;
            }
            if (wasStray) {
                strays.decrementAndGet();
            }
            done.countDown();
        }

        /**
         * Marks the run as abandoned (a stop or close) and interrupts its thread if, and only if, {@code _start} is
         * running; true when its body had begun, so there is a thread to wait for. A body that had not begun will not:
         * it sees the mark and returns. One in set-up finishes building, sees the mark and closes the instance.
         */
        boolean abandon() {
            synchronized (lock) {
                abandoned = true;
                if (running && thread != null) {
                    thread.interrupt();
                }
                return entered;
            }
        }

        /** Counts this run as a stray once, unless its thread has already finished; true when it was counted now. */
        boolean stray() {
            synchronized (lock) {
                if (finished || strayCounted) {
                    return false;
                }
                strayCounted = true;
                strays.incrementAndGet();
                return true;
            }
        }
    }
}
