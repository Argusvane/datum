package com.argusvane.datum.springweb.spring;

import com.argusvane.datum.web.assets.DatumAssets;
import com.argusvane.datum.web.monitoring.DatumCapabilities;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.boot.actuate.info.Info;
import org.springframework.boot.actuate.info.InfoContributor;

/** {@code info.datum}: engineVersion, the ABIs, buildId, the capabilities present and what they added. */
public final class DatumInfoContributor implements InfoContributor {

    private final DatumAssets assets;
    private final DatumCapabilities capabilities;

    public DatumInfoContributor(DatumAssets assets, DatumCapabilities capabilities) {
        this.assets = assets;
        this.capabilities = capabilities;
    }

    @Override
    public void contribute(Info.Builder builder) {
        Map<String, Object> datum = new LinkedHashMap<>();
        datum.put("engineVersion", assets.manifest().engineVersion());
        datum.put("sandboxAbi", assets.manifest().sandboxAbi());
        datum.put("pdfAbi", assets.manifest().pdfAbi());
        datum.put("buildId", assets.buildId());
        datum.put("capabilities", capabilities.present());
        datum.putAll(capabilities.details());
        builder.withDetail("datum", datum);
    }
}
