package com.argusvane.datum.sandbox.events;

import java.time.Duration;

/**
 * A program run was stopped by a limit before it answered: its time budget, its memory, a trap or an output
 * cap. Published by the runtime wrapper after the run, from the thread that asked for it.
 *
 * <p>Delivery: synchronously on that thread, before the run's own refusal goes on to its caller (which may
 * be inside the application's transaction: the event then is too). A listener that throws is logged and the caller gets
 * the run's answer all the same; it cannot change it.
 *
 * @param program {@code sandbox} or {@code pdf}
 * @param reason {@code budget}, {@code memory}, {@code trap} or {@code output-cap}
 * @param elapsed the run's wall time
 */
public record SandboxRunInterruptedEvent(String program, String reason, Duration elapsed) {
}
