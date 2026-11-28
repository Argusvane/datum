package com.argusvane.datum.core.contracts;

import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;

/**
 * The PDF program's request union (PdfKernelRequest): one record per {@code op}, the op written
 * as the type id so the wire shape is the TypeScript one.
 */
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "op")
@JsonSubTypes({
    @JsonSubTypes.Type(value = PdfCapabilitiesRequest.class, name = "capabilities"),
    @JsonSubTypes.Type(value = PdfDocumentRequest.class, name = "document"),
    @JsonSubTypes.Type(value = PdfBuildRequest.class, name = "build"),
    @JsonSubTypes.Type(value = PdfRenderRequest.class, name = "render"),
    @JsonSubTypes.Type(value = PdfLayoutRequest.class, name = "layout"),
    @JsonSubTypes.Type(value = PdfFillRequest.class, name = "fill"),
    @JsonSubTypes.Type(value = PdfInspectRequest.class, name = "inspect"),
    @JsonSubTypes.Type(value = PdfSignRequest.class, name = "sign"),
    @JsonSubTypes.Type(value = PdfCompleteRequest.class, name = "complete"),
    @JsonSubTypes.Type(value = PdfTimestampRequestRequest.class, name = "timestampRequest"),
    @JsonSubTypes.Type(value = PdfVerifyRequest.class, name = "verify")
})
public sealed interface PdfRequest permits PdfCapabilitiesRequest, PdfDocumentRequest, PdfBuildRequest,
    PdfRenderRequest, PdfLayoutRequest, PdfFillRequest, PdfInspectRequest, PdfSignRequest, PdfCompleteRequest,
    PdfTimestampRequestRequest, PdfVerifyRequest {

    /** The ABI version the host speaks (major-only compatible, see {@code pdfAbiCompatible}). */
    String abi();
}
