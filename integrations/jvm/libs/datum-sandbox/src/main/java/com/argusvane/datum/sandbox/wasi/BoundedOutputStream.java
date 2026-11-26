package com.argusvane.datum.sandbox.wasi;

import java.io.ByteArrayOutputStream;
import java.io.OutputStream;

/**
 * An in-memory stream that refuses to grow past a cap: the stdout or stderr of one run ({@link RunHarness} makes one of each
 * per run at the {@link Budget}'s caps).
 *
 * <p>The memory limit does not bound output (a guest wrote 200 MiB under a 32 MiB cap), so the cap is enforced as the guest writes: the write that would pass
 * the cap keeps the bytes that fit and throws {@link OutputCapExceededException}, unchecked, so the run
 * aborts inside the guest's write; every write after that throws again (a runtime that swallowed the first
 * cannot let the guest carry on), and {@link #exceeded()} stays true for the classification. Exactly
 * {@code cap} bytes is allowed: the cap is the most a run may write, not one past it.
 */
public final class BoundedOutputStream extends OutputStream {

    private final String name;
    private final long cap;
    private final ByteArrayOutputStream buffer = new ByteArrayOutputStream();
    private boolean exceeded;

    /**
     * @param name "stdout" or "stderr", for the exception
     * @param cap the most bytes the stream holds
     */
    public BoundedOutputStream(String name, long cap) {
        if (cap < 0 || cap > Budget.MAX_OUTPUT_CAP) {
            // Past the longest array the buffer fails with an OutOfMemoryError before the cap could throw.
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
        long room = cap - buffer.size();
        if (length > room) {
            buffer.write(bytes, offset, (int) Math.max(0, room));
            exceeded = true;
            throw new OutputCapExceededException(name, cap);
        }
        buffer.write(bytes, offset, length);
    }

    /** Whether a write ever passed the cap. */
    public synchronized boolean exceeded() {
        return exceeded;
    }

    /** The bytes written, at most the cap. */
    public synchronized byte[] toByteArray() {
        return buffer.toByteArray();
    }

    /** The number of bytes held. */
    public synchronized int size() {
        return buffer.size();
    }

    /** The cap, in bytes. */
    public long cap() {
        return cap;
    }
}
