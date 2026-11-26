package com.argusvane.datum.examples.submissions;

import com.argusvane.datum.sandbox.protocol.RuleModule;
import com.argusvane.datum.submissions.spi.SandboxRulesProvider;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * A TEST-ONLY switch so that an external run of {@code datum-host-check --capabilities hardening} can prove the
 * hardening cases (HRD-01..04) against the booted jar, as {@code SubmissionsHardeningIT} proves them in process.
 * Off unless {@code datum.example.hardening-rules=<file>} names the kit's hostile
 * rule module ({@code datum-host-check fixtures --out <dir>} writes {@code hardening-rules.js}); then the module is
 * registered for the fixture form {@code datum-security-suite} through a {@link SandboxRulesProvider}, exactly as an
 * application registers its own rule modules. The module loops, takes memory without bound, builds a 40 MiB answer and
 * writes a forged outcome on purpose: never switch this on in a deployment that takes real submissions. Pair it with
 * {@code --datum.runtime.validation.memory=512MB} so the 40 MiB answer is stopped by the run's output cap rather
 * than by the module failing to build it (the kit's HRD-03 accepts either, but the caps are what it means to prove).
 */
@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty("datum.example.hardening-rules")
class HardeningRulesConfiguration {

    /** The fixture form's key; the same string the kit and the example's definition file use. */
    private static final String FIXTURE_FORM = "datum-security-suite";

    @Bean
    SandboxRulesProvider hardeningRules(@Value("${datum.example.hardening-rules}") String file) {
        String source;
        try {
            source = Files.readString(Path.of(file), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException("datum.example.hardening-rules does not name a readable file: " + file, e);
        }
        RuleModule module = new RuleModule("datum-tck-hardening", "1", source);
        return (formKey, definition, submission) -> FIXTURE_FORM.equals(formKey) ? List.of(module) : List.of();
    }
}
