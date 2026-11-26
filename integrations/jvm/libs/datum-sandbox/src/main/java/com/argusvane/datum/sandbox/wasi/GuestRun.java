package com.argusvane.datum.sandbox.wasi;

import java.io.InputStream;
import java.nio.ByteBuffer;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;

/**
 * One run, as this layer takes it: the files of the guest's {@code /app}, its arguments,
 * its stdin and its {@link Budget}. Nothing else reaches the guest: {@link RunHarness} makes a fresh, read-only, in-memory
 * {@code /app} holding exactly {@link #appFiles()} as the guest's only preopen, and hands it no environment and no
 * network. The layer above decides what the files are (the Datum protocol puts the program and {@code run.js} there,
 * {@code ProgramRunner.guestRun}); this record knows no program.
 *
 * <p>The contents are held as read-only views, not copied, so a run of a 64 MiB stdin or a megabyte program costs no
 * second buffer per run: the canonical constructor shares what it is given, so hand it bytes nobody changes afterwards (a
 * fresh array, or a read-only view of bytes that never change, as a hashed program's are); {@link #of} copies arrays for a
 * caller that keeps writing to its own. Every accessor hands out a fresh read-only view, so no reader can change what the
 * next one reads.
 *
 * @param appFiles the files under {@code /app}, in the order they are written: name to content (the buffer's remaining
 *     bytes). A name is one plain file name: an ASCII letter or digit, then letters, digits, {@code .}, {@code _} or
 *     {@code -}, at most 255 characters; no directory, no dot segment, nothing a path could be built from
 * @param argv the guest's arguments, {@code argv[0]} included
 * @param stdin everything the guest may read (its remaining bytes)
 * @param budget the run's limits
 * @param timed whether the harness measures where the run's time goes ({@link RunOutput#timings()}): asked only by a host
 *     that traces or captures its runs, so a run nobody reads the timings of pays for no clock read
 */
public record GuestRun(Map<String, ByteBuffer> appFiles, List<String> argv, ByteBuffer stdin, Budget budget, boolean timed) {

    /** What a file name under {@code /app} may be. */
    private static final Pattern NAME = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._-]{0,254}");

    public GuestRun {
        Objects.requireNonNull(appFiles, "appFiles");
        Map<String, ByteBuffer> files = new LinkedHashMap<>();
        for (Map.Entry<String, ByteBuffer> file : appFiles.entrySet()) {
            String name = Objects.requireNonNull(file.getKey(), "a file name");
            if (!NAME.matcher(name).matches()) {
                throw new IllegalArgumentException("A file under /app has a plain name (a letter or digit, then letters, digits, '.', "
                    + "'_' or '-', at most 255 characters): \"" + name + "\"");
            }
            files.put(name, Objects.requireNonNull(file.getValue(), name).asReadOnlyBuffer());
        }
        appFiles = Collections.unmodifiableMap(files);
        argv = List.copyOf(argv);
        stdin = Objects.requireNonNull(stdin, "stdin").asReadOnlyBuffer();
        Objects.requireNonNull(budget, "budget");
    }

    /** A run that is not timed: what every caller but a diagnosing host makes. */
    public GuestRun(Map<String, ByteBuffer> appFiles, List<String> argv, ByteBuffer stdin, Budget budget) {
        this(appFiles, argv, stdin, budget, false);
    }

    /** A run over copies of these arrays: for a caller that may change its own afterwards. */
    public static GuestRun of(Map<String, byte[]> appFiles, List<String> argv, byte[] stdin, Budget budget) {
        Objects.requireNonNull(appFiles, "appFiles");
        Map<String, ByteBuffer> files = new LinkedHashMap<>();
        appFiles.forEach((name, bytes) -> files.put(name, ByteBuffer.wrap(Objects.requireNonNull(bytes, name).clone())));
        return new GuestRun(files, argv, ByteBuffer.wrap(Objects.requireNonNull(stdin, "stdin").clone()), budget);
    }

    /** The files under {@code /app}, in order, each a fresh read-only view. */
    @Override
    public Map<String, ByteBuffer> appFiles() {
        Map<String, ByteBuffer> views = new LinkedHashMap<>();
        appFiles.forEach((name, content) -> views.put(name, content.duplicate()));
        return Collections.unmodifiableMap(views);
    }

    /** The stdin, a fresh read-only view. */
    @Override
    public ByteBuffer stdin() {
        return stdin.duplicate();
    }

    /** The stdin as a stream, read in place. */
    public InputStream openStdin() {
        return new BufferInputStream(stdin.duplicate());
    }

    /** A copy of the stdin's bytes. */
    public byte[] stdinBytes() {
        return bytes(stdin);
    }

    /** A copy of one file's bytes, or null when {@code /app} has no file of that name. */
    public byte @Nullable [] file(String name) {
        ByteBuffer content = appFiles.get(name);
        return content == null ? null : bytes(content);
    }

    /** The bytes of every file under {@code /app} together. */
    public long appBytes() {
        long total = 0;
        for (ByteBuffer content : appFiles.values()) {
            total += content.remaining();
        }
        return total;
    }

    private static byte[] bytes(ByteBuffer buffer) {
        ByteBuffer view = buffer.duplicate();
        byte[] out = new byte[view.remaining()];
        view.get(out);
        return out;
    }

    /** The file names and sizes, the arguments and the budget; never a byte of a file or of stdin. */
    @Override
    public String toString() {
        StringBuilder files = new StringBuilder();
        appFiles.forEach((name, content) -> files.append(files.length() == 0 ? "" : ", ").append(name).append(" (")
            .append(content.remaining()).append(" bytes)"));
        return "GuestRun[/app: " + files + "; argv " + argv + "; stdin " + stdin.remaining() + " bytes; " + budget + (timed ? "; timed" : "") + "]";
    }

    /** An input stream over a buffer's remaining bytes, read in place. */
    private static final class BufferInputStream extends InputStream {

        private final ByteBuffer buffer;

        BufferInputStream(ByteBuffer buffer) {
            this.buffer = buffer;
        }

        @Override
        public int read() {
            return buffer.hasRemaining() ? buffer.get() & 0xff : -1;
        }

        @Override
        public int read(byte[] bytes, int offset, int length) {
            Objects.checkFromIndexSize(offset, length, bytes.length);
            if (length == 0) {
                return 0;
            }
            if (!buffer.hasRemaining()) {
                return -1;
            }
            int n = Math.min(length, buffer.remaining());
            buffer.get(bytes, offset, n);
            return n;
        }

        @Override
        public long skip(long n) {
            int skipped = (int) Math.max(0, Math.min(n, buffer.remaining()));
            buffer.position(buffer.position() + skipped);
            return skipped;
        }

        @Override
        public int available() {
            return buffer.remaining();
        }
    }
}
