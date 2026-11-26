package com.argusvane.datum.core.contracts;

import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ValueDeserializer;
import tools.jackson.databind.annotation.JsonDeserialize;

/**
 * render reply.
 *
 * <p>Members the Java side does not name are kept in {@code extra} and written back, so a newer
 * program's additions round-trip (the TypeScript type is open).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonIgnoreProperties(value = {"ok", "op"}, allowGetters = true)
@JsonDeserialize(using = ValueDeserializer.None.class)
public record PdfRenderResponse(
    String bytes,
    Integer pageCount,
    List<PdfPageReport> pages,
    List<PdfWarning> warnings,
    List<PdfFillReport> fields,
    List<PdfAreaReport> areas,
    JsonNode pdfa,
    List<String> attachments,
    PdfSigningHandoff signing,
    @JsonAnySetter @JsonAnyGetter Map<String, JsonNode> extra
) implements PdfResponse {

    public PdfRenderResponse {
        extra = extra == null ? new LinkedHashMap<>() : new LinkedHashMap<>(extra);
    }

    /** Written as {@code ok}; read back from the wire and ignored. */
    @JsonProperty("ok")
    public boolean ok() {
        return true;
    }

    /** Written as {@code op}. */
    @JsonProperty("op")
    public String op() {
        return "render";
    }
}
