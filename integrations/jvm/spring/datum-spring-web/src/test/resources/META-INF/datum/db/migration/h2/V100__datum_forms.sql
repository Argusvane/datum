-- A stand-in for the forms module's script (the real one lives in datum-forms): JdbcSchemaInitializerTest only needs a script
-- that makes the table the initializer probes for. Test resource only; the module itself carries no Datum resources.
CREATE TABLE datum_definition_snapshot (
    form_key VARCHAR(128) NOT NULL,
    sha256   CHAR(64)     NOT NULL,
    PRIMARY KEY (form_key, sha256)
);
