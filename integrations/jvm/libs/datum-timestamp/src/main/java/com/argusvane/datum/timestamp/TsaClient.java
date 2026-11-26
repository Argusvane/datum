package com.argusvane.datum.timestamp;

import java.util.Objects;

/**
 * An application allowed to use the timestamp server (a {@link TsaClientStore} row): what the log
 * records of who asked.
 *
 * @param id the client's id, as the store keeps it
 * @param label the client's name
 */
public record TsaClient(String id, String label) {

    public TsaClient {
        Objects.requireNonNull(id, "id");
        Objects.requireNonNull(label, "label");
    }
}
