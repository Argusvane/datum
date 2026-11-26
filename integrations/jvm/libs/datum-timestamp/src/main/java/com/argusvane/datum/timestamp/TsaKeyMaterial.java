package com.argusvane.datum.timestamp;

import java.time.Clock;
import java.util.Objects;

/**
 * Where the timestamp server's key comes from (SPI). {@link TimestampAuthority} asks for it on every token, so a store
 * may rotate the key between tokens; a key it
 * cannot give is a systemFailure refusal ("The timestamp server has no usable key."), its reason logged.
 *
 * <p>Whatever the implementation, {@link TimestampAuthority} itself holds the key it is given to the key checks on
 * every token (the private key is the certificate's, then
 * {@link TsaCertificateRules} at the server's clock), so no material can bring an unusable key past it; the checks
 * an implementation makes on its own only refuse earlier.
 *
 * <p>Implementations: {@link KeyStoreTsaKeyMaterial} (a PKCS#12 or other {@link java.security.KeyStore}),
 * {@link #of(TsaKey)} for a key already loaded, {@link #checked(TsaKey, Clock)} for one held to
 * {@link TsaCertificateRules} at every use by any caller, not only the authority.
 */
@FunctionalInterface
public interface TsaKeyMaterial {

    /**
     * The key and its chain, leaf first.
     *
     * @throws TsaKeyException when there is no usable key
     */
    TsaKey load();

    /** A key already loaded, given as is (the authority checks it on every token; {@link SelfSignedTsaCertificate} passes). */
    static TsaKeyMaterial of(TsaKey key) {
        Objects.requireNonNull(key, "key");
        return () -> key;
    }

    /**
     * A key already loaded, held to {@link TsaCertificateRules} at every use: an expired certificate stops
     * issuing tokens the moment it expires.
     */
    static TsaKeyMaterial checked(TsaKey key, Clock clock) {
        Objects.requireNonNull(key, "key");
        Objects.requireNonNull(clock, "clock");
        return () -> {
            TsaCertificateRules.problem(key.leaf(), clock.instant()).ifPresent(problem -> {
                throw new TsaKeyException(problem);
            });
            return key;
        };
    }
}
