package com.argusvane.datum.pdf;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.sandbox.protocol.HostOptions;
import com.argusvane.datum.sandbox.protocol.PdfKernel;
import com.argusvane.datum.sandbox.protocol.PdfKernelDecorator;
import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.sandbox.protocol.RunLog;
import com.argusvane.datum.pdf.spring.DatumPdfAutoConfiguration;
import com.argusvane.datum.sandbox.runtime.DatumSandbox;
import com.argusvane.datum.sandbox.runtime.ProgramStore;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

/**
 * The {@code PdfRuntime} bean is replaceable, and the host's kernel decorators
 * are applied to whichever bean exists. An application's own {@code PdfRuntime} (here a scripted one) has its program wrapped
 * by the runtime's PDF chain, so a decorator sees every run a replacement makes; without a Datum runtime in the context there is
 * nothing to wrap with and the bean is used as given.
 */
class ReplacementPdfRuntimeTest {

    private static PdfKernel counting(PdfKernel delegate, Map<String, AtomicInteger> counts) {
        return (PdfKernel) Proxy.newProxyInstance(PdfKernel.class.getClassLoader(), new Class<?>[] {PdfKernel.class}, (proxy, method, args) -> {
            counts.computeIfAbsent(method.getName(), name -> new AtomicInteger()).incrementAndGet();
            try {
                return method.invoke(delegate, args);
            } catch (InvocationTargetException e) {
                throw e.getCause();
            }
        });
    }

    private static DatumSandbox runtimeWith(PdfKernelDecorator decorator) {
        return DatumSandbox.builder()
            .runtime(new ScriptedPdfRuntime())
            .store(new ProgramStore(ProgramStore.class.getClassLoader(), null, null))
            .limits(ProgramLimits.defaults())
            .hostOptions(HostOptions.defaults())
            .settings(com.argusvane.datum.sandbox.runtime.SandboxSettings.builder().engine("test").failFast(true).warmUpRuns(0).shutdownGrace(Duration.ofSeconds(1)).pdfConcurrency(1).pdfWait(Duration.ZERO).build())
            .events(event -> { })
            .runLog(RunLog.slf4j())
            .pdfKernelDecorators(List.of(decorator))
            .build();
    }

    @Test
    void aReplacementPdfRuntimeHasItsProgramWrappedByTheKernelDecorators() {
        Map<String, AtomicInteger> counts = new ConcurrentHashMap<>();
        DatumSandbox datum = runtimeWith(kernel -> counting(kernel, counts));
        new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(DatumPdfAutoConfiguration.class))
            .withBean(DatumSandbox.class, () -> datum)
            .withBean("applicationPdfRuntime", PdfRuntime.class, () -> new ScriptedPdfRuntime().pdfRuntime())
            .withBean(ProgramLimits.class, ProgramLimits::defaults)
            .withUserConfiguration(MonitoringRegistries.class)
            .run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(context.getBeansOfType(PdfRuntime.class)).containsOnlyKeys("applicationPdfRuntime");
                PdfRuntime replacement = context.getBean(PdfRuntime.class);
                assertThat(replacement.program().capabilities()).contains("fill");
                assertThat(counts.get("capabilities")).as("the decorator saw the replacement's run").isNotNull().hasValueGreaterThanOrEqualTo(1);
                assertThat(replacement.program()).as("wrapped once per kernel").isSameAs(replacement.program());
            });
    }

    @Test
    void withoutADatumSandboxAReplacementIsUsedAsGiven() {
        PdfRuntime mine = new ScriptedPdfRuntime().pdfRuntime();
        new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(DatumPdfAutoConfiguration.class))
            .withBean("applicationPdfRuntime", PdfRuntime.class, () -> mine)
            .withBean(ProgramLimits.class, ProgramLimits::defaults)
            .withUserConfiguration(MonitoringRegistries.class)
            .run(context -> assertThat(context.getBean(PdfRuntime.class)).isSameAs(mine));
    }
}
