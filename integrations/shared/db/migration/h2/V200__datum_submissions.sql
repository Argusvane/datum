-- Datum submissions: the receipt first given for each accepted submit attempt (form, version, submission key) and the
-- digest of the document it was accepted with, so a retry of the attempt is answered with it and stored once, and the
-- same key with another document is refused.
-- H2 in PostgreSQL or MySQL mode accepts this as well.
CREATE TABLE datum_submission_digest (
    form_key   VARCHAR(128) NOT NULL,
    version    VARCHAR(255) NOT NULL,
    submission_key VARCHAR(128) NOT NULL,
    digest     CHAR(64)     NOT NULL,
    receipt_id VARCHAR(255) NOT NULL,
    reference  VARCHAR(255),
    receipt    CLOB,
    created    BIGINT       NOT NULL,
    PRIMARY KEY (form_key, version, submission_key)
);
