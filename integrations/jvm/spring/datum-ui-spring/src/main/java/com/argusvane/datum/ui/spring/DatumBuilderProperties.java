package com.argusvane.datum.ui.spring;

import com.argusvane.datum.ui.UiSettings;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.util.unit.DataSize;

/**
 * {@code datum.builder.*}: whether this application is a place where forms are authored.
 *
 * <p>Off by default. A visitor-facing site serves the form bundle only; the builder bundle (about 1.4 MB plus its
 * chunks and fonts) and the write endpoints exist when {@code datum.builder.enabled=true}.
 *
 * <p>The Spring binding of {@link UiSettings}: the asset gate and the write endpoints read the one
 * {@code UiSettings} bean made from these properties, so they cannot disagree about the switch.
 */
@ConfigurationProperties(prefix = "datum.builder")
public class DatumBuilderProperties {

    /** These properties as the library's settings; a test holds the defaults equal. */
    public UiSettings toSettings() {
        return new UiSettings(enabled, maxDefinitionSize.toBytes());
    }

    /** Serve the builder bundle and register the form write endpoints. */
    private boolean enabled = false;

    /** The largest definition a save reads; counted on the raw stream before parsing (413 over it). From 1 B to 64 MB. */
    private DataSize maxDefinitionSize = DataSize.ofMegabytes(1);

    public boolean isEnabled() {
        return enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    public DataSize getMaxDefinitionSize() {
        return maxDefinitionSize;
    }

    public void setMaxDefinitionSize(DataSize maxDefinitionSize) {
        this.maxDefinitionSize = maxDefinitionSize == null ? DataSize.ofMegabytes(1) : maxDefinitionSize;
    }
}
