package com.argusvane.datum.springweb.spring;

import java.security.KeyStore;
import java.util.Optional;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.ssl.NoSuchSslBundleException;
import org.springframework.boot.ssl.SslBundle;
import org.springframework.boot.ssl.SslBundles;

/**
 * A signing key out of a Spring Boot SSL bundle (framework-first: how a key store is located, typed and
 * unlocked is {@code spring.ssl.bundle.jks.*} or {@code spring.ssl.bundle.pem.*}, and Datum has no key store properties
 * of its own). The key is read once, at start: no bundle update handler is
 * registered, so Boot's {@code reload-on-update} does not reach a running signer (rotation without a restart is not supported). The PDF signer and the timestamp server's key both
 * read their bundle here, so a bundle that is missing or holds no key store gets one message naming the Datum property
 * that pointed at it, and never a password. The class only describes the problem; the auto-configuration, which owns the
 * start, throws it (a binding class builds no refusals of its own).
 */
public final class SigningBundles {

    private SigningBundles() {
    }

    /**
     * A key store with the alias and password of the key in it.
     *
     * @param store    the loaded key store
     * @param alias    the key's alias; null for the store's only key entry
     * @param password the key's password: the bundle's {@code key.password}, else the key store's, else null
     */
    public record Key(KeyStore store, String alias, char[] password) {

        @Override
        public String toString() {
            return "Key[alias=" + alias + "]";
        }
    }

    /**
     * What a bundle gave: its key, or the reason it could not.
     *
     * @param key     the key, when there is one
     * @param problem why there is none (names the property), else null
     */
    public record Lookup(Key key, String problem) {

        /** The key, or the problem as the message of a start failure for the caller to throw. */
        public Optional<String> failure() {
            return Optional.ofNullable(problem);
        }
    }

    /**
     * The key in a bundle.
     *
     * @param bundles  the application's bundles ({@code spring.ssl.bundle.*}); empty when Boot's SSL support is not on
     * @param name     the bundle's name
     * @param property the Datum property that named it, for the message
     */
    public static Lookup key(ObjectProvider<SslBundles> bundles, String name, String property) {
        SslBundles registry = bundles.getIfAvailable();
        if (registry == null) {
            return failed(property + " names the SSL bundle \"" + name + "\", but this application has no SSL bundles: "
                + "define it under spring.ssl.bundle.jks.<name> or spring.ssl.bundle.pem.<name>.");
        }
        SslBundle bundle;
        try {
            bundle = registry.getBundle(name);
        } catch (NoSuchSslBundleException e) {
            return failed(property + " names the SSL bundle \"" + name + "\", which is not defined under spring.ssl.bundle.*.");
        }
        KeyStore store;
        try {
            store = bundle.getStores().getKeyStore();
        } catch (RuntimeException e) {
            return failed(property + ": the SSL bundle \"" + name + "\" cannot be loaded: " + e.getMessage());
        }
        if (store == null) {
            return failed(property + ": the SSL bundle \"" + name + "\" holds no key store (set its keystore).");
        }
        String password = bundle.getKey().getPassword();
        if (password == null) {
            password = bundle.getStores().getKeyStorePassword();
        }
        String alias = bundle.getKey().getAlias();
        return new Lookup(new Key(store, alias == null || alias.isBlank() ? null : alias, password == null ? null : password.toCharArray()), null);
    }

    private static Lookup failed(String problem) {
        return new Lookup(null, problem);
    }
}
