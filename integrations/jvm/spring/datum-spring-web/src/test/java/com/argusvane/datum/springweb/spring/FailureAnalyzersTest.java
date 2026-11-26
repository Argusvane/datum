package com.argusvane.datum.springweb.spring;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.DatumConfigurationException;
import com.argusvane.datum.springweb.autoconfigure.DatumWebAutoConfiguration;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.BeanCreationException;
import org.springframework.beans.factory.BeanFactory;
import org.springframework.beans.factory.support.DefaultListableBeanFactory;
import org.springframework.core.env.Environment;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.diagnostics.FailureAnalysis;
import org.springframework.boot.diagnostics.FailureAnalyzer;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.core.io.support.SpringFactoriesLoader;

/**
 * A start refusal prints as a Description and an Action. The analyzer is registered in spring.factories (the
 * way Boot finds it), and a real refusal inside a context failure, wrapped as Boot wraps it, reads as the setting and the fix. The
 * engine-selection refusal is datum-sandbox-spring's, with its own test.
 */
class FailureAnalyzersTest {

    private static List<FailureAnalyzer> registered() {
        // Boot's own analyzers take the bean factory and the environment, so the loader is given them as Boot gives them.
        SpringFactoriesLoader.ArgumentResolver arguments = SpringFactoriesLoader.ArgumentResolver.of(BeanFactory.class, new DefaultListableBeanFactory())
            .and(Environment.class, new StandardEnvironment());
        return SpringFactoriesLoader.forDefaultResourceLocation(FailureAnalyzersTest.class.getClassLoader()).load(FailureAnalyzer.class, arguments);
    }

    private static FailureAnalysis analyse(Throwable failure) {
        for (FailureAnalyzer analyzer : registered()) {
            FailureAnalysis analysis = analyzer.analyze(failure);
            if (analysis != null) {
                return analysis;
            }
        }
        return null;
    }

    @Test
    void theConfigurationAnalyzerIsRegisteredTheWayBootFindsIt() {
        assertThat(registered()).extracting(analyzer -> analyzer.getClass().getSimpleName())
            .contains("DatumConfigurationFailureAnalyzer").doesNotContain("EngineSelectionFailureAnalyzer");
    }

    @Test
    void aConfigurationRefusalInsideABeanFailureIsDescribedAndAnActionGiven() {
        Throwable failure = new BeanCreationException("datumSettings", "Failed",
            new DatumConfigurationException("datum.web.api.max-body-size", "datum.web.api.max-body-size is 0B; it must be at least 1B.",
                "Set datum.web.api.max-body-size to 1B or more."));
        FailureAnalysis analysis = analyse(failure);
        assertThat(analysis).isNotNull();
        assertThat(analysis.getDescription()).isEqualTo("datum.web.api.max-body-size is 0B; it must be at least 1B.");
        assertThat(analysis.getAction()).isEqualTo("Set datum.web.api.max-body-size to 1B or more.");
    }

    @Test
    void aRefusalWithoutAnActionGetsTheGeneralAdviceNamingTheSetting() {
        FailureAnalysis analysis = analyse(new IllegalStateException("outer",
            new DatumConfigurationException("datum.tsa.flood.window", "datum.tsa.flood.window must be at least 1s, not PT0S.")));
        assertThat(analysis.getAction()).contains("datum.tsa.flood.window");
    }

    @Test
    void aRealRefusalFromTheSettingsBeanReachesTheAnalyzer() {
        new ApplicationContextRunner().withConfiguration(AutoConfigurations.of(DatumWebAutoConfiguration.class))
            .withPropertyValues("datum.web.api.busy-retry-after=500ms").run(context -> {
                assertThat(context).hasFailed();
                FailureAnalysis analysis = analyse(context.getStartupFailure());
                assertThat(analysis).as("Boot would print this instead of the stack trace").isNotNull();
                assertThat(analysis.getDescription()).contains("datum.web.api.busy-retry-after");
                assertThat(analysis.getAction()).contains("datum.web.api.busy-retry-after");
            });
    }
}
