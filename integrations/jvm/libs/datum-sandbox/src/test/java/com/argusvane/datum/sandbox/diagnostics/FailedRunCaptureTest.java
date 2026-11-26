package com.argusvane.datum.sandbox.diagnostics;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.DatumConfigurationException;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The capture's bounds, queue and writer, on the file sink and on sinks of the test's own: eviction by
 * count and by bytes, an oversize capture dropped, a full queue that drops without waiting, a write error that is counted, a
 * stop that drains, and the WARNs.
 */
class FailedRunCaptureTest {

    @TempDir
    Path temp;

    private final List<String> warnings = Collections.synchronizedList(new ArrayList<>());
    private final AtomicLong now = new AtomicLong();
    private FailedRunCapture capture;

    @AfterEach
    void stop() {
        if (capture != null) {
            capture.stop(Duration.ofSeconds(5));
        }
    }

    private FailedRunCapture capture(RunCaptureSink sink, int maxRuns, long maxBytes, long queueBytes) {
        capture = new FailedRunCapture(new CaptureSettings(true, null, maxRuns, maxBytes, queueBytes), sink, warnings::add, now::get);
        return capture;
    }

    private DirectoryCaptureSink directory() throws IOException {
        Path directory = temp.resolve("captures");
        Files.createDirectory(directory, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
        return new DirectoryCaptureSink(directory);
    }

    private static Set<String> captures(Path directory) throws IOException {
        try (Stream<Path> entries = Files.list(directory)) {
            return entries.map(path -> path.getFileName().toString()).filter(name -> RunCapture.ID.matcher(name).matches())
                .collect(Collectors.toSet());
        }
    }

    /** Waits until the queue is written (or the test's patience ends). */
    private static void drained(FailedRunCapture capture, long written) throws InterruptedException {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while ((capture.counts().written() + capture.counts().failed() < written || capture.pendingBytes() > 0) && System.nanoTime() < until) {
            Thread.sleep(5);
        }
    }

    /** A sink in memory that can be held at its next write. */
    private static final class MemorySink implements RunCaptureSink {

        final Map<String, Long> held = new ConcurrentHashMap<>();
        final List<String> removed = Collections.synchronizedList(new ArrayList<>());
        final Set<String> writers = ConcurrentHashMap.newKeySet();
        volatile CountDownLatch gate;
        volatile boolean swallowInterrupts;
        volatile CountDownLatch entered = new CountDownLatch(1);
        volatile IOException failure;
        volatile Throwable errorOnce;
        volatile IOException removeFailure;
        volatile String described = "the test's memory";
        final List<RunCaptureSink.Stored> before = new ArrayList<>();

        @Override
        public List<Stored> open() {
            before.forEach(stored -> held.put(stored.id(), stored.bytes()));
            return List.copyOf(before);
        }

        @Override
        public long write(RunCapture capture) throws IOException {
            writers.add(Thread.currentThread().getName());
            entered.countDown();
            Throwable once = errorOnce;
            if (once != null) {
                errorOnce = null;
                if (once instanceof Error error) {
                    throw error;
                }
                throw (RuntimeException) once;
            }
            CountDownLatch wait = gate;
            while (wait != null) {
                try {
                    wait.await();
                    break;
                } catch (InterruptedException e) {
                    if (!swallowInterrupts) {
                        Thread.currentThread().interrupt();
                        throw new java.io.InterruptedIOException();
                    }
                    // Like many clients: the interrupt is dropped and the wait goes on.
                }
            }
            if (failure != null) {
                throw failure;
            }
            held.put(capture.id(), capture.bytes());
            return capture.bytes();
        }

        @Override
        public void remove(String id) throws IOException {
            IOException refused = removeFailure;
            if (refused != null) {
                removeFailure = null;
                throw refused;
            }
            removed.add(id);
            held.remove(id);
        }

        @Override
        public String describe() {
            String text = described;
            if (text == null) {
                throw new IllegalStateException("describe() is broken");
            }
            return text;
        }
    }

    // ---------------------------------------------------------------------------------------------- start

    @Test
    void theStartWarnsOnceThatCapturesHoldPersonalDataInClearTextNamingTheDirectory() throws IOException {
        DirectoryCaptureSink sink = directory();
        capture(sink, 20, 1 << 20, 1 << 20).start();
        assertThat(warnings).singleElement().asString().contains(sink.directory().toString()).contains("submitted answers")
            .contains("form definition").contains("personal data").contains("clear text").contains("datum.runtime.diagnostics.capture.enabled");
        capture.start();
        assertThat(warnings).as("starting again warns no more").hasSize(1);
    }

    @Test
    void aRefusedDirectoryStopsTheStartAndStartsNoWriter() throws IOException {
        Path loose = temp.resolve("loose");
        Files.createDirectory(loose, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwxr-xr-x")));
        long writers = writerThreads();
        assertThatThrownBy(() -> capture(new DirectoryCaptureSink(loose), 20, 1 << 20, 1 << 20).start())
            .isInstanceOf(DatumConfigurationException.class);
        assertThat(writerThreads()).isEqualTo(writers);
        assertThat(warnings).isEmpty();
        assertThat(capture.offer(Captures.of(Captures.id(1), 1))).as("nothing is taken").isFalse();
    }

    private static long writerThreads() {
        return Thread.getAllStackTraces().keySet().stream().filter(t -> t.isAlive() && t.getName().startsWith("datum-sandbox-capture-")).count();
    }

    // ---------------------------------------------------------------------------------------------- eviction

    @Test
    void theOldestCapturesAreEvictedPastMaxRuns() throws Exception {
        DirectoryCaptureSink sink = directory();
        capture(sink, 3, 1 << 30, 1 << 30).start();
        List<String> ids = new ArrayList<>();
        for (int i = 0; i < 5; i++) {
            String id = Captures.id(i);
            ids.add(id);
            assertThat(capture.offer(Captures.of(id, 100))).isTrue();
        }
        drained(capture, 5);
        assertThat(captures(sink.directory())).containsExactlyInAnyOrderElementsOf(ids.subList(2, 5));
        assertThat(capture.counts()).isEqualTo(new FailedRunCapture.Counts(0, 0, 5, 3));
    }

    @Test
    void theOldestCapturesAreEvictedPastMaxBytesCountingWhatWasThereAtStart() throws Exception {
        DirectoryCaptureSink sink = directory();
        String old = Captures.id(0);
        FailedRunCapture first = capture(sink, 100, 1 << 30, 1 << 30);
        first.start();
        first.offer(Captures.of(old, 4000));
        drained(first, 1);
        first.stop(Duration.ofSeconds(5));

        // Each capture is a little over 4000 bytes (meta.json, stdin, stderr, run.js): two fit under 10000, three do not.
        FailedRunCapture second = capture(sink, 100, 10_000, 1 << 30);
        second.start();
        assertThat(second.counts().stored()).isEqualTo(1);
        String a = Captures.id(1);
        String b = Captures.id(2);
        second.offer(Captures.of(a, 4000));
        second.offer(Captures.of(b, 4000));
        drained(second, 2);
        assertThat(captures(sink.directory())).containsExactlyInAnyOrder(a, b);
        assertThat(second.counts().stored()).isEqualTo(2);
    }

    @Test
    void aCaptureLargerThanMaxBytesIsDroppedAndCounted() throws Exception {
        MemorySink sink = new MemorySink();
        capture(sink, 20, 10_000, 1 << 30).start();
        warnings.clear();
        assertThat(capture.offer(Captures.of(Captures.id(1), 20_000))).isFalse();
        assertThat(capture.counts().dropped()).isEqualTo(1);
        assertThat(capture.offer(Captures.of(Captures.id(2), 100))).isTrue();
        drained(capture, 1);
        assertThat(sink.held).hasSize(1);
        assertThat(warnings).singleElement().asString().contains("max-bytes").contains("1 dropped");
    }

    @Test
    void evictionRemovesOnlyThroughTheSinkAndASinkThatHeldCapturesBeforeIsTrimmed() throws Exception {
        MemorySink sink = new MemorySink();
        String a = Captures.id(0);
        String b = Captures.id(1);
        sink.before.add(new RunCaptureSink.Stored(a, 10));
        sink.before.add(new RunCaptureSink.Stored(b, 10));
        capture(sink, 2, 1 << 30, 1 << 30).start();
        String c = Captures.id(2);
        capture.offer(Captures.of(c, 10));
        drained(capture, 1);
        assertThat(sink.removed).containsExactly(a);
        assertThat(sink.held.keySet()).containsExactlyInAnyOrder(b, c);
    }

    // ---------------------------------------------------------------------------------------------- the queue

    @Test
    void aFullQueueDropsWithoutBlockingTheRun() throws Exception {
        MemorySink sink = new MemorySink();
        sink.gate = new CountDownLatch(1);
        capture(sink, 100, 1 << 30, 50_000).start();
        warnings.clear();
        // The first is taken by the writer, which the slow sink holds; the queue then fills.
        assertThat(capture.offer(Captures.of(Captures.id(0), 20_000))).isTrue();
        assertThat(sink.entered.await(5, TimeUnit.SECONDS)).isTrue();
        assertThat(capture.offer(Captures.of(Captures.id(1), 20_000))).isTrue();
        long started = System.nanoTime();
        int refused = 0;
        for (int i = 2; i < 50; i++) {
            if (!capture.offer(Captures.of(Captures.id(i), 20_000))) {
                refused++;
            }
        }
        long tookMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
        assertThat(refused).isEqualTo(48);
        assertThat(tookMillis).as("offers never wait for the held sink").isLessThan(2_000);
        assertThat(capture.counts().dropped()).isEqualTo(48);
        assertThat(capture.pendingBytes()).isLessThanOrEqualTo(50_000);
        assertThat(warnings).as("one WARN a minute at most, at the first drop").singleElement().asString().contains("queue is full").contains("1 dropped")
            .doesNotContain("Ada");

        now.addAndGet(FailedRunCapture.WARN_EVERY.toNanos());
        capture.offer(Captures.of(Captures.id(60), 20_000));
        assertThat(warnings).as("a minute later, one more").hasSize(2);

        sink.gate.countDown();
        drained(capture, 2);
        assertThat(sink.held).hasSize(2);
        assertThat(capture.pendingBytes()).isZero();
    }

    @Test
    void aWriteErrorIsCountedAndWarnedWithoutItsMessageAndTheNextWriteGoesOn() throws Exception {
        MemorySink sink = new MemorySink();
        sink.failure = new IOException("disk full at /secret/path");
        capture(sink, 20, 1 << 30, 1 << 30).start();
        warnings.clear();
        String id = Captures.id(1);
        assertThat(capture.offer(Captures.of(id, 10))).as("the run sees a queued capture; the write fails later").isTrue();
        drained(capture, 1);
        assertThat(capture.counts().failed()).isEqualTo(1);
        assertThat(warnings).singleElement().asString().contains(id).contains("java.io.IOException").doesNotContain("/secret/path")
            .contains("answer is unchanged");
        sink.failure = null;
        capture.offer(Captures.of(Captures.id(2), 10));
        drained(capture, 2);
        assertThat(capture.counts().written()).isEqualTo(1);
    }

    // ---------------------------------------------------------------------------------------------- stop

    @Test
    void stopDrainsTheQueueWithinTheGrace() throws Exception {
        long writers = writerThreads();
        DirectoryCaptureSink sink = directory();
        capture(sink, 100, 1 << 30, 1 << 30).start();
        Set<String> ids = new java.util.HashSet<>();
        for (int i = 0; i < 20; i++) {
            String id = Captures.id(i);
            ids.add(id);
            capture.offer(Captures.of(id, 50_000));
        }
        capture.stop(Duration.ofSeconds(30));
        assertThat(captures(sink.directory())).isEqualTo(ids);
        assertThat(capture.counts().dropped()).isZero();
        assertThat(writerThreads()).isEqualTo(writers);
        assertThat(capture.offer(Captures.of(Captures.id(99), 1))).as("a stopped capture takes nothing").isFalse();
    }

    @Test
    void stopDropsWhatIsStillWaitingAfterTheGrace() throws Exception {
        long writers = writerThreads();
        MemorySink sink = new MemorySink();
        sink.gate = new CountDownLatch(1);
        capture(sink, 100, 1 << 30, 1 << 30).start();
        for (int i = 0; i < 5; i++) {
            capture.offer(Captures.of(Captures.id(i), 10));
        }
        assertThat(sink.entered.await(5, TimeUnit.SECONDS)).isTrue();
        long started = System.nanoTime();
        capture.stop(Duration.ofMillis(200));
        assertThat(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)).isLessThan(3_000);
        assertThat(capture.counts().dropped()).isEqualTo(4);
        assertThat(capture.counts().failed()).as("the write the stop interrupted").isEqualTo(1);
        assertThat(capture.pendingBytes()).isZero();
        assertThat(warnings).anySatisfy(w -> assertThat(w).contains("4 failed-run capture(s) were still waiting"));
        assertThat(writerThreads()).isEqualTo(writers);
    }

    // ---------------------------------------------------------------------------------------------- failure containment and scrubbing

    private static void eventually(java.util.function.BooleanSupplier condition) throws InterruptedException {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (!condition.getAsBoolean() && System.nanoTime() < until) {
            Thread.sleep(5);
        }
        assertThat(condition.getAsBoolean()).as("in time").isTrue();
    }

    /** An Error from the sink is one failed write; the writer lives, and the next captures are written. */
    @Test
    void anErrorFromTheSinkIsCountedAndTheWriterGoesOn() throws Exception {
        MemorySink sink = new MemorySink();
        sink.errorOnce = new AssertionError("a sink bug");
        capture(sink, 20, 1 << 30, 1 << 30).start();
        warnings.clear();
        capture.offer(Captures.of(Captures.id(1), 10));
        drained(capture, 1);
        assertThat(capture.counts().failed()).isEqualTo(1);
        assertThat(warnings).singleElement().asString().contains("java.lang.AssertionError").doesNotContain("a sink bug");
        for (int i = 2; i < 12; i++) {
            assertThat(capture.offer(Captures.of(Captures.id(i), 10))).as("queued, not a full queue").isTrue();
        }
        drained(capture, 11);
        assertThat(capture.counts()).isEqualTo(new FailedRunCapture.Counts(0, 1, 10, 10));
        assertThat(capture.pendingBytes()).isZero();
    }

    /**
     * A sink that swallows interrupts outlives its stop; it writes nothing more, a start is refused until it has ended,
     * and then one writer alone takes the captures.
     */
    @Test
    void aWriterThatOutlivesItsStopNeverSharesTheQueueWithTheNextStart() throws Exception {
        long writers = writerThreads();
        MemorySink sink = new MemorySink();
        sink.gate = new CountDownLatch(1);
        sink.swallowInterrupts = true;
        FailedRunCapture swallowing = capture(sink, 1000, 1 << 30, 1 << 30);
        swallowing.start();
        swallowing.offer(Captures.of(Captures.id(0), 10));
        swallowing.offer(Captures.of(Captures.id(1), 10));
        assertThat(sink.entered.await(5, TimeUnit.SECONDS)).isTrue();
        swallowing.stop(Duration.ofMillis(200));
        assertThat(writerThreads()).as("the swallowing writer is still in its write").isEqualTo(writers + 1);
        assertThatThrownBy(swallowing::start).isInstanceOf(IllegalStateException.class).hasMessageContaining("still finishing a write");

        sink.gate.countDown();
        sink.gate = null;
        eventually(() -> writerThreads() == writers);
        assertThat(sink.held).as("it finished the write it was in, and took nothing more").hasSize(1);
        sink.writers.clear();
        swallowing.start();
        for (int i = 2; i < 22; i++) {
            swallowing.offer(Captures.of(Captures.id(i), 10));
        }
        drained(swallowing, 21);
        assertThat(sink.writers).as("one writer").hasSize(1);
        assertThat(writerThreads()).isEqualTo(writers + 1);
        swallowing.stop(Duration.ofSeconds(5));
        assertThat(writerThreads()).isEqualTo(writers);
    }

    /** A clock stepped back names the newest capture before the old ones; eviction keeps it and takes the oldest other. */
    @Test
    void theCaptureJustWrittenIsNeverEvictedWhenTheClockSteppedBack() throws Exception {
        MemorySink sink = new MemorySink();
        capture(sink, 2, 1 << 30, 1 << 30).start();
        String noon = RunCapture.id(java.time.Instant.parse("2026-11-23T12:00:00Z"), Captures.runId());
        String later = RunCapture.id(java.time.Instant.parse("2026-11-23T12:00:01Z"), Captures.runId());
        String stepped = RunCapture.id(java.time.Instant.parse("2026-11-23T11:00:00Z"), Captures.runId());
        capture.offer(Captures.of(noon, 10));
        capture.offer(Captures.of(later, 10));
        drained(capture, 2);
        capture.offer(Captures.of(stepped, 10));
        drained(capture, 3);
        assertThat(sink.held.keySet()).containsExactlyInAnyOrder(later, stepped);
        assertThat(sink.removed).containsExactly(noon);
        assertThat(capture.counts().stored()).isEqualTo(2);
    }

    /**
     * A removal the sink refuses keeps the capture held and counted (one failure), and the next write removes it; one
     * the sink did only in part is out of the count.
     */
    @Test
    void aRefusedRemovalKeepsTheCaptureCountedAndAPartialOneDoesNot() throws Exception {
        MemorySink sink = new MemorySink();
        capture(sink, 2, 1 << 30, 1 << 30).start();
        String a = Captures.id(0);
        String b = Captures.id(1);
        String c = Captures.id(2);
        capture.offer(Captures.of(a, 10));
        capture.offer(Captures.of(b, 10));
        drained(capture, 2);
        sink.removeFailure = new IOException("rename refused");
        capture.offer(Captures.of(c, 10));
        drained(capture, 3);
        assertThat(capture.counts().failed()).as("counted once").isEqualTo(1);
        // a was refused, so the pass went on to b: the bound holds without a, which is still held and counted.
        assertThat(sink.held.keySet()).containsExactlyInAnyOrder(a, c);
        assertThat(capture.counts().stored()).isEqualTo(2);
        String d = Captures.id(3);
        capture.offer(Captures.of(d, 10));
        drained(capture, 4);
        assertThat(sink.held.keySet()).as("the next write takes a").containsExactlyInAnyOrder(c, d);

        sink.removeFailure = new RunCaptureSink.PartlyRemovedException("left behind", new IOException("delete refused"));
        capture.offer(Captures.of(Captures.id(4), 10));
        drained(capture, 5);
        assertThat(capture.counts().failed()).isEqualTo(2);
        assertThat(capture.counts().stored()).as("out of the names, out of the count").isEqualTo(2);
    }

    /** A refused removal that is the only candidate ends the pass (no spin), the capture still held and counted. */
    @Test
    void aRemovalAlwaysRefusedEndsThePass() throws Exception {
        MemorySink sink = new MemorySink();
        capture(sink, 1, 1 << 30, 1 << 30).start();
        capture.offer(Captures.of(Captures.id(0), 10));
        drained(capture, 1);
        sink.removeFailure = new IOException("refused");
        capture.offer(Captures.of(Captures.id(1), 10));
        drained(capture, 2);
        assertThat(capture.counts()).isEqualTo(new FailedRunCapture.Counts(0, 1, 2, 2));
    }

    /**
     * A describe() that throws is the sink's class name and refuses nothing; a description with a URL's
     * user, password or token is printed scrubbed.
     */
    @Test
    void aSinkDescriptionIsGuardedAndScrubbed() throws Exception {
        MemorySink broken = new MemorySink();
        broken.described = null;
        capture(broken, 20, 1 << 30, 1 << 30).start();
        assertThat(warnings).singleElement().asString().contains(MemorySink.class.getName());
        capture.offer(Captures.of(Captures.id(1), 10));
        drained(capture, 1);
        assertThat(capture.counts().written()).isEqualTo(1);
        assertThat(capture.describe()).isEqualTo(MemorySink.class.getName());
        capture.stop(Duration.ofSeconds(5));

        warnings.clear();
        MemorySink secret = new MemorySink();
        secret.described = "the bucket https://key:secret@minio/captures?token=abc&region=x";
        capture(secret, 20, 1 << 30, 1 << 30).start();
        assertThat(warnings).singleElement().asString().contains("https://***@minio/captures?token=***&region=***")
            .doesNotContain("secret").doesNotContain("abc");
    }

    /** A start that fails after its writer began (the WARN's own sink throws) stops that writer before it throws. */
    @Test
    void aStartThatFailsAfterItsWriterBeganStopsTheWriter() throws Exception {
        long writers = writerThreads();
        FailedRunCapture failing = new FailedRunCapture(new CaptureSettings(true, null, 20, 1 << 20, 1 << 20), new MemorySink(), text -> {
            throw new IllegalStateException("the log is down");
        }, now::get);
        assertThatThrownBy(failing::start).isInstanceOf(IllegalStateException.class).hasMessage("the log is down");
        eventually(() -> writerThreads() == writers);
        assertThat(failing.offer(Captures.of(Captures.id(1), 1))).as("a failed start takes nothing").isFalse();
    }

    /** One deadline: a stop never takes longer than its grace; with none left, what is queued is dropped at once (counted). */
    @Test
    void aStopTakesNoLongerThanItsGraceAndNoGraceDropsAtOnce() throws Exception {
        MemorySink sink = new MemorySink();
        sink.gate = new CountDownLatch(1);
        capture(sink, 100, 1 << 30, 1 << 30).start();
        for (int i = 0; i < 4; i++) {
            capture.offer(Captures.of(Captures.id(i), 10));
        }
        assertThat(sink.entered.await(5, TimeUnit.SECONDS)).isTrue();
        long started = System.nanoTime();
        capture.stop(Duration.ZERO);
        assertThat(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)).as("no grace: no wait").isLessThan(200);
        assertThat(capture.counts().dropped()).isEqualTo(3);
        assertThat(capture.pendingBytes()).as("the interrupted write is still being given up").isLessThanOrEqualTo(Captures.of(Captures.id(9), 10).bytes());

        MemorySink slow = new MemorySink();
        slow.gate = new CountDownLatch(1);
        slow.swallowInterrupts = true;
        capture(slow, 100, 1 << 30, 1 << 30).start();
        capture.offer(Captures.of(Captures.id(10), 10));
        assertThat(slow.entered.await(5, TimeUnit.SECONDS)).isTrue();
        started = System.nanoTime();
        capture.stop(Duration.ofMillis(500));
        assertThat(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)).as("within the grace, even for a sink that ignores the interrupt")
            .isLessThan(700);
        slow.gate.countDown();
        capture = null;
    }
}
