package com.argusvane.datum.timestamp.web;

import com.argusvane.datum.core.DatumConfigurationException;
import java.time.Duration;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * {@code datum.tsa.*}: the RFC 3161 timestamp server, as one framework-free value with its defaults and checks (integrations/jvm/README.md "Libraries and bindings"). Spring's {@code DatumTsaProperties} and a Quarkus
 * config mapping would both map onto it, so the path is normalised and the request cap checked in one place.
 *
 * @param enabled             turn the server on; off, a host has no timestamp endpoints at all (404)
 * @param path                where it answers; {@code /certificate} and {@code /certificates} hang below it
 * @param access              who may ask for a token
 * @param policy              the policy object identifier tokens name; null for the Datum default
 * @param accuracy            the accuracy tokens state (whole milliseconds, 0 to 60 s; zero states none)
 * @param maxRequestBytes     the largest request body read: 1 byte to 1 MiB (a TimeStampReq is a few hundred bytes)
 * @param floodLimit          tokens per window per client (or per address for open requests); 0 turns the limit off
 * @param floodWindow         the flood window
 * @param signer              the signing key options: a self-signed development certificate or none
 * @param clientStore         where the client keys live
 * @param clients             client keys' SHA-256 for the properties store, each optionally as {@code label=hash}
 * @param retiredCertificates PEM locations of certificates the server signed with before, for {@code /certificates}
 * @param sessionCookies      cookie names that make a request a browser session's: such a request is refused (403). The
 *                            default is {@code ["*"]}, which refuses a request that carries any cookie; a list of names
 *                            refuses only those (case-insensitive), and {@code "*"} among them means any; empty refuses none
 * @param allowMemoryStores   acknowledge single-instance use of the in-memory serial allocator and log
 * @param acceptedPolicies    further policy object identifiers a request may ask for ({@code datum.tsa.accepted-policies});
 *                            the issuing policy is always accepted, so empty is the default
 * @param failedKeysPerHour   wrong client keys one address may present per hour before it is answered 429 ({@code datum.tsa.flood.failed-keys}; 1 to 10,000)
 */
public record TsaSettings(boolean enabled, String path, Access access, String policy, Duration accuracy, long maxRequestBytes,
                          int floodLimit, Duration floodWindow, Signer signer, ClientStore clientStore, List<String> clients,
                          List<String> retiredCertificates, List<String> sessionCookies, boolean allowMemoryStores,
                          List<String> acceptedPolicies, int failedKeysPerHour) {
    // Copies: one component changed, the rest kept; the canonical constructor
    // checks the result, so a copy cannot hold what a new value could not. Replaces a positional constructor call that
    // breaks whenever a component is added.

    /** A copy with {@code enabled} replaced and every other component kept. */
    public TsaSettings withEnabled(boolean value) {
        return new TsaSettings(value, path, access, policy, accuracy, maxRequestBytes, floodLimit, floodWindow, signer, clientStore, clients, retiredCertificates, sessionCookies, allowMemoryStores, acceptedPolicies, failedKeysPerHour);
    }

    /** A copy with {@code path} replaced and every other component kept. */
    public TsaSettings withPath(String value) {
        return new TsaSettings(enabled, value, access, policy, accuracy, maxRequestBytes, floodLimit, floodWindow, signer, clientStore, clients, retiredCertificates, sessionCookies, allowMemoryStores, acceptedPolicies, failedKeysPerHour);
    }

    /** A copy with {@code access} replaced and every other component kept. */
    public TsaSettings withAccess(Access value) {
        return new TsaSettings(enabled, path, value, policy, accuracy, maxRequestBytes, floodLimit, floodWindow, signer, clientStore, clients, retiredCertificates, sessionCookies, allowMemoryStores, acceptedPolicies, failedKeysPerHour);
    }

    /** A copy with {@code policy} replaced and every other component kept. */
    public TsaSettings withPolicy(String value) {
        return new TsaSettings(enabled, path, access, value, accuracy, maxRequestBytes, floodLimit, floodWindow, signer, clientStore, clients, retiredCertificates, sessionCookies, allowMemoryStores, acceptedPolicies, failedKeysPerHour);
    }

    /** A copy with {@code accuracy} replaced and every other component kept. */
    public TsaSettings withAccuracy(Duration value) {
        return new TsaSettings(enabled, path, access, policy, value, maxRequestBytes, floodLimit, floodWindow, signer, clientStore, clients, retiredCertificates, sessionCookies, allowMemoryStores, acceptedPolicies, failedKeysPerHour);
    }

    /** A copy with {@code maxRequestBytes} replaced and every other component kept. */
    public TsaSettings withMaxRequestBytes(long value) {
        return new TsaSettings(enabled, path, access, policy, accuracy, value, floodLimit, floodWindow, signer, clientStore, clients, retiredCertificates, sessionCookies, allowMemoryStores, acceptedPolicies, failedKeysPerHour);
    }

    /** A copy with {@code floodLimit} replaced and every other component kept. */
    public TsaSettings withFloodLimit(int value) {
        return new TsaSettings(enabled, path, access, policy, accuracy, maxRequestBytes, value, floodWindow, signer, clientStore, clients, retiredCertificates, sessionCookies, allowMemoryStores, acceptedPolicies, failedKeysPerHour);
    }

    /** A copy with {@code floodWindow} replaced and every other component kept. */
    public TsaSettings withFloodWindow(Duration value) {
        return new TsaSettings(enabled, path, access, policy, accuracy, maxRequestBytes, floodLimit, value, signer, clientStore, clients, retiredCertificates, sessionCookies, allowMemoryStores, acceptedPolicies, failedKeysPerHour);
    }

    /** A copy with {@code signer} replaced and every other component kept. */
    public TsaSettings withSigner(Signer value) {
        return new TsaSettings(enabled, path, access, policy, accuracy, maxRequestBytes, floodLimit, floodWindow, value, clientStore, clients, retiredCertificates, sessionCookies, allowMemoryStores, acceptedPolicies, failedKeysPerHour);
    }

    /** A copy with {@code clientStore} replaced and every other component kept. */
    public TsaSettings withClientStore(ClientStore value) {
        return new TsaSettings(enabled, path, access, policy, accuracy, maxRequestBytes, floodLimit, floodWindow, signer, value, clients, retiredCertificates, sessionCookies, allowMemoryStores, acceptedPolicies, failedKeysPerHour);
    }

    /** A copy with {@code clients} replaced and every other component kept. */
    public TsaSettings withClients(List<String> value) {
        return new TsaSettings(enabled, path, access, policy, accuracy, maxRequestBytes, floodLimit, floodWindow, signer, clientStore, value, retiredCertificates, sessionCookies, allowMemoryStores, acceptedPolicies, failedKeysPerHour);
    }

    /** A copy with {@code retiredCertificates} replaced and every other component kept. */
    public TsaSettings withRetiredCertificates(List<String> value) {
        return new TsaSettings(enabled, path, access, policy, accuracy, maxRequestBytes, floodLimit, floodWindow, signer, clientStore, clients, value, sessionCookies, allowMemoryStores, acceptedPolicies, failedKeysPerHour);
    }

    /** A copy with {@code sessionCookies} replaced and every other component kept. */
    public TsaSettings withSessionCookies(List<String> value) {
        return new TsaSettings(enabled, path, access, policy, accuracy, maxRequestBytes, floodLimit, floodWindow, signer, clientStore, clients, retiredCertificates, value, allowMemoryStores, acceptedPolicies, failedKeysPerHour);
    }

    /** A copy with {@code allowMemoryStores} replaced and every other component kept. */
    public TsaSettings withAllowMemoryStores(boolean value) {
        return new TsaSettings(enabled, path, access, policy, accuracy, maxRequestBytes, floodLimit, floodWindow, signer, clientStore, clients, retiredCertificates, sessionCookies, value, acceptedPolicies, failedKeysPerHour);
    }

    /** A copy with {@code acceptedPolicies} replaced and every other component kept. */
    public TsaSettings withAcceptedPolicies(List<String> value) {
        return new TsaSettings(enabled, path, access, policy, accuracy, maxRequestBytes, floodLimit, floodWindow, signer, clientStore, clients, retiredCertificates, sessionCookies, allowMemoryStores, value, failedKeysPerHour);
    }

    /** A copy with {@code failedKeysPerHour} replaced and every other component kept. */
    public TsaSettings withFailedKeysPerHour(int value) {
        return new TsaSettings(enabled, path, access, policy, accuracy, maxRequestBytes, floodLimit, floodWindow, signer, clientStore, clients, retiredCertificates, sessionCookies, allowMemoryStores, acceptedPolicies, value);
    }

    /** Wrong keys per address per hour unless the host sets its own. */
    public static final int DEFAULT_FAILED_KEYS_PER_HOUR = 10;

    /** The most {@code datum.tsa.flood.failed-keys} may be. */
    public static final int MAX_FAILED_KEYS_PER_HOUR = 10_000;

    private static final Logger LOG = LoggerFactory.getLogger("datum.tsa");

    /** Who may ask for a token. */
    public enum Access {
        /** Only clients with a key (the default: an open timestamp server signs for anyone). */
        CLIENTS,
        /** Anyone; flood limits still apply per address. */
        OPEN
    }

    /** Where the client keys are kept. */
    public enum ClientStore {
        /** {@code datum.tsa.clients}: SHA-256 hashes in configuration. */
        PROPERTIES,
        /** The {@code datum_tsa_client} table (needs a DataSource). */
        JDBC
    }

    /** The largest {@code max-request-size} accepted: one mebibyte. */
    public static final long MAX_REQUEST_BYTES = 1_048_576L;

    public static final String DEFAULT_PATH = "/tsa";

    /**
     * The signing key options the library reads. The key itself comes from the host (Spring: an SSL bundle).
     *
     * @param selfSigned make a throw-away self-signed certificate at start (development only)
     */
    public record Signer(boolean selfSigned) {

        /** A copy with {@code selfSigned} replaced. */
        public Signer withSelfSigned(boolean value) {
            return new Signer(value);
        }

        public static Signer defaults() {
            return new Signer(false);
        }
    }

    /** @throws IllegalArgumentException for a request cap outside 1 byte to 1 MiB (the start fails, naming the property) */
    public TsaSettings {
        path = normalise(path);
        access = access == null ? Access.CLIENTS : access;
        policy = policy == null || policy.isBlank() ? null : policy.strip();
        if (maxRequestBytes < 1 || maxRequestBytes > MAX_REQUEST_BYTES) {
            throw new DatumConfigurationException("datum.tsa.max-request-size", "datum.tsa.max-request-size must be between 1B and 1MB, not " + maxRequestBytes + "B.");
        }
        if (floodLimit < 0) {
            throw new DatumConfigurationException("datum.tsa.flood.limit", "datum.tsa.flood.limit must be 0 (off) or more, not " + floodLimit + ".");
        }
        if (floodWindow == null || floodWindow.compareTo(Duration.ofSeconds(1)) < 0) {
            throw new DatumConfigurationException("datum.tsa.flood.window", "datum.tsa.flood.window must be at least 1s, not " + floodWindow + ".");
        }
        signer = signer == null ? Signer.defaults() : signer;
        clientStore = clientStore == null ? ClientStore.PROPERTIES : clientStore;
        clients = clients == null ? List.of() : List.copyOf(clients);
        retiredCertificates = retiredCertificates == null ? List.of() : List.copyOf(retiredCertificates);
        sessionCookies = sessionCookies == null ? List.of() : List.copyOf(sessionCookies);
        acceptedPolicies = acceptedPolicies == null ? List.of() : List.copyOf(acceptedPolicies);
        if (failedKeysPerHour < 1 || failedKeysPerHour > MAX_FAILED_KEYS_PER_HOUR) {
            throw new DatumConfigurationException("datum.tsa.flood.failed-keys", "datum.tsa.flood.failed-keys must be from 1 to " + MAX_FAILED_KEYS_PER_HOUR + ", not "
                + failedKeysPerHour + ".");
        }
    }

    /** What a host that set nothing runs with: off, clients only, 16 KiB, 1000 an hour. */
    public static TsaSettings defaults() {
        return new TsaSettings(false, DEFAULT_PATH, Access.CLIENTS, null, Duration.ofSeconds(1), 16 * 1024, 1000, Duration.ofHours(1),
            Signer.defaults(), ClientStore.PROPERTIES, List.of(), List.of(), List.of("*"), false, List.of(),
            DEFAULT_FAILED_KEYS_PER_HOUR);
    }

    /** One leading slash, no trailing slash; blank (or just {@code /}) is {@code /tsa}. */
    public static String normalise(String path) {
        if (path == null || path.isBlank()) {
            return DEFAULT_PATH;
        }
        String trimmed = path.strip();
        if (!trimmed.startsWith("/")) {
            trimmed = "/" + trimmed;
        }
        while (trimmed.length() > 1 && trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        return trimmed.equals("/") ? DEFAULT_PATH : trimmed;
    }

    /**
     * The multi-process policy for the serial store a second instance must share (the same rule as
     * {@code PasskeySettings.acknowledgeMemoryStore} in datum-webauthn): refused unless
     * {@code datum.tsa.allow-memory-stores=true} acknowledges single-instance use, then a WARN.
     *
     * @param store       the store, as the message names it ({@code serial allocator (datum_tsa_log)})
     * @param consequence what a second instance or a restart would get wrong
     * @throws DatumConfigurationException without the acknowledgement, naming the fix
     */
    public void acknowledgeMemoryStore(String store, String consequence) {
        if (!allowMemoryStores) {
            throw new DatumConfigurationException("datum.tsa", "datum.tsa has no SQL store for its " + store + ", and the in-memory one is refused because "
                + consequence + ". Add one DataSource and run "
                + "META-INF/datum/db/migration/<dialect>/V300__datum_timestamp.sql, define your own TsaSerialAllocator bean, or set "
                + "datum.tsa.allow-memory-stores=true to acknowledge a single instance.",
                "Give the application a DataSource (datum.jdbc.initialize-schema makes the tables in an embedded database; "
                    + "V300__datum_timestamp.sql elsewhere), define your own TsaSerialAllocator bean, or set datum.tsa.allow-memory-stores=true "
                    + "to run a single instance on memory.");
        }
        LOG.warn("datum.tsa keeps its {} in memory (datum.tsa.allow-memory-stores=true): {}. Single-instance use only.", store, consequence);
    }
}
