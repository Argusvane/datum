package com.argusvane.datum.sandbox.wasi;

import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.List;
import java.util.Objects;

/**
 * What a run hands the guest, made by {@link RunHarness} for each run: an engine wires exactly these into WASI preview 1
 * and nothing else (no environment, no other preopen, no network).
 *
 * @param argv the guest's arguments, {@code argv[0]} included
 * @param stdin everything the guest may read
 * @param stdout the guest's stdout: a {@link BoundedOutputStream} whose write past the cap throws, unchecked, so the run
 *     ends at once; the engine lets that propagate (never maps it to an errno the guest could ignore)
 * @param stderr the guest's stderr, the same way
 * @param app the run's {@code /app}: a fresh in-memory directory holding only the {@link GuestRun}'s files, read-only,
 *     the guest's only preopen, mapped at the guest path {@code /app}
 * @param random the guest's entropy ({@code random_get}): a {@link SecureRandom}, as a wasmtime host gives OS entropy
 */
public record GuestIo(List<String> argv, InputStream stdin, OutputStream stdout, OutputStream stderr, Path app, SecureRandom random) {

    /** The guest path of {@link #app()}. */
    public static final String GUEST_APP = "/app";

    public GuestIo {
        argv = List.copyOf(argv);
        Objects.requireNonNull(stdin, "stdin");
        Objects.requireNonNull(stdout, "stdout");
        Objects.requireNonNull(stderr, "stderr");
        Objects.requireNonNull(app, "app");
        Objects.requireNonNull(random, "random");
    }
}
