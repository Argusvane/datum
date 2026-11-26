package com.argusvane.datum.sandbox.wasi;

import org.jspecify.annotations.Nullable;

/**
 * What an engine implements under {@link RunHarness}: instantiate the module over the streams and the directory of one
 * run, call {@code _start}, and say what its own exceptions mean. Everything else about a run (the worker thread, the
 * budget, the file system, the caps, the strays, the classification) is the harness's, so it is written once.
 *
 * <p>The order the harness calls it in: {@link #admit} on the caller's thread before anything is made; {@link #prepare}
 * on the caller's thread (the engine's WASI layer, closed by the caller when the run is answered); then, on the run's
 * worker thread, {@link Prepared#instantiate()}, which is never interrupted, and {@link Instance#start()}, the only call
 * a stop interrupts; finally {@link Instance#close()} on the worker thread however {@code start()} ended.
 */
public interface GuestEngine {

    /** What the engine reports about itself; read once, when the harness is made. */
    EngineInfo info();

    /** Where the module runs, for messages: {@code the jffi runner}. */
    String where();

    /**
     * Refuses, before anything of the run is made, one this engine cannot run here: a budget it cannot honour
     * ({@link IllegalArgumentException}), or a run it cannot start ({@link GuestUnavailableException}). It sees the run and
     * never a program: which programs may run on which mode is the layer above's decision. The
     * default admits everything.
     *
     * @param run the run, its files, arguments and stdin
     * @param budget the run's budget, {@code run.budget()}
     */
    default void admit(GuestRun run, Budget budget) {
    }

    /**
     * Wires one run's streams, arguments, entropy and directory into the engine's WASI layer, on the caller's thread.
     * The budget's memory limit is the engine's to apply when it instantiates.
     */
    Prepared prepare(GuestIo io, Budget budget);

    /**
     * Whether one link of a failure's cause chain is the engine's word for an interrupt it received (a stop or a
     * shutdown); {@link InterruptedException} is recognised without it.
     */
    default boolean interruptedBy(Throwable link) {
        return false;
    }

    /**
     * Whether one link of a failure's cause chain is the engine's wrap of the JVM running out of heap;
     * {@link OutOfMemoryError} is recognised without it. Such a run is the host's stop, never the guest's budget.
     */
    default boolean outOfHeap(Throwable link) {
        return false;
    }

    /**
     * How a run that started and threw ended, in the engine's own exception types: a WASI exit with its code, a trap with
     * its message; null when the failure is not one of the engine's (the harness's rules then apply).
     */
    default @Nullable Ending ended(Throwable failure) {
        return null;
    }

    /** A run wired into the engine's WASI layer, not yet instantiated; closed by the caller when the run is answered. */
    interface Prepared extends AutoCloseable {

        /**
         * Builds the instance with the budget's memory limit and without running its start function. Runs on the
         * worker thread and is never interrupted: an engine that maps linear memory before it constructs the instance
         * would otherwise leak it. Should it fail after making native memory, the engine frees that memory first.
         */
        Instance instantiate() throws Exception;

        @Override
        void close();
    }

    /** One built instance of the module. */
    interface Instance extends AutoCloseable {

        /** Calls {@code _start}; the harness interrupts the worker thread only while this runs. */
        void start() throws Exception;

        /** Frees the instance and its linear memory. */
        @Override
        void close() throws Exception;
    }

    /**
     * How a started run ended in the engine's words.
     *
     * @param termination {@link Termination#EXITED} or {@link Termination#TRAP}
     * @param exitCode the exit code of an exit
     * @param trapMessage the trap's description, for the log
     */
    record Ending(Termination termination, int exitCode, @Nullable String trapMessage) {

        public Ending {
            if (termination != Termination.EXITED && termination != Termination.TRAP) {
                throw new IllegalArgumentException("An engine reports an exit or a trap; the harness reports the rest: " + termination);
            }
        }

        /** The guest exited with this code ({@code proc_exit}). */
        public static Ending exited(int exitCode) {
            return new Ending(Termination.EXITED, exitCode, null);
        }

        /** The module trapped. */
        public static Ending trap(@Nullable String message) {
            return new Ending(Termination.TRAP, -1, message);
        }
    }
}
