package com.argusvane.datum.timestamp;

import java.util.Optional;

/**
 * The applications allowed to use the timestamp server, each with a key (SPI).
 *
 * <p>A key is shown once, when its client is added: only its SHA-256 is kept ({@link TsaClientKeys#hash}; it is
 * 256 random bits, so a plain hash is enough). A client sends it as a bearer token or as the password of HTTP
 * Basic authentication with any user name ({@link TsaClientKeys#keyOf}). A revoked client's key no longer works.
 */
public interface TsaClientStore {

    /**
     * The client a key belongs to, when it is a working key (known, not revoked).
     *
     * @param key the key as the request carries it
     */
    Optional<TsaClient> authenticate(String key);

    /** Notes that a client was given a token. */
    default void used(TsaClient client) {
    }
}
