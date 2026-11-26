package com.argusvane.datum.core.observation;

/**
 * The observations Datum reports and their keys, as plain strings so a library
 * names them without loading Micrometer; {@link DatumObservationDocumentation} is the same list as Micrometer's
 * {@code ObservationDocumentation}.
 *
 * <p>Every name is under {@code datum.} and distinct from the meters Datum already registers ({@code datum.runs},
 * {@code datum.runs.wait}, {@code datum.runs.active}, {@code datum.runs.slots}, {@code datum.runs.rejected},
 * {@code datum.submissions}, {@code datum.throttled}): Micrometer's meter handler makes a timer {@code <name>} and a long
 * task timer {@code <name>.active} of each observation, and an observation called {@code datum.runs} would have made a
 * {@code datum.runs.active} that collides with the gauge. Spring Boot's {@code management.observations.enable.<prefix>=false}
 * switches a family off ({@code datum.sandbox}, {@code datum.pdf}, {@code datum.submission}, {@code datum.tsa}, or
 * {@code datum} for all).
 */
public final class DatumObservationNames {

    private DatumObservationNames() {
    }

    /**
     * One call of the sandbox program's operations, the slot wait of a validation included (the runs the {@code datum.runs}
     * timer measures from inside the runtime, measured here from the caller): low {@link #OP}, {@link #OUTCOME},
     * {@link #ENGINE_MODE}.
     */
    public static final String SANDBOX_RUN = "datum.sandbox.run";

    /** One call of the PDF program (its capabilities or a request): low {@link #OP}, {@link #OUTCOME}, {@link #ENGINE_MODE}. */
    public static final String PDF_RUN = "datum.pdf.run";

    /**
     * One operation of the PDF service, from its request to its result (slot waits, every program run, the seal and its
     * timestamp inside it): low {@link #OP}, {@link #OUTCOME}, {@link #SEAL}, {@link #TIMESTAMP}; high {@link #FORM}.
     */
    public static final String PDF = "datum.pdf";

    /**
     * One document through the submission service, whichever channel brought it: low {@link #MODE}, {@link #CHANNEL},
     * {@link #OUTCOME}, {@link #STAGE}; high {@link #FORM} (only once the form was found, so a key no form has is never a tag).
     */
    public static final String SUBMISSION = "datum.submission";

    /** One token asked of the in-process timestamp authority: low {@link #CHANNEL}, {@link #OUTCOME} ({@code granted} or the failure's name). */
    public static final String TSA_ISSUE = "datum.tsa.issue";

    /** Which operation: a sandbox op ({@code validate}, {@code inspect}, {@code check}, {@code public}, {@code smoke}, {@code abi}), a PDF op. */
    public static final String OP = "op";

    /** How it ended: {@code ok} (or a domain word such as {@code accepted}, {@code granted}), else {@link DatumObservations#outcomeOf}. */
    public static final String OUTCOME = "outcome";

    /** The engine's mode ({@code panama}, {@code jffi}, {@code bytecode}, ...), as the runtime reports it. */
    public static final String ENGINE_MODE = "engine.mode";

    /** A submission's mode: {@code submit}, {@code validate}, {@code test}, {@code pdf}. */
    public static final String MODE = "mode";

    /** The channel a submission or a token came through ({@code http}, {@code jdbc}, {@code bus}, {@code sealing}, ...). */
    public static final String CHANNEL = "channel";

    /** Where a submission was refused ({@code journey}, {@code sandbox}, {@code signature}, {@code server}), else {@code none}. */
    public static final String STAGE = "stage";

    /** How a PDF was sealed: {@code server}, {@code test} or {@code none}. */
    public static final String SEAL = "seal";

    /** Where a sealed PDF's timestamp came from ({@code site}, {@code custom}, {@code server}), or {@code none}. */
    public static final String TIMESTAMP = "timestamp";

    /** The form's key: high-cardinality only, never a meter tag. */
    public static final String FORM = "form";

    /** The value of a key that does not apply or is not known. */
    public static final String NONE = "none";
}
