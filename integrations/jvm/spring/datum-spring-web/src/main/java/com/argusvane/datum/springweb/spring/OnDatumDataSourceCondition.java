package com.argusvane.datum.springweb.spring;

import javax.sql.DataSource;
import org.springframework.beans.factory.BeanFactoryUtils;
import org.springframework.beans.factory.config.ConfigurableListableBeanFactory;
import org.springframework.beans.factory.annotation.BeanFactoryAnnotationUtils;
import org.springframework.boot.autoconfigure.condition.AnyNestedCondition;
import org.springframework.boot.autoconfigure.condition.ConditionalOnSingleCandidate;
import org.springframework.context.annotation.Condition;
import org.springframework.context.annotation.ConditionContext;
import org.springframework.context.annotation.Conditional;
import org.springframework.core.type.AnnotatedTypeMetadata;

/** The condition of {@link ConditionalOnDatumDataSource}: a qualified data source, or a single candidate. */
final class OnDatumDataSourceCondition extends AnyNestedCondition {

    OnDatumDataSourceCondition() {
        super(ConfigurationPhase.REGISTER_BEAN);
    }

    @Conditional(QualifiedDataSource.class)
    static final class Qualified {
    }

    @ConditionalOnSingleCandidate(DataSource.class)
    static final class Single {
    }

    /** A {@code DataSource} bean with the {@link DatumDataSource} qualifier (on its {@code @Bean} method or type) or the qualifier's name. */
    static final class QualifiedDataSource implements Condition {

        @Override
        public boolean matches(ConditionContext context, AnnotatedTypeMetadata metadata) {
            ConfigurableListableBeanFactory beans = context.getBeanFactory();
            if (beans == null) {
                return false;
            }
            // Type lookup without initialising a bean (a data source may be a factory bean not created yet).
            for (String name : BeanFactoryUtils.beanNamesForTypeIncludingAncestors(beans, DataSource.class, true, false)) {
                if (BeanFactoryAnnotationUtils.isQualifierMatch(DatumDataSources.QUALIFIER::equals, name, beans)) {
                    return true;
                }
            }
            return false;
        }
    }
}
