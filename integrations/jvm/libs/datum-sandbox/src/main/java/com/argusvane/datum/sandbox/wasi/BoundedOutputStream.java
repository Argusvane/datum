package com.argusvane.datum.sandbox.wasi;

import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * An in-memory stream that refuses to grow past a cap: the stdout or stderr of one run ({@link RunHarness} makes one of each
 * per run at the {@link Budget}'s caps).
 *
 * <p>The memory limit does not bound output (a guest wrote 200 MiB under a 32 MiB cap), so the cap is enforced as the guest writes: the write that would pass
 * the cap keeps the bytes that fit and throws {@link OutputCapExceededException}, unchecked, so the run
 * aborts inside the guest's write; every write after that throws again (a runtime that swallowed the first
 * cannot let the guest carry on), and {@link #exceeded()} stays true for the classification. Exactly
 * {@code cap} bytes is allowed: the cap is the most a run may write, not one past it.
 *
 * <p>The bytes are kept in chunks of at most {@link #CHUNK}, each allocated when the one before is full and never larger than
 * the room left under the cap, so what the stream allocates is never more than the cap, nor more than one chunk past what
 * was written. A buffer that doubles as it grows would hold up to twice the cap, and copy all it held at each doubling.
 */
public final class BoundedOutputStream extends OutputStream {

    /** The largest chunk: 1 MiB, so a run that writes a little allocates a little, and a long output few arrays. */
    static final int CHUNK = 1 << 20;

    /** The first chunk: 8 KiB (a cap below it, the cap), so a run that prints one line takes one small array. */
    static final int FIRST_CHUNK = 8192;

    private final String name;
    private final long cap;
    private final List<byte[]> chunks = new ArrayList<>();
    /** Bytes used in the last chunk. */
    private int used;
    /** Bytes written, at most the cap. */
    private int size;
    /** Bytes allocated across the chunks, at most the cap. */
    private long allocated;
    private boolean exceeded;

    /**
     * @param name "stdout" or "stderr", for the exception
     * @param cap the most bytes the stream holds
     */
    public BoundedOutputStream(String name, long cap) {
        if (cap < 0 || cap > Budget.MAX_OUTPUT_CAP) {
            // Past the longest array the copy-out fails with an OutOfMemoryError before the cap could throw.
            throw new IllegalArgumentException("A cap is zero to " + Budget.MAX_OUTPUT_CAP + " bytes.");
        }
        this.name = name;
        this.cap = cap;
    }

    @Override
    public synchronized void write(int b) {
        write(new byte[] {(byte) b}, 0, 1);
    }

    @Override
    public synchronized void write(byte[] bytes, int offset, int length) {
        if (offset < 0 || length < 0 || offset + length > bytes.length) {
            throw new IndexOutOfBoundsException();
        }
        if (exceeded) {
            throw new OutputCapExceededException(name, cap);
        }
        long room = cap - size;
        if (length > room) {
            append(bytes, offset, (int) room);
            exceeded = true;
            throw new OutputCapExceededException(name, cap);
        }
        append(bytes, offset, length);
    }

    /** Copies bytes that fit under the cap into the chunks, adding chunks as they fill. */
    private void append(byte[] bytes, int offset, int length) {
        int at = offset;
        int left = length;
        while (left > 0) {
            byte[] last = chunks.isEmpty() ? null : chunks.get(chunks.size() - 1);
            if (last == null || used == last.length) {
                last = new byte[nextChunk()];
                chunks.add(last);
                allocated += last.length;
                used = 0;
            }
            int n = Math.min(left, last.length - used);
            System.arraycopy(bytes, at, last, used, n);
            used += n;
            size += n;
            at += n;
            left -= n;
        }
    }

    /** The next chunk's length: twice the last, between {@link #FIRST_CHUNK} and {@link #CHUNK}, never past the room under the cap. */
    private int nextChunk() {
        long wanted = chunks.isEmpty() ? FIRST_CHUNK : Math.min(CHUNK, 2L * chunks.get(chunks.size() - 1).length);
        return (int) Math.min(wanted, cap - allocated);
    }

    /** Whether a write ever passed the cap. */
    public synchronized boolean exceeded() {
        return exceeded;
    }

    /** The bytes written, at most the cap. */
    public synchronized byte[] toByteArray() {
        byte[] all = new byte[size];
        int at = 0;
        for (byte[] chunk : chunks) {
            int n = Math.min(chunk.length, size - at);
            System.arraycopy(chunk, 0, all, at, n);
            at += n;
        }
        return all;
    }

    /** The number of bytes held. */
    public synchronized int size() {
        return size;
    }

    /** The bytes the stream has allocated to hold them: never more than the cap. */
    synchronized long allocated() {
        return allocated;
    }

    /** The cap, in bytes. */
    public long cap() {
        return cap;
    }
}
