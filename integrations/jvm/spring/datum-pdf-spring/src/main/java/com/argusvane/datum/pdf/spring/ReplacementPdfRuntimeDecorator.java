package com.argusvane.datum.pdf.spring;

import com.argusvane.datum.pdf.PdfRuntime;
import com.argusvane.datum.sandbox.runtime.DatumSandbox;
import java.lang.reflect.Method;
import java.util.Objects;
import org.springframework.beans.BeansException;
import org.springframework.beans.factory.BeanFactory;
import org.springframework.beans.factory.BeanFactoryAware;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.beans.factory.config.ConfigurableListableBeanFactory;
import org.springframework.beans.factory.support.RootBeanDefinition;

/**
 * The PDF kernel decorator chain on a {@link PdfRuntime} bean the application replaced the default with, as {@code ReplacementSandboxDecorator} does for the sandbox: the default
 * {@code datumPdfRuntime} bean reads the runtime's kernels, which the runtime wrapped when it built them, so it is left alone;
 * any other {@code PdfRuntime} bean answers its program through {@link DatumSandbox#decorate(com.argusvane.datum.sandbox.protocol.PdfKernel)},
 * which applies Datum's {@code datum.pdf.run} observation and the host's {@code PdfKernelDecorator} beans in their order. A
 * replacement can then never take a PDF run out of the decorators' sight.
 */
final class ReplacementPdfRuntimeDecorator implements BeanPostProcessor, BeanFactoryAware {

    private final ObjectProvider<DatumSandbox> runtime;
    private ConfigurableListableBeanFactory beans;

    ReplacementPdfRuntimeDecorator(ObjectProvider<DatumSandbox> runtime) {
        this.runtime = Objects.requireNonNull(runtime, "runtime");
    }

    @Override
    public void setBeanFactory(BeanFactory beanFactory) throws BeansException {
        if (beanFactory instanceof ConfigurableListableBeanFactory configurable) {
            this.beans = configurable;
        }
    }

    @Override
    public Object postProcessAfterInitialization(Object bean, String beanName) throws BeansException {
        if (!(bean instanceof PdfRuntime pdfRuntime) || isBindingDefault(beanName)) {
            return bean;
        }
        DatumSandbox datum = runtime.getIfAvailable();
        return datum == null ? bean : PdfRuntime.decorating(pdfRuntime, datum::decorate);
    }

    /** Whether the bean is the one {@code DatumPdfAutoConfiguration#datumPdfRuntime} made. */
    private boolean isBindingDefault(String beanName) {
        if (beans == null || !beans.containsBeanDefinition(beanName)) {
            return false;
        }
        if (!(beans.getMergedBeanDefinition(beanName) instanceof RootBeanDefinition definition)) {
            return false;
        }
        Method factory = definition.getResolvedFactoryMethod();
        return factory != null && factory.getDeclaringClass() == DatumPdfAutoConfiguration.class && factory.getName().equals("datumPdfRuntime");
    }
}
