package com.argusvane.datum.timestamp;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.security.Key;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.time.Clock;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

/**
 * The timestamp server's key from a {@link KeyStore} (PKCS#12 by default): the Spring host's
 * {@code datum.tsa.signer.*} properties name the file, its password, the alias and the key password.
 *
 * <p>The key is read once and kept (a PKCS#12 key costs a password derivation to open); its certificate is held
 * to {@link TsaCertificateRules} on every {@link #load()}, so an expired certificate stops issuing tokens. The chain is
 * rebuilt leaf first: the key's own certificate, then its issuers in order.
 */
public final class KeyStoreTsaKeyMaterial implements TsaKeyMaterial {

    private final KeyStore keyStore;
    private final String alias;
    private final char[] keyPassword;
    private final Clock clock;
    private volatile TsaKey key;

    /**
     * @param keyStore a loaded key store
     * @param alias the key's alias, or {@code null} when the store holds one key
     * @param keyPassword the key's password ({@code null}: none)
     * @param clock what "now" is when the certificate's validity is checked
     */
    public KeyStoreTsaKeyMaterial(KeyStore keyStore, String alias, char[] keyPassword, Clock clock) {
        this.keyStore = Objects.requireNonNull(keyStore, "keyStore");
        this.alias = alias;
        this.keyPassword = keyPassword == null ? null : keyPassword.clone();
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    /**
     * Opens a key store file.
     *
     * @param path the file
     * @param type the store type ({@code PKCS12}, {@code JKS}, ...)
     * @param storePassword the store's password
     * @param alias the key's alias, or {@code null} when the store holds one key
     * @param keyPassword the key's password, or {@code null} to use the store's
     * @throws TsaKeyException when the file cannot be opened
     */
    public static KeyStoreTsaKeyMaterial open(Path path, String type, char[] storePassword, String alias, char[] keyPassword, Clock clock) {
        try (InputStream in = Files.newInputStream(path)) {
            KeyStore store = KeyStore.getInstance(type == null ? "PKCS12" : type);
            store.load(in, storePassword);
            return new KeyStoreTsaKeyMaterial(store, alias, keyPassword != null ? keyPassword : storePassword, clock);
        } catch (IOException | GeneralSecurityException e) {
            // The message names the file, never a password.
            throw new TsaKeyException("The timestamp server key store " + path + " cannot be opened: " + e.getMessage(), e);
        }
    }

    @Override
    public TsaKey load() {
        TsaKey loaded = key;
        if (loaded == null) {
            synchronized (this) {
                loaded = key;
                if (loaded == null) {
                    loaded = read();
                    key = loaded;
                }
            }
        }
        TsaKey checked = loaded;
        TsaCertificateRules.problem(checked.leaf(), clock.instant()).ifPresent(problem -> {
            throw new TsaKeyException(problem);
        });
        return checked;
    }

    private TsaKey read() {
        try {
            String name = alias != null ? alias : onlyKeyAlias();
            if (!keyStore.isKeyEntry(name)) {
                throw new TsaKeyException("The key store holds no key under the alias " + name + ".");
            }
            Key entry = keyStore.getKey(name, keyPassword);
            if (!(entry instanceof PrivateKey privateKey)) {
                throw new TsaKeyException("The key store's entry " + name + " is not a private key.");
            }
            Certificate[] stored = keyStore.getCertificateChain(name);
            List<X509Certificate> certificates = new ArrayList<>();
            for (Certificate certificate : stored == null ? new Certificate[0] : stored) {
                if (certificate instanceof X509Certificate x509) {
                    certificates.add(x509);
                }
            }
            if (certificates.isEmpty()) {
                throw new TsaKeyException("There is no certificate: give the key’s certificate with it.");
            }
            return new TsaKey(privateKey, KeyChecks.chain(privateKey, certificates));
        } catch (GeneralSecurityException e) {
            throw new TsaKeyException("The timestamp server key cannot be read from the key store: " + e.getMessage(), e);
        }
    }

    private String onlyKeyAlias() throws GeneralSecurityException {
        List<String> keys = new ArrayList<>();
        for (String name : Collections.list(keyStore.aliases())) {
            if (keyStore.isKeyEntry(name)) {
                keys.add(name);
            }
        }
        if (keys.size() != 1) {
            throw new TsaKeyException(keys.isEmpty()
                ? "The key store holds no private key."
                : "The key store holds " + keys.size() + " keys: name the timestamp server's alias.");
        }
        return keys.get(0);
    }
}
