package com.argusvane.datum.springweb.mvc;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Marks a Spring MVC controller as one of Datum's.
 *
 * <p>The Datum exception advice ({@code DatumMvcExceptionHandler}) is limited to controllers carrying this
 * annotation, so it never captures the application's own handlers or its own {@code @ControllerAdvice}.
 * The WebFlux side has no annotation to key on: functional routes are matched through
 * {@link com.argusvane.datum.springweb.webflux.DatumRouteRegistry} instead.
 *
 * <p>Spring MVC wiring, so it lives in this binding module, not in datum-web-core: another host's
 * binding has its own way to scope its error mapping.
 */
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
@Documented
public @interface DatumController {
}
