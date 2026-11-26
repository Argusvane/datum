package com.argusvane.datum.sandbox.protocol;

import java.util.List;
import tools.jackson.databind.node.ObjectNode;

/**
 * The PDF program's calls as its callers see them (the PDF kernel): what {@code PdfService}
 * renders, fills, signs and verifies through, and what the runtime warms up and proves.
 *
 * <p>{@link PdfProgram} is the one implementation that runs the protocol (the ABI gate, the budget, the strict answer,
 * the remembered failure), and it stays final. This interface is what a host wraps instead, as it wraps
 * {@link Sandbox}, so one decorator (tracing, metrics, an audit) covers every guest run of both programs: a
 * {@link PdfKernelDecorator} wraps every PDF run, a {@link SandboxDecorator} every sandbox run. A decorator
 * delegates each call to the kernel it was given and never answers in its place: a decorator that answered for the
 * program (a cached PDF, a skipped capability check) would take the program out of the decision, and nothing here can
 * stop that, so the contract is stated instead: delegate, observe, rethrow.
 */
public interface PdfKernel {

    /** The program this runs. */
    Program program();

    /** The program's feature names, which also prove its ABI ({@link PdfProgram#capabilities()}). */
    List<String> capabilities();

    /** Runs one request after the ABI gate ({@link PdfProgram#call(ObjectNode)}). */
    ObjectNode call(ObjectNode request);
}
