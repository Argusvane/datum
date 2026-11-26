package com.argusvane.datum.core.contracts;

import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import tools.jackson.databind.JsonNode;

/**
 * document op: build the document and render or fill it in one call.
 *
 * <p>Members the Java side does not name are kept in {@code extra} and written back, so a newer
 * program's additions round-trip (the TypeScript type is open).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record PdfDocumentRequest(
    String abi,
    List<PdfFont> fonts,
    PdfEnv env,
    PdfRenderOptions options,
    PdfTemplateBytes template,
    PdfSignatureSpec signature,
    JsonNode form,
    JsonNode layout,
    JsonNode pdf,
    String layoutId,
    JsonNode values,
    String locale,
    JsonNode translations,
    JsonNode formTranslations,
    Map<String,List<OptionItem>> optionSnapshot,
    JsonNode effectiveStates,
    JsonNode theme,
    JsonNode title,
    JsonNode hostContext,
    String unknownComponents,
    JsonNode attachments,
    String today,
    String formulaErrors,
    String riskyPatterns,
    @JsonAnySetter @JsonAnyGetter Map<String, JsonNode> extra
) implements PdfRequest {

    public PdfDocumentRequest {
        extra = extra == null ? new LinkedHashMap<>() : new LinkedHashMap<>(extra);
    }
}
