package com.argusvane.datum.core.contracts;

import java.util.Map;
import tools.jackson.core.JsonParser;
import tools.jackson.databind.DeserializationContext;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ValueDeserializer;
import tools.jackson.databind.annotation.JsonDeserialize;

/**
 * The PDF program's reply (PdfKernelResponse): {@code ok: false} is a {@link PdfFailure}; {@code ok: true}
 * is the record of its {@code op}. Chosen by the deserializer, since a failure carries no op.
 */
@JsonDeserialize(using = PdfResponse.Reader.class)
public sealed interface PdfResponse permits PdfCapabilitiesResponse, PdfDocumentResponse, PdfRenderResponse,
    PdfBuildResponse, PdfLayoutResponse, PdfFillResponse, PdfInspectResponse, PdfSignResponse, PdfCompleteResponse,
    PdfTimestampRequestResponse, PdfVerifyResponse, PdfFailure {

    /** Whether the kernel answered the op. */
    boolean ok();

    /** Picks the record by {@code ok} and {@code op}. */
    final class Reader extends ValueDeserializer<PdfResponse> {
        private static final Map<String, Class<? extends PdfResponse>> BY_OP = Map.ofEntries(
            Map.entry("capabilities", PdfCapabilitiesResponse.class),
            Map.entry("document", PdfDocumentResponse.class),
            Map.entry("render", PdfRenderResponse.class),
            Map.entry("build", PdfBuildResponse.class),
            Map.entry("layout", PdfLayoutResponse.class),
            Map.entry("fill", PdfFillResponse.class),
            Map.entry("inspect", PdfInspectResponse.class),
            Map.entry("sign", PdfSignResponse.class),
            Map.entry("complete", PdfCompleteResponse.class),
            Map.entry("timestampRequest", PdfTimestampRequestResponse.class),
            Map.entry("verify", PdfVerifyResponse.class));

        @Override
        public PdfResponse deserialize(JsonParser p, DeserializationContext ctxt) {
            JsonNode node = ctxt.readTree(p);
            if (!node.path("ok").asBoolean(false)) {
                return ctxt.readTreeAsValue(node, PdfFailure.class);
            }
            Class<? extends PdfResponse> type = BY_OP.get(node.path("op").asString(""));
            if (type == null) {
                return (PdfResponse) ctxt.handleUnexpectedToken(PdfResponse.class, p);
            }
            return ctxt.readTreeAsValue(node, type);
        }
    }
}
