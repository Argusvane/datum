package com.argusvane.datum.sandbox.wasi;

import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Objects;
import java.util.Random;

/**
 * What a run hands the guest, made by {@link RunHarness} for each run: an engine wires exactly these into WASI preview 1
 * and nothing else (no environment, no other preopen, no network).
 *
 * <p>The guest gets no real wall clock and no real randomness: {@code clock_time_get} on the realtime clock reads
 * {@link #GUEST_TIME} on every run, the file times of {@code /app} are the same instant, and {@code random_get} reads the
 * same bytes on every run ({@link #guestRandom()}). So what a rule module that imports {@code qjs:os} or {@code qjs:std} reads
 * of the date, of a file's times or of the entropy is the same for every submission, as the kernel's own {@code Date} and
 * {@code Math.random} (replaced by the run script) already are. QuickJS reads the realtime clock once at start, to seed
 * {@code Math.random} and its hash tables' seed, which so become fixed too: a fixed seed gives no less protection to its
 * {@code Map}, whose seed is XORed into the hash and so never separated two keys that collide. The pinned qjs-wasi does
 * not import {@code random_get} at all; the fixed stream holds for a module that does. The monotonic clock is not one of
 * these: it is the engine's to give (it times sleeps and the {@code qjs:os} timers), and it tells a guest how long it has
 * run, not when.
 *
 * @param argv the guest's arguments, {@code argv[0]} included
 * @param stdin everything the guest may read
 * @param stdout the guest's stdout: a {@link BoundedOutputStream} whose write past the cap throws, unchecked, so the run
 *     ends at once; the engine lets that propagate (never maps it to an errno the guest could ignore)
 * @param stderr the guest's stderr, the same way
 * @param app the run's {@code /app}: a fresh in-memory directory holding only the {@link GuestRun}'s files, read-only,
 *     the guest's only preopen, mapped at the guest path {@code /app}
 * @param random the guest's {@code random_get}: a fresh {@link #guestRandom()} for each run, so every run reads the same bytes
 * @param clock the guest's realtime clock ({@code clock_time_get} on {@code CLOCK_REALTIME}): {@link #guestClock()}
 */
public record GuestIo(List<String> argv, InputStream stdin, OutputStream stdout, OutputStream stderr, Path app, Random random,
                      Clock clock) {

    /** The guest path of {@link #app()}. */
    public static final String GUEST_APP = "/app";

    /** The wall-clock time every run reads, and the time of every file in its {@code /app}: the Unix epoch. */
    public static final Instant GUEST_TIME = Instant.EPOCH;

    /** The seed of every run's {@code random_get} stream. */
    public static final long GUEST_SEED = 0x5EEDL;

    public GuestIo {
        argv = List.copyOf(argv);
        Objects.requireNonNull(stdin, "stdin");
        Objects.requireNonNull(stdout, "stdout");
        Objects.requireNonNull(stderr, "stderr");
        Objects.requireNonNull(app, "app");
        Objects.requireNonNull(random, "random");
        Objects.requireNonNull(clock, "clock");
    }

    /** A run's {@code random_get} stream: the same bytes for every run, since each run gets a fresh one. */
    public static Random guestRandom() {
        return new Random(GUEST_SEED);
    }

    /** A run's realtime clock: {@link #GUEST_TIME}, whenever it is read. */
    public static Clock guestClock() {
        return Clock.fixed(GUEST_TIME, ZoneOffset.UTC);
    }
}
