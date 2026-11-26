package com.argusvane.datum.sandbox.wasi;

/**
 * A run wrote past an output cap ({@link BoundedOutputStream}).
 *
 * <p>Unchecked on purpose: a WASI layer that maps an {@link java.io.IOException} from a stream to an
 * {@code EIO} errno would hand the guest a failed write it could ignore and keep writing. An engine lets this
 * propagate out of the guest's write, which stops the run at once, and the harness reports
 * {@link Termination#OUTPUT_CAP}. Not a {@link WasiException}: it is the stop itself, thrown through the guest's write,
 * never a refusal the caller is meant to catch.
 */
public final class OutputCapExceededException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    private final String stream;
    private final long cap;

    public OutputCapExceededException(String stream, long cap) {
        super("The run wrote more than " + cap + " bytes to " + stream + ".");
        this.stream = stream;
        this.cap = cap;
    }

    /** "stdout" or "stderr". */
    public String stream() {
        return stream;
    }

    /** The cap that was passed, in bytes. */
    public long cap() {
        return cap;
    }
}
