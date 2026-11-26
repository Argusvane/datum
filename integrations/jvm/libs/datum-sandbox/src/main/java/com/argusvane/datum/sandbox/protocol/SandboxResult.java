package com.argusvane.datum.sandbox.protocol;

import tools.jackson.databind.node.ObjectNode;

/**
 * What one validation answered.
 *
 * @param outcome the WasmSubmissionOutcome: {@code errors} always (a list), {@code values} only when nothing
 *     blocked, {@code logs}, and the later ABIs' keys ({@code clientDerived}, {@code pageComponentIds},
 *     {@code index}, {@code canonical}, {@code digest}, ...); readable as
 *     {@link com.argusvane.datum.core.contracts.SandboxOutcome}
 * @param elapsedMs wall time of the run, process start included
 */
public record SandboxResult(ObjectNode outcome, double elapsedMs) {
}
