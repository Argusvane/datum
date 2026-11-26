package com.argusvane.datum.sandbox.diagnostics;

import java.util.Objects;
import java.util.function.Consumer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Where a run's trace goes: the seam a host routes the {@link TraceRecord}s through, one per traced
 * run. It is called on the run's own thread once the run's slot has been released, so a slow trace never holds a slot (it
 * still holds that thread until it returns). The default is {@link #log()}, one INFO line per run on the SLF4J logger {@value #LOGGER}; a
 * host with a structured sink (an event bus, a metrics pipeline) supplies its own and reads the record's fields.
 *
 * <p>An observer, like the rest of the diagnostics: one that throws is logged and the run's answer stands. It should be quick,
 * because the caller's answer waits for it (though not the slot); a slow sink belongs behind a queue of the host's own.
 */
@FunctionalInterface
public interface RunTrace {

    /** The logger of the default trace. */
    String LOGGER = "datum.sandbox.trace";

    /** One traced run. */
    void trace(TraceRecord record);

    /** What the startup report says the trace goes to. */
    default String describe() {
        return getClass().getName();
    }

    /** The default: each record's {@link TraceRecord#line()} at INFO on {@value #LOGGER}, formatted only when INFO is on there. */
    static RunTrace log() {
        return new LogRunTrace(LoggerFactory.getLogger(LOGGER));
    }

    /** Each record's line handed to a sink: a host that writes lines its own way, and the tests of the line itself. */
    static RunTrace lines(Consumer<String> sink) {
        Objects.requireNonNull(sink, "sink");
        return record -> sink.accept(record.line());
    }

    /** {@link #log()}. */
    final class LogRunTrace implements RunTrace {

        private final Logger log;

        LogRunTrace(Logger log) {
            this.log = log;
        }

        @Override
        public void trace(TraceRecord record) {
            if (log.isInfoEnabled()) {
                log.info("{}", record.line());
            }
        }

        @Override
        public String describe() {
            return "the log " + LOGGER + " (INFO)";
        }
    }
}
