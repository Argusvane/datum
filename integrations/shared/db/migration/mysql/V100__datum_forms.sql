-- Datum forms: every definition a form has had, by the SHA-256 of its canonical JSON.
-- ascii keys keep the primary key inside InnoDB's index size limit; the definition itself is utf8mb4 text.
CREATE TABLE datum_definition_snapshot (
    form_key   VARCHAR(128) CHARACTER SET ascii NOT NULL,
    sha256     CHAR(64)     CHARACTER SET ascii NOT NULL,
    version    VARCHAR(64)  NOT NULL DEFAULT '',
    definition LONGTEXT     CHARACTER SET utf8mb4 NOT NULL,
    created    BIGINT       NOT NULL,
    PRIMARY KEY (form_key, sha256)
) ENGINE = InnoDB;
CREATE INDEX datum_definition_snapshot_version ON datum_definition_snapshot (form_key, version);
