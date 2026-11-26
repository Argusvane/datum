package com.argusvane.datum.webauthn.spring;

/** {@link JdbcStoresContract} over the postgresql script in H2 PostgreSQL mode. */
class JdbcStoresPostgresqlTest extends JdbcStoresContract {

    @Override
    protected String dialect() {
        return "postgresql";
    }

    @Override
    protected String mode() {
        return ";MODE=PostgreSQL";
    }
}
