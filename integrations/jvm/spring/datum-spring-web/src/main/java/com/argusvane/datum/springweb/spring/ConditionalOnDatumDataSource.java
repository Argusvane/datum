package com.argusvane.datum.springweb.spring;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import org.springframework.context.annotation.Conditional;

/**
 * Matches when the Datum stores have a {@code DataSource} to use: a bean qualified with
 * {@link DatumDataSource} (or named {@code datumDataSource}), or else exactly one {@code DataSource} candidate (a single bean,
 * or a {@code @Primary} among several), which is what {@code @ConditionalOnSingleCandidate(DataSource.class)} meant before.
 * With two plain data sources and none marked, the stores fall back to memory with their warning, as before.
 */
@Target({ElementType.TYPE, ElementType.METHOD})
@Retention(RetentionPolicy.RUNTIME)
@Documented
@Conditional(OnDatumDataSourceCondition.class)
public @interface ConditionalOnDatumDataSource {
}
