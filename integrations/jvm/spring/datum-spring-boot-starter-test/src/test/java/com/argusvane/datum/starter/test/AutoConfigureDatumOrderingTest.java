package com.argusvane.datum.starter.test;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.sandbox.wasi.GuestRuntime;
import com.argusvane.datum.forms.FormDefinitionRepository;
import com.argusvane.datum.forms.spring.DatumFormsAutoConfiguration;
import com.argusvane.datum.sandbox.spring.DatumSandboxAutoConfiguration;
import com.argusvane.datum.submissions.spring.DatumSubmissionsAutoConfiguration;
import com.argusvane.datum.springweb.autoconfigure.DatumWebAutoConfiguration;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.condition.ConditionEvaluationReport;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

/**
 * {@link AutoConfigureDatum} is built as Boot's test annotations are: its pieces are
 * auto-configurations, so they back off for the application's own beans whatever order configurations load in, they come
 * before the Datum bindings whose defaults they displace, and the condition report names them.
 */
class AutoConfigureDatumOrderingTest {

    private ApplicationContextRunner runner() {
        // Deliberately listed after the bindings: the sorter, not the list, decides the order.
        return new ApplicationContextRunner().withConfiguration(AutoConfigurations.of(DatumWebAutoConfiguration.class, DatumFormsAutoConfiguration.class,
            DatumSandboxAutoConfiguration.class, DatumSubmissionsAutoConfiguration.class, DatumTestFormsAutoConfiguration.class, DatumTestAutoConfiguration.class));
    }

    @Test
    void theFakeDisplacesTheEndiveRuntimeWhateverTheListOrder() {
        runner().run(context -> {
            assertThat(context).hasNotFailed().hasSingleBean(GuestRuntime.class);
            assertThat(context.getBean(GuestRuntime.class)).isInstanceOf(FakeGuestRuntime.class);
        });
    }

    @Test
    void anApplicationsOwnRuntimeBeanWinsOverTheFake() {
        FakeGuestRuntime mine = new FakeGuestRuntime();
        runner().withBean("applicationRuntime", GuestRuntime.class, () -> mine).run(context -> {
            assertThat(context).hasNotFailed().hasSingleBean(GuestRuntime.class);
            assertThat(context.getBean(GuestRuntime.class)).isSameAs(mine);
            assertThat(context).doesNotHaveBean(FakeGuestRuntime.class.getName());
        });
    }

    @Test
    void theFixtureFormsAreOffUnlessThePropertyIsSet() {
        runner().run(context -> assertThat(context.getBean(FormDefinitionRepository.class)).isNotInstanceOf(DatumTestForms.Repository.class));
        runner().withPropertyValues("datum.test.forms=true").run(context ->
            assertThat(context.getBean(FormDefinitionRepository.class)).isInstanceOf(DatumTestForms.Repository.class));
    }

    @Test
    void theConditionReportNamesTheTestAutoConfigurations() {
        runner().withPropertyValues("datum.test.forms=true").run(context -> {
            ConditionEvaluationReport report = ConditionEvaluationReport.get(context.getSourceApplicationContext().getBeanFactory());
            // A bean method's conditions are reported under "<class>#<method>", the class's own under the class.
            assertThat(report.getConditionAndOutcomesBySource().keySet())
                .anyMatch(source -> source.startsWith(DatumTestAutoConfiguration.class.getName() + "#datumFakeGuestRuntime"))
                .anyMatch(source -> source.startsWith(DatumTestFormsAutoConfiguration.class.getName()));
        });
    }

    @Test
    void theAnnotationIsAnImportOfTheNamedImportsFile() throws Exception {
        assertThat(AutoConfigureDatum.class.isAnnotationPresent(org.springframework.boot.autoconfigure.ImportAutoConfiguration.class)).isTrue();
        try (var in = AutoConfigureDatum.class.getClassLoader().getResourceAsStream("META-INF/spring/" + AutoConfigureDatum.class.getName() + ".imports")) {
            assertThat(in).isNotNull();
            assertThat(new String(in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8))
                .contains(DatumTestAutoConfiguration.class.getName()).contains(DatumTestFormsAutoConfiguration.class.getName());
        }
    }
}
