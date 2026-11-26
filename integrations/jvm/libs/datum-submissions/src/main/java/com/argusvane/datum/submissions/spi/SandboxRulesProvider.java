package com.argusvane.datum.submissions.spi;

import com.argusvane.datum.sandbox.protocol.RuleModule;
import java.util.List;
import tools.jackson.databind.node.ObjectNode;

/**
 * The rule modules a form's runs register: host-trusted JavaScript from the application's own configuration, never
 * from a request (rule modules are host-trusted code).
 *
 * <p>There is none by default; every bean is asked, in the framework's order (declare {@code @Order} where the relative order matters; equal orders keep registration order), and the modules register in that order.
 * A provider that cannot read a module it owes throws: the request is refused with 503
 * {@code server.unavailable} rather than judged without the rules the form counts on (fail closed).
 */
@FunctionalInterface
public interface SandboxRulesProvider {

    /**
     * @param formKey the form
     * @param definition the server's definition (a copy)
     * @param submission who sent the document and through what: the same {@link SubmissionContext} every other
     *     hook of the run reads, whatever the channel
     * @return the modules, in registration order; never null
     */
    List<RuleModule> rules(String formKey, ObjectNode definition, SubmissionContext submission);
}
