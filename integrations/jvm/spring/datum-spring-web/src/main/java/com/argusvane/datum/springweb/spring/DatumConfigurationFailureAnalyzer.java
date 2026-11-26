package com.argusvane.datum.springweb.spring;

import com.argusvane.datum.core.DatumConfigurationException;
import org.springframework.boot.diagnostics.AbstractFailureAnalyzer;
import org.springframework.boot.diagnostics.FailureAnalysis;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;

/**
 * A setting Datum refused at start, as one Description and one Action instead of a nested {@code BeanCreationException}
 * stack trace. The refusal ({@link DatumConfigurationException}) names the
 * setting, what is wrong and what to do, and never a secret, so this prints them as they are. Registered in
 * {@code META-INF/spring.factories}; a Boot application prints it for any Datum module's refusal, because the exception is
 * the core library's.
 */
@Order(Ordered.HIGHEST_PRECEDENCE + 100)
public final class DatumConfigurationFailureAnalyzer extends AbstractFailureAnalyzer<DatumConfigurationException> {

    @Override
    protected FailureAnalysis analyze(Throwable rootFailure, DatumConfigurationException cause) {
        return new FailureAnalysis(cause.problem(), cause.action(), cause);
    }
}
