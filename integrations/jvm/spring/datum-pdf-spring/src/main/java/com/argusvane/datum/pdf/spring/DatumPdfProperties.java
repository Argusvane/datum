package com.argusvane.datum.pdf.spring;

import com.argusvane.datum.pdf.PdfFonts;
import com.argusvane.datum.pdf.SealPreset;
import com.argusvane.datum.pdf.config.PdfSettings;
import com.argusvane.datum.springweb.spring.SpringResources;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.core.io.Resource;

/**
 * {@code datum.pdf.*}: what {@code PdfService} is built from (this class only
 * holds the settings and maps them onto {@link PdfSettings}, so every host reads one set of names
 * and the checks are the library's).
 *
 * <pre>
 * datum.pdf.enabled=true
 * datum.pdf.fonts=default                     # default (Sans + Bold) | standard (five faces) | all (seven)
 * datum.pdf.signing.ssl-bundle=pdf-signer    # a Spring Boot SSL bundle (spring.ssl.bundle.jks.pdf-signer.* or .pem.*)
 * datum.pdf.signing.retired-certificates=    # PEM resource: certificates the server signed with before
 * datum.pdf.signing.trust-anchors=           # PEM resource: signers and TSAs that chain to these are "trusted"
 * datum.pdf.signing.tsa.url=                 # a timestamp server; empty: the in-process authority when active
 * datum.pdf.signing.tsa.timeout=10s
 * datum.pdf.signing.tsa.policy=            # the reqPolicy OID every request asks for (unset: none)
 * datum.pdf.signing.tsa.ssl-bundle=       # the TLS trust and client key for the timestamp server (spring.ssl.bundle.*)
 * datum.pdf.signing.tsa.bearer-token=        # or basic-user + basic-password
 * datum.pdf.seal.enabled=false
 * datum.pdf.seal.layouts=                    # empty: every layout
 * datum.pdf.seal.certify=noChanges           # noChanges | formFill | annotate | none (DocMDP P=1|2|3)
 * datum.pdf.seal.timestamp=true
 * datum.pdf.seal.reason= / location= / visible=
 * datum.pdf.seal.posted-answers=false         # true: POST /pdf* seals posted, unstored answers with the server's key
 * </pre>
 */
@ConfigurationProperties(prefix = "datum.pdf")
public class DatumPdfProperties {

    /** Whether the PDF capability is on. */
    private boolean enabled = true;

    /** The fonts a request carries unless the caller asks for another pack: default, standard or all. */
    private String fonts = "default";

    private final Signing signing = new Signing();

    private final Seal seal = new Seal();

    public boolean isEnabled() {
        return enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    public String getFonts() {
        return fonts;
    }

    public void setFonts(String fonts) {
        this.fonts = fonts;
    }

    public Signing getSigning() {
        return signing;
    }

    public Seal getSeal() {
        return seal;
    }

    /** These properties as the library's settings; a test holds the defaults equal. */
    public PdfSettings toSettings() {
        Tsa tsa = signing.getTsa();
        return new PdfSettings(enabled, fonts,
            new PdfSettings.Signing(SpringResources.handle(signing.getRetiredCertificates()), SpringResources.handle(signing.getTrustAnchors()),
                new PdfSettings.Tsa(tsa.getUrl(), tsa.getTimeout(), tsa.getBearerToken(), tsa.getBasicUser(), tsa.getBasicPassword(), tsa.getPolicy())),
            new PdfSettings.Seal(seal.isEnabled(), seal.getLayouts(), seal.getCertify(), seal.isTimestamp(), seal.getReason(), seal.getLocation(),
                seal.getVisible(), seal.isPostedAnswers()));
    }

    /** {@code datum.pdf.signing.*}: the server's key and what verification trusts. */
    public static class Signing {

        /**
         * The name of the Spring Boot SSL bundle ({@code spring.ssl.bundle.jks.<name>} or {@code .pem.<name>}) whose key
         * store holds the server's PDF signing key and its chain; the bundle's {@code key.alias} and {@code key.password}
         * pick and unlock the key. Boot reads, types, unlocks and can reload the store.
         */
        private String sslBundle;

        /** PEM: certificates the server signed with before a rotation ("site_retired" when verified). */
        private Resource retiredCertificates;

        /** PEM: trust anchors for signers and timestamp authorities ("trusted" when verified). */
        private Resource trustAnchors;

        private final Tsa tsa = new Tsa();

        public String getSslBundle() {
            return sslBundle;
        }

        public void setSslBundle(String sslBundle) {
            this.sslBundle = sslBundle == null || sslBundle.isBlank() ? null : sslBundle.strip();
        }

        public Resource getRetiredCertificates() {
            return retiredCertificates;
        }

        public void setRetiredCertificates(Resource retiredCertificates) {
            this.retiredCertificates = retiredCertificates;
        }

        public Resource getTrustAnchors() {
            return trustAnchors;
        }

        public void setTrustAnchors(Resource trustAnchors) {
            this.trustAnchors = trustAnchors;
        }

        public Tsa getTsa() {
            return tsa;
        }
    }

    /** {@code datum.pdf.signing.tsa.*}: a named timestamp server for seals. */
    public static class Tsa {

        /** The timestamp server's URL; empty uses the in-process authority when it is active. */
        private String url;

        /** How long a whole request may take. */
        private Duration timeout = Duration.ofSeconds(10);

        /**
         * The Spring Boot SSL bundle ({@code spring.ssl.bundle.*}) for the TLS connection to the timestamp server: its
         * trust store checks the server, its key store (when it has one) presents a client certificate. Unset: the
         * JDK's trust.
         */
        private String sslBundle;

        /** A bearer token sent to the named timestamp server in the Authorization header; empty for none. Never logged. */
        private String bearerToken;

        /** The user name for HTTP Basic authentication to the named timestamp server; empty for none. */
        private String basicUser;

        /** The password for HTTP Basic authentication to the named timestamp server. Never logged. */
        private String basicPassword;

        /**
         * The {@code reqPolicy} object identifier (dotted) every request to the timestamp server carries, for a server that issues
         * under several policies. Unset asks for none, and the server uses its own. Read only with {@code url}; the in-process
         * authority issues under one policy ({@code datum.tsa.policy}).
         */
        private String policy;

        public String getPolicy() {
            return policy;
        }

        public void setPolicy(String policy) {
            this.policy = policy == null || policy.isBlank() ? null : policy.strip();
        }

        public String getUrl() {
            return url;
        }

        public void setUrl(String url) {
            this.url = url;
        }

        public Duration getTimeout() {
            return timeout;
        }

        public void setTimeout(Duration timeout) {
            this.timeout = timeout;
        }

        public String getSslBundle() {
            return sslBundle;
        }

        public void setSslBundle(String sslBundle) {
            this.sslBundle = sslBundle == null || sslBundle.isBlank() ? null : sslBundle.strip();
        }

        public String getBearerToken() {
            return bearerToken;
        }

        public void setBearerToken(String bearerToken) {
            this.bearerToken = bearerToken;
        }

        public String getBasicUser() {
            return basicUser;
        }

        public void setBasicUser(String basicUser) {
            this.basicUser = basicUser;
        }

        public String getBasicPassword() {
            return basicPassword;
        }

        public void setBasicPassword(String basicPassword) {
            this.basicPassword = basicPassword;
        }
    }

    /** {@code datum.pdf.seal.*}: the seal every issued PDF gets. */
    public static class Seal {

        /** Whether issued PDFs are sealed with the server's key. */
        private boolean enabled;

        /** The layouts sealed; empty for every layout. */
        private List<String> layouts = new ArrayList<>();

        /** The certification: noChanges, formFill, annotate or none (DocMDP P=1, 2, 3, or an approval signature). */
        private String certify = "noChanges";

        /** Whether to ask a timestamp server for a token over the seal, when one is available. */
        private boolean timestamp = true;

        /** The signature's reason. */
        private String reason;

        /** The signature's location. */
        private String location;

        /** False for an invisible signature. */
        private Boolean visible;

        /**
         * Whether the PDFs of posted, unstored answers ({@code POST /pdf}, {@code /pdf/fill}, {@code /pdf/sign}) are sealed
         * with the server's key. Off: a throwaway test certificate seals them, so the server's key only ever says "this
         * server issued this" about documents the application itself issued.
         */
        private boolean postedAnswers;

        public boolean isEnabled() {
            return enabled;
        }

        public void setEnabled(boolean enabled) {
            this.enabled = enabled;
        }

        public List<String> getLayouts() {
            return layouts;
        }

        public void setLayouts(List<String> layouts) {
            this.layouts = layouts == null ? new ArrayList<>() : layouts;
        }

        public String getCertify() {
            return certify;
        }

        public void setCertify(String certify) {
            this.certify = certify;
        }

        public boolean isTimestamp() {
            return timestamp;
        }

        public void setTimestamp(boolean timestamp) {
            this.timestamp = timestamp;
        }

        public String getReason() {
            return reason;
        }

        public void setReason(String reason) {
            this.reason = reason;
        }

        public String getLocation() {
            return location;
        }

        public void setLocation(String location) {
            this.location = location;
        }

        public Boolean getVisible() {
            return visible;
        }

        public boolean isPostedAnswers() {
            return postedAnswers;
        }

        public void setPostedAnswers(boolean postedAnswers) {
            this.postedAnswers = postedAnswers;
        }

        public void setVisible(Boolean visible) {
            this.visible = visible;
        }
    }
}
