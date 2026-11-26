-- Datum forms: every definition a form has had, by the SHA-256 of its canonical JSON. H2 in PostgreSQL or MySQL mode accepts this as well.
CREATE TABLE datum_definition_snapshot (
    form_key   VARCHAR(128) NOT NULL,
    sha256     CHAR(64)     NOT NULL,
    version    VARCHAR(64)  NOT NULL DEFAULT '',
    definition CLOB         NOT NULL,
    created    BIGINT       NOT NULL,
    PRIMARY KEY (form_key, sha256)
);
CREATE INDEX datum_definition_snapshot_version ON datum_definition_snapshot (form_key, version);
