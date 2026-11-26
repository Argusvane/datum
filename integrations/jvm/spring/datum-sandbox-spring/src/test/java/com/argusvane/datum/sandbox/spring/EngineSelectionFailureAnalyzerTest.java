package com.argusvane.datum.sandbox.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.argusvane.datum.sandbox.wasi.EngineSelectionException;
import com.argusvane.datum.sandbox.wasi.GuestRuntimes;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.net.URLClassLoader;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.Properties;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.BeanCreationException;
import org.springframework.boot.diagnostics.FailureAnalysis;
import org.springframework.boot.diagnostics.FailureAnalyzer;

/**
 * An engine refusal prints as a Description and an Action: the analyzer is registered in this module's spring.factories (the way
 * Boot finds it), and a refusal inside a bean failure, wrapped as Boot wraps it, reads as the id asked for and the ways out.
 */
class EngineSelectionFailureAnalyzerTest {

    /** What the spring.factories files of the class path name as failure analyzers (the way Boot finds them), read without instantiating Boot's own. */
    private static List<String> registered() throws IOException {
        List<String> names = new ArrayList<>();
        Enumeration<URL> files = EngineSelectionFailureAnalyzerTest.class.getClassLoader().getResources("META-INF/spring.factories");
        while (files.hasMoreElements()) {
            Properties factories = new Properties();
            try (InputStream in = files.nextElement().openStream()) {
                factories.load(in);
            }
            String listed = factories.getProperty(FailureAnalyzer.class.getName());
            if (listed != null) {
                for (String name : listed.split(",")) {
                    names.add(name.trim());
                }
            }
        }
        return names;
    }

    private static FailureAnalysis analyse(Throwable failure) {
        return new EngineSelectionFailureAnalyzer().analyze(failure);
    }

    @Test
    void theAnalyzerIsRegisteredTheWayBootFindsIt() throws IOException {
        assertThat(registered()).contains("com.argusvane.datum.sandbox.spring.EngineSelectionFailureAnalyzer");
    }

    @Test
    void anEngineThatIsNotThereIsDescribedWithTheIdAskedForAndTheWaysOut() {
        // A class loader with no providers, as a class path without the engine jar: the id asked for stays in the Description.
        URLClassLoader empty = new URLClassLoader(new URL[0], null);
        EngineSelectionException refusal = assertThrows(EngineSelectionException.class, () -> GuestRuntimes.select("endvie", empty));
        FailureAnalysis analysis = analyse(new BeanCreationException("datumGuestRuntime", "Failed", refusal));
        assertThat(analysis).isNotNull();
        assertThat(analysis.getDescription()).contains("\"endvie\"").contains(refusal.getMessage());
        assertThat(analysis.getAction()).contains("datum.runtime.engine").contains("GuestRuntime bean");
    }

    @Test
    void anEngineIdThatIsNotSetIsDescribedAsNotSet() {
        URLClassLoader empty = new URLClassLoader(new URL[0], null);
        EngineSelectionException refusal = assertThrows(EngineSelectionException.class, () -> GuestRuntimes.select("", empty));
        assertThat(analyse(refusal).getDescription()).startsWith("datum.runtime.engine is not set");
    }
}
