-- Datum submissions: the receipt first given for each accepted submit attempt (form, version, submission key) and the
-- digest of the document it was accepted with, so a retry of the attempt is answered with it and stored once, and the
-- same key with another document is refused.
-- ascii keys (the submission key compared byte for byte) and a binary version keep the primary key exact and inside InnoDB's index size limit.
CREATE TABLE datum_submission_digest (
    form_key   VARCHAR(128) CHARACTER SET ascii NOT NULL,
    version    VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    submission_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    digest     CHAR(64)     CHARACTER SET ascii NOT NULL,
    receipt_id VARCHAR(255) NOT NULL,
    reference  VARCHAR(255),
    receipt    LONGTEXT     CHARACTER SET utf8mb4,
    created    BIGINT       NOT NULL,
    PRIMARY KEY (form_key, version, submission_key)
) ENGINE = InnoDB;
