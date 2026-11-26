package com.argusvane.datum.examples.builderjpa;

import com.argusvane.datum.core.contracts.DatumJson;
import com.argusvane.datum.forms.FormDefinitionRepository;
import com.argusvane.datum.forms.snapshot.DefinitionSnapshotStore;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.time.Clock;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.core.io.ClassPathResource;
import tools.jackson.databind.node.ObjectNode;

/**
 * Story three: forms are authored here. {@code datum-spring-boot-starter-ui} with {@code datum.builder.enabled=true}
 * serves the builder and its write endpoints; this application supplies what the packages leave to it:
 *
 * <ul>
 *   <li>where forms live: {@link JpaFormDefinitionRepository} and {@link JpaDefinitionSnapshotStore} over JPA (H2 here);
 *   <li>who may build: Spring Security ({@link SecurityConfiguration}): {@code ROLE_FORM_ADMIN} on Datum's builder
 *       routes through {@code DatumRequestMatchers}, the JSON 401/403 handlers, the cookie CSRF recipe;
 *   <li>what happens after a save: {@link FormSavedAudit}, a {@code FormDefinitionSavedEvent} listener;
 *   <li>the pages: {@code static/builder/index.html} (the builder, signed in) and {@code static/index.html} (the form).
 * </ul>
 *
 * <p>Every save is checked by the sandbox kernel before it reaches the repository: a refused definition (a risky
 * pattern, a duplicate id, a stale If-Match) never lands in the database.
 */
@SpringBootApplication
public class BuilderJpaApplication {

    public static void main(String[] args) {
        SpringApplication.run(BuilderJpaApplication.class, args);
    }

    @Bean
    Clock clock() {
        return Clock.systemUTC();
    }

    @Bean
    FormDefinitionRepository formDefinitionRepository(FormEntities forms, Clock clock,
                                                     org.springframework.transaction.support.TransactionOperations transactions) {
        return new JpaFormDefinitionRepository(forms, clock, transactions);
    }

    @Bean
    DefinitionSnapshotStore definitionSnapshotStore(SnapshotEntities snapshots, Clock clock) {
        return new JpaDefinitionSnapshotStore(snapshots, clock);
    }

    @Bean
    FormSavedAudit formSavedAudit(FormAuditEntries audit, Clock clock) {
        return new FormSavedAudit(audit, clock);
    }

    /**
     * A first form to build on, stored straight into the repository when the database has none. (Seeding bypasses the
     * builder's check on purpose: it is the application's own file. A form created in the browser goes through
     * {@code POST /api/forms} and is checked like every save.)
     */
    @Bean
    ApplicationRunner seedIntake(FormEntities forms, FormDefinitionRepository repository) {
        return args -> {
            if (forms.count() == 0) {
                try (InputStream in = new ClassPathResource("seed/intake.json").getInputStream()) {
                    repository.save((ObjectNode) DatumJson.mapper().readTree(in));
                } catch (IOException e) {
                    throw new UncheckedIOException(e);
                }
            }
        };
    }
}
