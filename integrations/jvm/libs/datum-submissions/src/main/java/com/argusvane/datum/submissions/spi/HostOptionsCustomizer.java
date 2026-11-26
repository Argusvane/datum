package com.argusvane.datum.submissions.spi;

import com.argusvane.datum.sandbox.protocol.RunSettings;
import tools.jackson.databind.node.ObjectNode;

/**
 * Adjusts the host-decided context keys of one form's runs: {@code unknownFields} and {@code logLevel}
 * ({@link RunSettings}), per form. Every bean runs, in the framework's order (declare {@code @Order} where the relative order matters; equal orders keep registration order), for every run.
 *
 * <p>The site-wide host options ({@code today}'s time zone, {@code formulaErrors}, {@code riskyPatterns};
 * {@code datum.host.*}) are the {@link com.argusvane.datum.sandbox.protocol.HostOptions} bean, which an
 * application replaces to change them; the sandbox service sets them over every context, so no per-request
 * hook can loosen them.
 *
 * <p>A customizer that throws stops the request with 503 {@code validator_unavailable} (a {@code DatumException} it
 * throws answers as itself): a run under settings the form did not ask for is not the run it counts on.
 */
@FunctionalInterface
public interface HostOptionsCustomizer {

    /**
     * @param formKey the form
     * @param definition the server's definition (a copy)
     * @param settings the settings to change in place
     * @param submission who sent the document and through what: the same {@link SubmissionContext} every other
     *     hook of the run reads, whatever the channel
     */
    void customize(String formKey, ObjectNode definition, RunSettings settings, SubmissionContext submission);
}
