package com.argusvane.datum.springweb.spring;

import javax.sql.DataSource;
import org.springframework.beans.factory.ObjectProvider;

/**
 * Which {@code DataSource} the Datum stores take: the bean qualified with
 * {@link DatumDataSource}, else the application's single or {@code @Primary} one. The same two-step lookup as Spring
 * Session's ({@code getIfAvailable(dataSource::getObject)}).
 */
public final class DatumDataSources {

    /** The qualifier value of {@link DatumDataSource}, and the bean name that stands in for it. */
    public static final String QUALIFIER = "datumDataSource";

    private DatumDataSources() {
    }

    /**
     * @param qualified the providers' {@code @DatumDataSource ObjectProvider<DataSource>} parameter
     * @param any       the same parameter without the qualifier
     * @return the qualified data source, else the single or primary one
     * @throws org.springframework.beans.factory.NoUniqueBeanDefinitionException when more than one is marked, or none is marked and the
     *     candidates are not unique (the stores' conditions have excluded the second case)
     */
    public static DataSource choose(ObjectProvider<DataSource> qualified, ObjectProvider<DataSource> any) {
        return qualified.getIfAvailable(any::getObject);
    }

    /**
     * {@link #choose(ObjectProvider, ObjectProvider)}, and the module's tables made first when
     * {@code datum.jdbc.initialize-schema} asks for it and they are missing. What every JDBC store's bean method calls, so
     * the choice of database and the creation of its tables cannot differ between the stores.
     *
     * @param schema the shared initializer, which is absent without Boot's SQL initialisation (the schema is then the application's)
     * @param module which module's tables the store needs
     */
    public static DataSource prepare(ObjectProvider<DataSource> qualified, ObjectProvider<DataSource> any,
                                     ObjectProvider<JdbcSchemaInitializer> schema, JdbcSchemaInitializer.Schema module) {
        DataSource dataSource = choose(qualified, any);
        schema.ifAvailable(initializer -> initializer.initialize(dataSource, module));
        return dataSource;
    }
}
