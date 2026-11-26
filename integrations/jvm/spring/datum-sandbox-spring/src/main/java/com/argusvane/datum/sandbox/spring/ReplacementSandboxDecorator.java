package com.argusvane.datum.sandbox.spring;

import com.argusvane.datum.sandbox.protocol.Sandbox;
import com.argusvane.datum.sandbox.runtime.DatumSandbox;
import java.lang.reflect.Method;
import java.util.Objects;
import org.springframework.beans.BeansException;
import org.springframework.beans.factory.BeanFactory;
import org.springframework.beans.factory.BeanFactoryAware;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.beans.factory.support.RootBeanDefinition;
import org.springframework.beans.factory.config.ConfigurableListableBeanFactory;

/**
 * The decorator chain on a {@link Sandbox} bean the application replaced the default with: Spring Boot applies its customizers and decorators to the bean that is there, default or replacement, and so
 * does Datum. The default {@code datumSandbox} bean is the runtime's own sandbox, wrapped when the runtime built it, so it is
 * left alone; any other {@code Sandbox} bean is handed to {@link DatumSandbox#decorate(Sandbox)}, which applies Datum's
 * {@code datum.sandbox.run} observation and the host's {@code SandboxDecorator} beans in their order. A replacement can then never
 * take a request run out of the decorators' sight.
 *
 * <p>The default is recognised by the method that made it, not by its name: an application's own bean named
 * {@code datumSandbox} is a replacement too. A sandbox the application takes from the runtime and publishes as a bean of its
 * own is the runtime's already and is not wrapped twice.
 */
final class ReplacementSandboxDecorator implements BeanPostProcessor, BeanFactoryAware {

    private final ObjectProvider<DatumSandbox> runtime;
    private ConfigurableListableBeanFactory beans;

    ReplacementSandboxDecorator(ObjectProvider<DatumSandbox> runtime) {
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
        if (!(bean instanceof Sandbox sandbox) || isBindingDefault(beanName)) {
            return bean;
        }
        DatumSandbox datum = runtime.getIfAvailable();
        if (datum == null || sandbox == datum.sandboxOrNull()) {
            return bean;
        }
        return datum.decorate(sandbox);
    }

    /** Whether the bean is the one {@code DatumSandboxAutoConfiguration#datumSandbox} made. */
    private boolean isBindingDefault(String beanName) {
        if (beans == null || !beans.containsBeanDefinition(beanName)) {
            return false;
        }
        if (!(beans.getMergedBeanDefinition(beanName) instanceof RootBeanDefinition definition)) {
            return false;
        }
        Method factory = definition.getResolvedFactoryMethod();
        return factory != null && factory.getDeclaringClass() == DatumSandboxAutoConfiguration.class
            && factory.getName().equals("datumSandbox");
    }
}
