package com.argusvane.datum.springweb.spring;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import org.springframework.beans.factory.annotation.Qualifier;

/**
 * Qualifies the {@code DataSource} the Datum stores use, as Spring Boot's
 * {@code @FlywayDataSource} and Spring Session's {@code @SpringSessionDataSource} do for theirs. With two databases, or
 * one that is not {@code @Primary}, mark the bean the stores should take:
 *
 * <pre>{@code
 * @Bean @DatumDataSource
 * DataSource datumDataSource() { ... }
 * }</pre>
 *
 * and every JDBC store of every Datum module (the definition snapshots, the idempotency digests, the timestamp serials, log
 * and clients, the passkeys) uses it, where before each of up to eight store beans had to be defined by hand. A bean named
 * {@code datumDataSource} is taken the same way. Without one the stores use the application's single or {@code @Primary}
 * {@code DataSource}.
 *
 * <p>The stores' transaction rule: they run under the application's transaction manager only when it is the
 * only one and manages this very data source (identity), and under a manager of their own otherwise, so a qualified
 * database that no application manager knows needs nothing more.
 */
@Target({ElementType.FIELD, ElementType.METHOD, ElementType.PARAMETER, ElementType.TYPE, ElementType.ANNOTATION_TYPE})
@Retention(RetentionPolicy.RUNTIME)
@Documented
@Qualifier(DatumDataSources.QUALIFIER)
public @interface DatumDataSource {
}
