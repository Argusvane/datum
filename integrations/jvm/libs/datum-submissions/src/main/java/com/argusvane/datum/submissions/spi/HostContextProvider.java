package com.argusvane.datum.submissions.spi;

import java.util.Map;
import java.util.Optional;

/**
 * Supplies the values a form's {@code host.} names read ({@code host.role}, {@code host.region}) for one sandbox run, as
 * the run context's {@code hostContext}. The application works them out from what it knows
 * of the request: the signed-in principal, a header its own gateway set, the site the request came through. It never takes
 * them from the request body or the browser: the page's own {@code hostContext} is for display, a client can set it to
 * anything, and the envelope does not carry it. One per application (the Spring binding takes a single bean); with none,
 * no run carries a context.
 *
 * <p>Empty is "no context": the kernel judges leniently (a rule reading {@code host.} is left unevaluated, a field the
 * host shows is not required and is listed in {@code visibilitySkipped}, a calculation keeps the value sent). A map, even an empty one, is a context: every rule reading {@code host.} is judged against it, and a
 * key it lacks reads as no answer, as in the browser. Nested maps are read by dotted name ({@code host.user.role}).
 *
 * <p>Asked once per call that runs the sandbox: a delivery ({@code POST /submissions}), a journey's page or whole-journey
 * check ({@code /submissions/validate}), a dry run ({@code /submissions/test}) and the dry run behind a PDF
 * ({@link SubmissionMode#PDF}; the PDF routes ask again for the print, with the same facts, so the PDF is drawn under the
 * values its answers were judged under). Not asked for a delivery answered before any run (a retry of an attempt the
 * idempotency store knows keeps the first verdict), nor for a refusal before the run (a stale version, a throttle, a
 * pre-check).
 *
 * <p>The value is JSON data: maps with string keys, lists, strings, finite numbers, booleans and null, whatever Jackson
 * writes them as. It is held to the bounds the sandbox ABI gives {@code hostContext} (64 levels deep, at most
 * 1,000,000 values, finite numbers, strict JSON strings; {@code HostContexts} in the service package checks them). A provider that throws, answers null, or answers a value outside those bounds is the host's own fault, never
 * a verdict on the answers: the request is refused with 503 {@code server.unavailable}, no run happens, and the cause is logged at
 * ERROR (never the values), as for a data source that cannot answer (a {@code DatumException} it throws answers as itself). A provider that could not decide is
 * never read as "no context", which would judge more leniently than the application meant.
 */
@FunctionalInterface
public interface HostContextProvider {

    /**
     * The host context of one run.
     *
     * @param request the form and the request facts the run is for
     * @return the values {@code host.} reads, or empty for no context
     */
    Optional<? extends Map<String, ?>> hostContext(HostContextRequest request);

    /** No context for any run: the lenient reading above. */
    HostContextProvider NONE = request -> Optional.empty();
}
