package com.argusvane.datum.pdf.spring;

import com.argusvane.datum.pdf.config.PdfSettings;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.util.unit.DataSize;

/**
 * {@code datum.runtime.verify-max-bytes}: the largest PDF the verify route reads (413 over it). The key sits under
 * {@code datum.runtime} because the FastAPI host and the docs share that vocabulary, but the route is PDF's, so this binding
 * reads it and {@link PdfSettings#clampVerifyMaxBytes} bounds it (1 MiB to 100 MiB, a WARN when it is moved); the rest of
 * {@code datum.runtime.*} is datum-sandbox-spring's. The route is off unless {@code datum.web.api.endpoints.verify} is true.
 */
@ConfigurationProperties(prefix = "datum.runtime")
public class DatumPdfVerifyProperties {

    /**
     * The largest PDF the verify route reads (413 over it); 20 MB unless set. 1 MB to 100 MB; outside that it is clamped with a
     * WARN. The route is off unless {@code datum.web.api.endpoints.verify} is true.
     */
    private DataSize verifyMaxBytes = DataSize.ofMegabytes(20);

    /** Whether the application set the property; only then does it win over a PdfSettings bean's own cap. */
    private boolean configured;

    public DataSize getVerifyMaxBytes() {
        return verifyMaxBytes;
    }

    public void setVerifyMaxBytes(DataSize verifyMaxBytes) {
        this.verifyMaxBytes = verifyMaxBytes;
        this.configured = true;
    }

    /** Whether {@code datum.runtime.verify-max-bytes} was set by the application (the binder calls the setter only then). */
    public boolean wasSet() {
        return configured;
    }

    /** The cap in force: the property clamped to its bounds (the default when it was not set). Logs a WARN when it is moved. */
    public long toBytes() {
        return PdfSettings.clampVerifyMaxBytes(configured && verifyMaxBytes != null ? Long.valueOf(verifyMaxBytes.toBytes()) : null);
    }
}
