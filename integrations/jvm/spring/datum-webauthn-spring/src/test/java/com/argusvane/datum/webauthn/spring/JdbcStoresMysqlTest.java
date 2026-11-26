package com.argusvane.datum.webauthn.spring;

/** {@link JdbcStoresContract} over the mysql script in H2 MySQL mode. */
class JdbcStoresMysqlTest extends JdbcStoresContract {

    @Override
    protected String dialect() {
        return "mysql";
    }

    @Override
    protected String mode() {
        return ";MODE=MySQL";
    }
}
