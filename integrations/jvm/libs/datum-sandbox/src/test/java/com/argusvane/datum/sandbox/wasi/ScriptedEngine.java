package com.argusvane.datum.sandbox.wasi;

import java.util.concurrent.atomic.AtomicInteger;

/**
 * An engine whose set-up and {@code _start} are test code: the harness's half of a run is proved with no WebAssembly
 * engine at all. A body sees the run's {@link GuestIo}.
 */
final class ScriptedEngine implements GuestEngine {

    /** One step of a run, given the run's streams and directory. */
    @FunctionalInterface
    interface Body {
        void run(GuestIo io) throws Exception;
    }

    /** The engine's own exit, as a WASI layer throws it. */
    static final class Exit extends RuntimeException {
        private static final long serialVersionUID = 1L;
        final int code;

        Exit(int code) {
            super("exit " + code);
            this.code = code;
        }
    }

    /** The engine's own trap. */
    static final class Trap extends RuntimeException {
        private static final long serialVersionUID = 1L;

        Trap(String message) {
            super(message);
        }
    }

    /** The engine's word for an interrupt it received. */
    static final class Interrupted extends RuntimeException {
        private static final long serialVersionUID = 1L;

        Interrupted() {
            super("machine interrupted");
        }
    }

    /** The engine's wrap of the JVM out of heap. */
    static final class OutOfHeap extends RuntimeException {
        private static final long serialVersionUID = 1L;

        OutOfHeap() {
            super("engine out of memory");
        }
    }

    volatile Body instantiate = io -> { };
    volatile Body start = io -> { };
    volatile boolean refusePdf;
    final AtomicInteger prepared = new AtomicInteger();
    final AtomicInteger preparedClosed = new AtomicInteger();
    final AtomicInteger instantiated = new AtomicInteger();
    final AtomicInteger started = new AtomicInteger();
    final AtomicInteger instancesClosed = new AtomicInteger();
    volatile GuestIo lastIo;

    @Override
    public EngineInfo info() {
        return new EngineInfo("scripted", "1.0", "native", "a test engine");
    }

    @Override
    public String where() {
        return "the scripted runner";
    }

    @Override
    public void admit(GuestRun run, Budget budget) {
        if (refusePdf && run.appFiles().containsKey("datum-pdf-program.js")) {
            throw new GuestUnavailableException("The scripted engine runs no PDF program.");
        }
    }

    @Override
    public Prepared prepare(GuestIo io, Budget budget) {
        prepared.incrementAndGet();
        lastIo = io;
        return new Prepared() {
            @Override
            public Instance instantiate() throws Exception {
                instantiate.run(io);
                instantiated.incrementAndGet();
                return new Instance() {
                    @Override
                    public void start() throws Exception {
                        started.incrementAndGet();
                        start.run(io);
                    }

                    @Override
                    public void close() {
                        instancesClosed.incrementAndGet();
                    }
                };
            }

            @Override
            public void close() {
                preparedClosed.incrementAndGet();
            }
        };
    }

    @Override
    public boolean interruptedBy(Throwable link) {
        return link instanceof Interrupted;
    }

    @Override
    public boolean outOfHeap(Throwable link) {
        return link instanceof OutOfHeap;
    }

    @Override
    public Ending ended(Throwable failure) {
        if (failure instanceof Exit exit) {
            return Ending.exited(exit.code);
        }
        if (failure instanceof Trap trap) {
            return Ending.trap("Trap: " + trap.getMessage());
        }
        return null;
    }

    /** A body that loops, answering an interrupt as a machine does (the sleep throws). */
    static void loopUntilInterrupted() throws InterruptedException {
        while (true) {
            Thread.sleep(5);
        }
    }
}
