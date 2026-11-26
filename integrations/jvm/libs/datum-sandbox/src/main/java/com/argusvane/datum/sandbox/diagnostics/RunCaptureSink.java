package com.argusvane.datum.sandbox.diagnostics;

import java.io.IOException;
import java.util.List;
import java.util.Objects;

/**
 * Where failed runs are kept: the seam a host replaces to store captures elsewhere (an object store,
 * say). The default is {@link DirectoryCaptureSink}, a hardened directory. Whatever the sink, {@link FailedRunCapture} keeps
 * the bounds and the queue: it calls the sink on its one writer thread, never on a run's, and asks it to {@link #remove} the
 * oldest captures past {@code max-runs} or {@code max-bytes}.
 *
 * <p>A sink stores a capture whole or not at all: a reader must never see a half-written one as complete. It names what it
 * stores only by {@link RunCapture#id()}, which holds no guest or request text.
 */
public interface RunCaptureSink {

    /**
     * Readies the sink at start and answers the captures it already holds, so the bounds count them. A sink that refuses to
     * start (the file sink's directory checks) throws {@link com.argusvane.datum.core.DatumConfigurationException}, which stops
     * the sandbox's start.
     */
    default List<Stored> open() throws IOException {
        return List.of();
    }

    /**
     * Stores one capture whole, or throws and leaves no part of it visible.
     *
     * @return the bytes it takes as stored, which the {@code max-bytes} bound counts
     */
    long write(RunCapture capture) throws IOException;

    /**
     * Removes one capture this sink stored ({@link #open()} or {@link #write}), for the bounds.
     *
     * @throws PartlyRemovedException when the capture is no longer held under its id but some of it could not be reclaimed
     *     (the file sink's {@code .evict-<id>} left behind): the bounds stop counting it, the failure is counted
     * @throws IOException when it could not be removed: it is still held, and the bounds go on counting it
     */
    void remove(String id) throws IOException;

    /**
     * Where the sink stores, for the startup WARN and report (a directory sink names its directory; nothing secret). It is
     * printed scrubbed ({@link Guarded#scrub}: a URL's user and password, query values), and one that throws is described by
     * its class name.
     */
    default String describe() {
        return getClass().getName();
    }

    /**
     * A capture the sink holds.
     *
     * @param id its {@link RunCapture#id()}
     * @param bytes what it takes
     */
    record Stored(String id, long bytes) {

        public Stored {
            Objects.requireNonNull(id, "id");
        }
    }

    /**
     * A removal that took the capture out of the sink's names but could not reclaim all of it: the capture no longer counts
     * against the bounds, and what is left is the operator's to remove (the file sink counts its {@code .evict-*} leftovers in
     * the start WARN).
     */
    final class PartlyRemovedException extends IOException {

        private static final long serialVersionUID = 1L;

        public PartlyRemovedException(String message, Throwable cause) {
            super(message, cause);
        }
    }
}
