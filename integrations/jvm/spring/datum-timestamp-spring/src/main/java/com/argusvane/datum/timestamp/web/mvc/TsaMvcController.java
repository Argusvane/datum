package com.argusvane.datum.timestamp.web.mvc;

import com.argusvane.datum.springweb.mvc.DatumController;
import com.argusvane.datum.timestamp.TsaClient;
import com.argusvane.datum.timestamp.web.TsaEndpoint;
import com.argusvane.datum.timestamp.web.TsaHttpReply;
import com.argusvane.datum.timestamp.web.TsaRequest;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.enums.ParameterIn;
import io.swagger.v3.oas.annotations.headers.Header;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.parameters.RequestBody;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.ArrayList;
import java.util.List;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * The timestamp server on Spring MVC: {@code POST {datum.tsa.path}} and the two certificate reads. The request
 * is read raw (a TimeStampReq is DER, not JSON) and every decision is {@link TsaEndpoint}'s, so this class only
 * moves bytes. The paths come from {@code TsaRoutes} through SpEL, so {@code datum.tsa.path} applies to both
 * stacks alike. Registered only when {@code datum.tsa.enabled=true}: switched off it has no mapping, and the
 * path is 404.
 */
@RestController
@DatumController
@Tag(name = "datum-tsa", description = "An RFC 3161 timestamp server and its published certificates.")
public class TsaMvcController {

    private final TsaEndpoint endpoint;

    public TsaMvcController(TsaEndpoint endpoint) {
        this.endpoint = endpoint;
    }

    @PostMapping("#{@datumTsaRoutes.path()}")
    @Operation(operationId = "issueTimestamp", summary = "Issue an RFC 3161 timestamp token",
        description = "Takes a TimeStampReq (DER) and answers a TimeStampResp (DER): 200 with a token, 400 when the request is refused and 503 "
            + "when the server cannot issue one; both carry a PKIFailureInfo and a statusString. A client key is sent as a bearer token or as "
            + "the password of HTTP Basic authentication.",
        requestBody = @RequestBody(required = true, description = "A TimeStampReq, DER.",
            content = @Content(mediaType = "application/timestamp-query", schema = @Schema(type = "string", format = "binary"))),
        responses = {
            @ApiResponse(responseCode = "200", description = "A TimeStampResp with a granted token.",
                content = @Content(mediaType = "application/timestamp-reply", schema = @Schema(type = "string", format = "binary"))),
            @ApiResponse(responseCode = "400", description = "A TimeStampResp with status rejection (the request is at fault).",
                content = @Content(mediaType = "application/timestamp-reply", schema = @Schema(type = "string", format = "binary"))),
            @ApiResponse(responseCode = "401", description = "A client key is needed (text/plain); WWW-Authenticate names Bearer and Basic.",
                headers = @Header(name = "WWW-Authenticate"),
                content = @Content(mediaType = "text/plain", schema = @Schema(type = "string"))),
            @ApiResponse(responseCode = "403", description = "The request carries a browser session cookie (text/plain).",
                content = @Content(mediaType = "text/plain", schema = @Schema(type = "string"))),
            @ApiResponse(responseCode = "413", description = "The request is larger than datum.tsa.max-request-size (text/plain).",
                content = @Content(mediaType = "text/plain", schema = @Schema(type = "string"))),
            @ApiResponse(responseCode = "415", description = "The Content-Type is not application/timestamp-query (text/plain).",
                content = @Content(mediaType = "text/plain", schema = @Schema(type = "string"))),
            @ApiResponse(responseCode = "429", description = "Too many requests, or too many wrong keys from this address (text/plain).",
                headers = @Header(name = "Retry-After", ref = "#/components/headers/RetryAfter"),
                content = @Content(mediaType = "text/plain", schema = @Schema(type = "string"))),
            @ApiResponse(responseCode = "503", description = "A TimeStampResp: the server cannot issue a token now.",
                content = @Content(mediaType = "application/timestamp-reply", schema = @Schema(type = "string", format = "binary")))})
    public ResponseEntity<byte[]> issue(HttpServletRequest request) {
        List<String> cookies = new ArrayList<>();
        if (request.getCookies() != null) {
            for (Cookie cookie : request.getCookies()) {
                cookies.add(cookie.getName());
            }
        }
        TsaEndpoint.Admission admission = endpoint.admit(new TsaRequest(request.getContentType(), request.getHeader("Authorization"),
            cookies, request.getRemoteAddr(), request.getContentLengthLong()));
        if (!admission.admitted()) {
            return entity(admission.refusal());
        }
        byte[] body;
        try {
            body = request.getInputStream().readNBytes((int) Math.min(Integer.MAX_VALUE - 8, endpoint.maxBody() + 1));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        TsaClient client = admission.client();
        return entity(endpoint.issue(body, client));
    }

    @GetMapping("#{@datumTsaRoutes.certificatePath()}")
    @Operation(operationId = "getTimestampCertificate", summary = "The certificate tokens are signed with now",
        description = "The chain as PEM, the server's own certificate first; format=der answers that certificate alone. Public: a verifier needs it.",
        parameters = @Parameter(name = "format", in = ParameterIn.QUERY, description = "der for the server's certificate alone.",
            schema = @Schema(type = "string", allowableValues = "der")),
        responses = {
            @ApiResponse(responseCode = "200", description = "The certificate.", content = {
                @Content(mediaType = "application/pem-certificate-chain", schema = @Schema(type = "string")),
                @Content(mediaType = "application/pkix-cert", schema = @Schema(type = "string", format = "binary"))}),
            @ApiResponse(responseCode = "503", description = "The server has no certificate it can use (text/plain).",
                content = @Content(mediaType = "text/plain", schema = @Schema(type = "string")))})
    public ResponseEntity<byte[]> certificate(@RequestParam(name = "format", required = false) String format) {
        return entity(endpoint.certificate(format));
    }

    @GetMapping("#{@datumTsaRoutes.certificatesPath()}")
    @Operation(operationId = "getTimestampCertificates", summary = "Every certificate the server has signed with",
        description = "The one in use first, then the retired ones, each chain as PEM after comment lines naming it. Public.",
        responses = {
            @ApiResponse(responseCode = "200", description = "The certificates.",
                content = @Content(mediaType = "application/x-pem-file", schema = @Schema(type = "string"))),
            @ApiResponse(responseCode = "503", description = "The server has no certificate (text/plain).",
                content = @Content(mediaType = "text/plain", schema = @Schema(type = "string")))})
    public ResponseEntity<byte[]> certificates() {
        return entity(endpoint.certificates());
    }

    private static ResponseEntity<byte[]> entity(TsaHttpReply reply) {
        ResponseEntity.BodyBuilder builder = ResponseEntity.status(reply.status());
        reply.headers().forEach(builder::header);
        return builder.contentType(MediaType.parseMediaType(reply.contentType())).body(reply.body());
    }
}
