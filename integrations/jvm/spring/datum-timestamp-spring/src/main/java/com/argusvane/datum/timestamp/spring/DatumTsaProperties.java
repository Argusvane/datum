package com.argusvane.datum.timestamp.spring;

import com.argusvane.datum.core.DatumConfigurationException;
import com.argusvane.datum.timestamp.web.TsaSettings.Access;
import com.argusvane.datum.timestamp.web.TsaSettings.ClientStore;
import com.argusvane.datum.timestamp.web.TsaSettings;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.util.unit.DataSize;

/**
 * {@code datum.tsa.*}: the RFC 3161 timestamp server. Off by default: a host that does not set {@code enabled=true} has
 * no timestamp endpoints at all (404), and none of this module's beans besides the library.
 *
 * <p>The Spring binding of {@link TsaSettings}: {@link #toSettings()} is what the library reads, and
 * {@code access} and {@code client-store} bind the library's enums.
 */
@ConfigurationProperties("datum.tsa")
public class DatumTsaProperties {

    /** The largest {@code max-request-size} accepted. */
    static final DataSize MAX_REQUEST_SIZE = DataSize.ofBytes(TsaSettings.MAX_REQUEST_BYTES);

    /** Turn the server on. */
    private boolean enabled = false;

    /** Where it answers; {@code /certificate} and {@code /certificates} hang below it. */
    private String path = "/tsa";

    /** Who may ask for a token: clients (a registered client key, the default) or open (anyone; flood limits still apply per address). */
    private Access access = Access.CLIENTS;

    /** The policy object identifier tokens name; empty for the Datum default. */
    private String policy;

    /**
     * Further policy object identifiers (dotted) a request may ask for with reqPolicy; a token then names the policy asked for.
     * The issuing policy ({@code policy}) is always accepted, so empty accepts that one only. Any other asked-for policy is refused
     * with unacceptedPolicy.
     */
    private List<String> acceptedPolicies = new ArrayList<>();

    /** The accuracy tokens state (whole milliseconds, 0 to 60 s; zero states none). */
    private Duration accuracy = Duration.ofSeconds(1);

    /** The largest request body read; a TimeStampReq is a few hundred bytes. */
    private DataSize maxRequestSize = DataSize.ofKilobytes(16);

    private final Flood flood = new Flood();

    private final Signer signer = new Signer();

    /** Where the client keys live. */
    private ClientStore clientStore = ClientStore.PROPERTIES;

    /**
     * Client keys' SHA-256 (lowercase hex) for the properties store, each optionally as {@code label=hash}; make a
     * key with {@code TsaClientKeys.generate()} and keep only {@code TsaClientKeys.hash(key)}.
     */
    private List<String> clients = new ArrayList<>();

    /** PEM files (a Spring resource each) of certificates the server signed with before, for {@code /certificates}. */
    private List<String> retiredCertificates = new ArrayList<>();

    /**
     * Cookie names that make a request a browser session's: such a request is refused (403). The default {@code *}
     * refuses a request that carries any cookie; a list of names refuses only those (case-insensitive), and {@code *}
     * among them means any.
     */
    private List<String> sessionCookies = new ArrayList<>(List.of("*"));

    /**
     * Acknowledge single-instance use of the in-memory serial allocator and log. Without a DataSource and the
     * {@code V300__datum_timestamp.sql} migration, or an application {@code TsaSerialAllocator} bean, the start is
     * refused unless this is true.
     */
    private boolean allowMemoryStores = false;

    /** These properties as the library's settings. */
    public TsaSettings toSettings() {
        return new TsaSettings(enabled, path, access, policy, accuracy, maxRequestSize.toBytes(), flood.getLimit(), flood.getWindow(),
            new TsaSettings.Signer(signer.isSelfSigned()),
            clientStore, clients, retiredCertificates, sessionCookies, allowMemoryStores, acceptedPolicies, flood.getFailedKeys());
    }

    public List<String> getAcceptedPolicies() {
        return acceptedPolicies;
    }

    public void setAcceptedPolicies(List<String> acceptedPolicies) {
        this.acceptedPolicies = acceptedPolicies == null ? new ArrayList<>() : new ArrayList<>(acceptedPolicies);
    }

    public boolean isAllowMemoryStores() {
        return allowMemoryStores;
    }

    public void setAllowMemoryStores(boolean allowMemoryStores) {
        this.allowMemoryStores = allowMemoryStores;
    }

    public boolean isEnabled() {
        return enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    public String getPath() {
        return path;
    }

    public void setPath(String path) {
        this.path = normalise(path);
    }

    public Access getAccess() {
        return access;
    }

    public void setAccess(Access access) {
        this.access = access;
    }

    public String getPolicy() {
        return policy;
    }

    public void setPolicy(String policy) {
        this.policy = policy == null || policy.isBlank() ? null : policy.strip();
    }

    public Duration getAccuracy() {
        return accuracy;
    }

    public void setAccuracy(Duration accuracy) {
        this.accuracy = accuracy;
    }

    public DataSize getMaxRequestSize() {
        return maxRequestSize;
    }

    public void setMaxRequestSize(DataSize maxRequestSize) {
        // A TimeStampReq is a few hundred bytes; none would refuse every request, and a megabyte is far more than
        // any request needs, so a bigger value is a mistake that would let each unauthenticated request buffer it.
        if (maxRequestSize == null || maxRequestSize.toBytes() < 1 || maxRequestSize.compareTo(MAX_REQUEST_SIZE) > 0) {
            throw new DatumConfigurationException("datum.tsa.max-request-size", "datum.tsa.max-request-size must be between 1B and 1MB, not " + maxRequestSize + ".");
        }
        this.maxRequestSize = maxRequestSize;
    }

    public Flood getFlood() {
        return flood;
    }

    public Signer getSigner() {
        return signer;
    }

    public ClientStore getClientStore() {
        return clientStore;
    }

    public void setClientStore(ClientStore clientStore) {
        this.clientStore = clientStore;
    }

    public List<String> getClients() {
        return clients;
    }

    public void setClients(List<String> clients) {
        this.clients = clients == null ? new ArrayList<>() : new ArrayList<>(clients);
    }

    public List<String> getRetiredCertificates() {
        return retiredCertificates;
    }

    public void setRetiredCertificates(List<String> retiredCertificates) {
        this.retiredCertificates = retiredCertificates == null ? new ArrayList<>() : new ArrayList<>(retiredCertificates);
    }

    public List<String> getSessionCookies() {
        return sessionCookies;
    }

    public void setSessionCookies(List<String> sessionCookies) {
        this.sessionCookies = sessionCookies == null ? new ArrayList<>() : new ArrayList<>(sessionCookies);
    }

    private static String normalise(String path) {
        return TsaSettings.normalise(path);
    }

    /** Requests allowed per window, per client (or per address for open requests). */
    public static class Flood {

        /** Tokens per window; 0 turns the limit off. */
        private int limit = 1000;

        /** The span the flood limit counts tokens over; a fixed window per client (or per address for open requests). */
        private Duration window = Duration.ofHours(1);

        /**
         * Wrong client keys one address may present per hour before it is answered 429 with Retry-After 3600. From 1 to 10000;
         * outside that the start stops naming this property.
         */
        private int failedKeys = 10;

        public int getFailedKeys() {
            return failedKeys;
        }

        public void setFailedKeys(int failedKeys) {
            this.failedKeys = failedKeys;
        }

        public int getLimit() {
            return limit;
        }

        public void setLimit(int limit) {
            this.limit = limit;
        }

        public Duration getWindow() {
            return window;
        }

        public void setWindow(Duration window) {
            this.window = window;
        }
    }

    /** The signing key: a Spring Boot SSL bundle, or a self-signed development certificate. */
    public static class Signer {

        /**
         * The name of the SSL bundle ({@code spring.ssl.bundle.jks.<name>} or {@code .pem.<name>}) whose key store holds
         * the server's timestamp signing key and its chain; the bundle's {@code key.alias} and {@code key.password} pick
         * and unlock the key.
         */
        private String sslBundle;

        /** Make a throw-away self-signed certificate at start (development only; tokens verify against no one). */
        private boolean selfSigned = false;

        public String getSslBundle() {
            return sslBundle;
        }

        public void setSslBundle(String sslBundle) {
            this.sslBundle = sslBundle == null || sslBundle.isBlank() ? null : sslBundle.strip();
        }

        public boolean isSelfSigned() {
            return selfSigned;
        }

        public void setSelfSigned(boolean selfSigned) {
            this.selfSigned = selfSigned;
        }
    }
}
