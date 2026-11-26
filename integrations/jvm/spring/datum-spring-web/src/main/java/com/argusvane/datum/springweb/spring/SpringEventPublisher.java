package com.argusvane.datum.springweb.spring;

import com.argusvane.datum.core.DatumEventPublisher;
import java.util.Objects;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.ApplicationEventPublisher;

/**
 * The libraries' {@link DatumEventPublisher} over Spring's {@link ApplicationEventPublisher}:
 * every Datum event becomes an application event, delivered as Spring delivers it (synchronously unless the
 * application configures a multicaster), so {@code @EventListener} methods keep working unchanged. Unguarded on its own:
 * the {@code datumEventPublisher} bean is this one behind {@link DatumEventPublisher#guarded}.
 */
public final class SpringEventPublisher implements DatumEventPublisher {

    private final ApplicationEventPublisher events;

    public SpringEventPublisher(ApplicationEventPublisher events) {
        this.events = Objects.requireNonNull(events, "events");
    }

    @Override
    public void publish(Object event) {
        events.publishEvent(event);
    }

    /**
     * The publisher a binding hands its library: the {@code datumEventPublisher} bean, else, in a context without
     * datum-spring-web's auto-configuration (a slice, a binding's own test), the guarded publisher over {@code events}, as the
     * default bean is. An application's own bean is handed over as given: the guard is Datum's
     * default, and a replacement owns its failure semantics (an outbox write that fails reaches the caller).
     */
    public static DatumEventPublisher of(ObjectProvider<DatumEventPublisher> bean, ApplicationEventPublisher events) {
        return bean.getIfAvailable(() -> DatumEventPublisher.guarded(new SpringEventPublisher(events)));
    }
}
