package com.argusvane.datum.webauthn.spring;

/** {@link JdbcStoresContract} over the h2 script (H2 regular mode). */
class JdbcStoresTest extends JdbcStoresContract {

    @Override
    protected String dialect() {
        return "h2";
    }

    @Override
    protected String mode() {
        return "";
    }
}
