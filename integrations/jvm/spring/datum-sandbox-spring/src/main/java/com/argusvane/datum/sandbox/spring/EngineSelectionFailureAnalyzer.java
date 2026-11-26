package com.argusvane.datum.sandbox.spring;

import com.argusvane.datum.sandbox.wasi.EngineSelectionException;
import org.springframework.boot.diagnostics.AbstractFailureAnalyzer;
import org.springframework.boot.diagnostics.FailureAnalysis;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;

/**
 * An engine id no provider has, an engine that is unavailable here, or two that claim one id: the Description names the id asked for and every engine found, the Action the three ways out.
 * The exception carries both, so a typo reads as the one thing it is rather than a stack trace.
 */
@Order(Ordered.HIGHEST_PRECEDENCE + 100)
public final class EngineSelectionFailureAnalyzer extends AbstractFailureAnalyzer<EngineSelectionException> {

    @Override
    protected FailureAnalysis analyze(Throwable rootFailure, EngineSelectionException cause) {
        String asked = cause.requested() == null || cause.requested().isBlank() ? "is not set" : "is \"" + cause.requested() + "\"";
        String description = "datum.runtime.engine " + asked + ", and no engine can be used for it: " + cause.getMessage();
        String action = "Set datum.runtime.engine to the id of one of the engines found, add the jar of the engine you want "
            + "(datum-sandbox-endive is the default, and the submissions starter brings it), or define a GuestRuntime bean of your own.";
        return new FailureAnalysis(description, action, cause);
    }
}
