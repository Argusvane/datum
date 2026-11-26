package com.argusvane.datum.submissions;

import com.argusvane.datum.sandbox.runtime.TestRuntime;
import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.forms.spring.DatumFormsAutoConfiguration;
import com.argusvane.datum.springweb.autoconfigure.DatumWebAutoConfiguration;
import com.argusvane.datum.submissions.events.SubmissionRedeliveredEvent;
import com.argusvane.datum.submissions.events.SubmissionValidatedEvent;
import com.argusvane.datum.submissions.receiver.SubmissionReceiver;
import com.argusvane.datum.submissions.service.FormRef;
import com.argusvane.datum.submissions.service.SubmissionOutcome;
import com.argusvane.datum.submissions.service.SubmissionService;
import com.argusvane.datum.submissions.spi.IncomingSubmission;
import com.argusvane.datum.submissions.spi.PreCheckDecision;
import com.argusvane.datum.submissions.spi.SubmissionContext;
import com.argusvane.datum.submissions.spi.SubmissionPreCheck;
import com.argusvane.datum.submissions.spi.SubmissionRequest;
import com.argusvane.datum.sandbox.spring.DatumSandboxAutoConfiguration;
import com.argusvane.datum.submissions.spring.DatumSubmissionsAutoConfiguration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.event.EventListener;

/**
 * The binding's {@link SubmissionService} bean: it exists without any web stack, the HTTP receiver hands every
 * request to it, an application's own bean replaces it under the receiver too, and a caller with no HTTP request gets the
 * same hooks (an ordered pre-check bean), the same idempotency store and Spring events carrying its channel.
 */
class SubmissionServiceBeanTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(DatumWebAutoConfiguration.class, DatumFormsAutoConfiguration.class,
            DatumSandboxAutoConfiguration.class, DatumSubmissionsAutoConfiguration.class))
        .withPropertyValues("datum.forms.locations=classpath:/datum-test-forms/*.json", "datum.runtime.warm-up-runs=1");

    @Configuration(proxyBeanMethods = false)
    static class Application {

        final List<Object> events = Collections.synchronizedList(new ArrayList<>());
        final List<String> preChecked = Collections.synchronizedList(new ArrayList<>());

        @Bean
        TestRuntime testRuntime() {
            return new TestRuntime();
        }

        @Bean
        SubmissionPreCheck channelRecordingPreCheck() {
            return (IncomingSubmission incoming) -> {
                preChecked.add(incoming.channel());
                return PreCheckDecision.ALLOW;
            };
        }

        @EventListener
        void on(SubmissionValidatedEvent event) {
            events.add(event);
        }

        @EventListener
        void on(SubmissionRedeliveredEvent event) {
            events.add(event);
        }
    }

    @Test
    void theReceiverAndAQueueShareOneServiceItsHooksItsStoreAndItsEvents() {
        runner.withUserConfiguration(Application.class).run(context -> {
            assertThat(context).hasNotFailed();
            SubmissionService service = context.getBean(SubmissionService.class);
            assertThat(context.getBean(SubmissionReceiver.class).service()).isSameAs(service);

            var document = Fixtures.envelope("contact", "1", "{\"name\":\"Ada\"}");
            SubmissionOutcome first = service.submit(FormRef.fromDocument(), document, SubmissionContext.of(SubmissionContext.BUS).withSubmissionKey("attempt-1"));
            assertThat(first).isInstanceOf(SubmissionOutcome.Accepted.class);

            var again = context.getBean(SubmissionReceiver.class).submit(SubmissionRequest.json(), Fixtures.delivered(document, "attempt-1"));
            assertThat(again.body().path("handled").booleanValue()).isTrue();
            assertThat(again.body().path("id").stringValue()).isEqualTo(((SubmissionOutcome.Accepted) first).receipt().id());

            Application application = context.getBean(Application.class);
            assertThat(application.preChecked).containsExactly("bus", "http");
            assertThat(application.events).hasSize(2);
            assertThat(application.events.get(0)).isInstanceOfSatisfying(SubmissionValidatedEvent.class,
                event -> assertThat(event.channel()).isEqualTo("bus"));
            assertThat(application.events.get(1)).isInstanceOfSatisfying(SubmissionRedeliveredEvent.class,
                event -> assertThat(event.channel()).isEqualTo("http"));
        });
    }

    /** One size cap for every channel: the routes' body cap, {@code datum.web.api.max-body-size}. */
    @Test
    void theServiceHoldsEveryCallerToTheRoutesBodyCap() {
        runner.withUserConfiguration(Application.class).withPropertyValues("datum.web.api.max-body-size=64KB").run(context -> {
            assertThat(context).hasNotFailed();
            SubmissionService service = context.getBean(SubmissionService.class);
            assertThat(service.maxDocumentBytes()).isEqualTo(64 * 1024)
                .isEqualTo(context.getBean(com.argusvane.datum.sandbox.protocol.ProgramLimits.class).maxBodyBytes());

            var document = Fixtures.envelope("contact", "1", "{\"name\":\"Ada\"}");
            ((tools.jackson.databind.node.ObjectNode) document.path("submission").path("values")).put("note", "x".repeat(65 * 1024));
            assertThat(service.submit(FormRef.fromDocument(), document, SubmissionContext.of(SubmissionContext.SYNC).withSubmissionKey("attempt-2")))
                .isEqualTo(new SubmissionOutcome.TooLarge(64 * 1024));
            assertThat(context.getBean(Application.class).preChecked).isEmpty();
        });
    }

    @Test
    void anApplicationsServiceIsTheOneTheReceiverUses() {
        runner.withUserConfiguration(Application.class, OwnService.class).run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBeansOfType(SubmissionService.class)).containsOnlyKeys("ownSubmissionService");
            assertThat(context.getBean(SubmissionReceiver.class).service()).isSameAs(context.getBean("ownSubmissionService"));
        });
    }

    /** An application's own service bean: the binding's backs off and the receiver is built over this one. */
    @Configuration(proxyBeanMethods = false)
    static class OwnService {

        @Bean
        SubmissionService ownSubmissionService(com.argusvane.datum.sandbox.runtime.DatumSandbox runtime,
                                               com.argusvane.datum.forms.DefinitionService definitions,
                                               com.argusvane.datum.forms.datasource.DataSourceOptions dataSources) {
            return SubmissionService.builder()
                .sandbox(runtime::sandbox)
                .definitions(definitions)
                .dataSources(dataSources)
                .handler(submission -> new com.argusvane.datum.submissions.spi.SubmissionReceipt("own", null, null))
                .events(event -> { })
                .build();
        }
    }
}
