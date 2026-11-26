package com.argusvane.datum.submissions.spi;

import com.argusvane.datum.sandbox.protocol.RuleModule;
import java.util.List;
import java.util.Objects;
import tools.jackson.databind.node.ObjectNode;

/**
 * The sandbox run being prepared, as a {@link SandboxContextContributor} may change it: the context, the rule modules
 * and the form.
 *
 * <p>A contributor may add {@code externalData}, change the context's keys or add rule modules. Four things
 * are set after every contributor and so are out of its reach: the {@code hostContext}, which is the
 * {@link HostContextProvider}'s alone (left out when it supplies none, whatever a contributor wrote), the delivered
 * {@code document} (the canonical text and digest are always of the document as received, CAN-03), the
 * host's {@code today}, {@code formulaErrors} and {@code riskyPatterns} ({@code SandboxService} sets them over
 * the context), and a check's {@code reportFold}. {@code values} is a copy: changing it changes the run's input,
 * never the document.
 */
public final class ContextBuilder {

    private final String formKey;
    private final SubmissionMode mode;
    private final ObjectNode definition;
    private final ObjectNode context;
    private final List<RuleModule> rules;

    public ContextBuilder(String formKey, SubmissionMode mode, ObjectNode definition, ObjectNode context, List<RuleModule> rules) {
        this.formKey = Objects.requireNonNull(formKey, "formKey");
        this.mode = Objects.requireNonNull(mode, "mode");
        this.definition = Objects.requireNonNull(definition, "definition");
        this.context = Objects.requireNonNull(context, "context");
        this.rules = Objects.requireNonNull(rules, "rules");
    }

    /** The form. */
    public String formKey() {
        return formKey;
    }

    /** Which route. */
    public SubmissionMode mode() {
        return mode;
    }

    /** The server's definition (a copy; changing it changes nothing). */
    public ObjectNode definition() {
        return definition;
    }

    /** The WasmSubmissionContext, mutable. */
    public ObjectNode context() {
        return context;
    }

    /** The rule modules, mutable, in registration order. */
    public List<RuleModule> rules() {
        return rules;
    }
}
