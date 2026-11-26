package com.argusvane.datum.starter.test;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Inherited;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import org.springframework.boot.autoconfigure.ImportAutoConfiguration;
import org.springframework.boot.test.context.PropertyMapping;

/**
 * Starts Datum in a test without the WebAssembly engine: the application's context gets a {@link FakeGuestRuntime}
 * as its {@code GuestRuntime}, so the real Endive runtime (several seconds of start, native code) backs off and the
 * programs are proved against the canned answers. Put it on a {@code @SpringBootTest} or on a test configuration
 * next to the auto-configurations under test; read or script the fake by autowiring {@link FakeGuestRuntime}.
 *
 * <p>With {@link #testForms()} the fixture forms of {@link DatumTestForms} are the form repository too (an
 * application's own {@code FormDefinitionRepository} bean still wins). Tests that must run the real programs do not
 * use this annotation; they run in the {@code real-runtime} tag (the examples' integration tests).
 *
 * <p>Built as Boot's own test annotations are: {@code @ImportAutoConfiguration} with a
 * {@code META-INF/spring/com.argusvane.datum.starter.test.AutoConfigureDatum.imports} file naming two
 * auto-configurations, and {@code @PropertyMapping} turning {@link #testForms()} into a property. So the fake appears in the
 * condition report, backs off for the application's own beans whatever order the test configurations load in, and the
 * annotation composes with slices ({@code @WebMvcTest} together with {@code @AutoConfigureDatum}).
 */
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
@Documented
@Inherited
@ImportAutoConfiguration
@PropertyMapping("datum.test")
public @interface AutoConfigureDatum {

    /** Also serve {@link DatumTestForms#all()} as the form repository ({@code datum.test.forms=true}). */
    @PropertyMapping(value = "forms", skip = PropertyMapping.Skip.ON_DEFAULT_VALUE)
    boolean testForms() default false;
}
