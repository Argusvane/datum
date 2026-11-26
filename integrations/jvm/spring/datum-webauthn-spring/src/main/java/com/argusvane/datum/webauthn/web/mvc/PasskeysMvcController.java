package com.argusvane.datum.webauthn.web.mvc;

import com.argusvane.datum.springweb.mvc.DatumController;
import com.argusvane.datum.springweb.mvc.MvcBodies;
import com.argusvane.datum.webauthn.web.PasskeysApi;
import com.argusvane.datum.webauthn.web.PasskeysReply;
import com.argusvane.datum.webauthn.web.PasskeysRequest;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.enums.ParameterIn;
import io.swagger.v3.oas.annotations.headers.Header;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.parameters.RequestBody;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.tags.Tag;
import com.argusvane.datum.springweb.mvc.MvcRequestViews;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * The passkey endpoints on Spring MVC. Registered only when {@code datum.webauthn.enabled=true}; the paths come
 * from {@code PasskeysRoutes} through SpEL, so {@code datum.webauthn.path} applies to both stacks alike. Bodies
 * are read raw (415, then the 64 KiB cap counted on the stream) and every decision is {@link PasskeysApi}'s: this
 * class only moves bytes. CSRF is the application's Spring Security configuration (the glue sends the header).
 */
@RestController
@DatumController
@Tag(name = "datum-webauthn", description = "Passkeys: registration, the caller's own passkeys and a self-test.")
@RequestMapping("#{@datumWebAuthnRoutes.path()}")
public class PasskeysMvcController {

    private static final String ERRORS = "#/components/schemas/ErrorsBody";

    private final PasskeysApi api;

    public PasskeysMvcController(PasskeysApi api) {
        this.api = api;
    }

    @PostMapping("challenge")
    @Operation(operationId = "passkeyChallenge", summary = "A passkey registration challenge",
        description = "{context: submit|amend|test, form?, label?}. With a form key: a passkey made at that form (the form must sign); without: "
            + "a passkey a signed-in person adds ahead of time. The answer is what the engine's registerCredential() reads: {challenge, token, "
            + "expires, rp, user, userVerification, residentKey, excludeCredentials, pubKeyCredParams, attestation}.",
        requestBody = @RequestBody(required = true, content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
        responses = {
            @ApiResponse(responseCode = "200", description = "The options.", content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
            @ApiResponse(responseCode = "403", description = "Refused (signing.sign_in, signing.context, signing.register_off; access.denied by the application's security with DatumSecurityResponses).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
            @ApiResponse(responseCode = "404", description = "No such form, or it does not sign (signing.off).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
            @ApiResponse(responseCode = "429", description = "Too many requests (flood).", headers = @Header(name = "Retry-After", ref = "#/components/headers/RetryAfter"),
                content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
            @ApiResponse(responseCode = "503", description = "Passkeys are not set up (signing.not_set_up).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS)))})
    public ResponseEntity<byte[]> challenge(HttpServletRequest request) {
        PasskeysRequest view = view(request);
        // 415, then the address limit, before a byte of the body is read: a body that never parses is counted too.
        api.admit(view);
        byte[] body = MvcBodies.readJsonBytes(request, api.maxBodyBytes());
        return entity(api.challenge(body, view));
    }

    @PostMapping("register")
    @Operation(operationId = "passkeyRegister", summary = "Verify and store a passkey the browser created",
        description = "{token, label?, context, form?, credential: {id, publicKey, algorithm, transports, userHandle, response}}: what the engine's "
            + "registerCredential() returned. Answers 201 with {id, transports, algorithm, publicKey, label, createdAt}.",
        requestBody = @RequestBody(required = true, content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
        responses = {
            @ApiResponse(responseCode = "201", description = "The stored passkey.", content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
            @ApiResponse(responseCode = "400", description = "The body could not be read, or the challenge expired or was used (passkey.bad_request, passkey.challenge).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
            @ApiResponse(responseCode = "403", description = "Refused (signing.*; access.denied by the application's security with DatumSecurityResponses).",
                content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
            @ApiResponse(responseCode = "404", description = "No such form, or it does not sign.", content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
            @ApiResponse(responseCode = "409", description = "Registered already (passkey.exists).", content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
            @ApiResponse(responseCode = "422", description = "A WebAuthn check failed (passkey.invalid).", content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
            @ApiResponse(responseCode = "429", description = "Too many requests (flood).", headers = @Header(name = "Retry-After", ref = "#/components/headers/RetryAfter"),
                content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
            @ApiResponse(responseCode = "503", description = "Passkeys are not set up (signing.not_set_up).", content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS)))})
    public ResponseEntity<byte[]> register(HttpServletRequest request) {
        PasskeysRequest view = view(request);
        // 415, then the address limit, before a byte of the body is read: a body that never parses is counted too.
        api.admit(view);
        byte[] body = MvcBodies.readJsonBytes(request, api.maxBodyBytes());
        return entity(api.register(body, view));
    }

    @GetMapping("passkeys")
    @Operation(operationId = "listPasskeys", summary = "The caller's passkeys",
        description = "With form: the passkeys the page offers the browser, and a signing block of what the page needs. Without: the caller's list. "
            + "An anonymous caller has none.",
        parameters = @Parameter(name = "form", in = ParameterIn.QUERY, description = "A form key.", schema = @Schema(type = "string")),
        responses = {
            @ApiResponse(responseCode = "200", description = "{passkeys: [...], signing?}.", content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
            @ApiResponse(responseCode = "403", description = "Refused by the application's security (access.denied when it installs DatumSecurityResponses).", content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
            @ApiResponse(responseCode = "404", description = "No such form, or it does not sign.", content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS)))})
    public ResponseEntity<byte[]> mine(@RequestParam(name = "form", required = false) String form, HttpServletRequest request) {
        return entity(api.mine(form, view(request)));
    }

    @DeleteMapping("passkeys/{id}")
    @Operation(operationId = "removePasskey", summary = "Revoke and remove a passkey",
        description = "The owner removes a passkey by its credential id. It is revoked, then deleted unless a stored "
            + "submission names it (then it is kept, its label cleared).",
        responses = {
            @ApiResponse(responseCode = "200", description = "{id, status: deleted|removed}.", content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
            @ApiResponse(responseCode = "404", description = "No such passkey (passkey.notFound), or not the caller's.", content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS)))})
    public ResponseEntity<byte[]> remove(@PathVariable("id") String id, HttpServletRequest request) {
        return entity(api.revoke(id, view(request)));
    }

    @PostMapping("passkeys/{id}/check-challenge")
    @Operation(operationId = "passkeyCheckChallenge", summary = "A challenge to test one of the caller's passkeys",
        description = "Answers {challenge, token, expires, rpId, allowCredentials, userVerification} for a get() ceremony. Nothing is signed.",
        responses = {
            @ApiResponse(responseCode = "200", description = "The options.", content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
            @ApiResponse(responseCode = "404", description = "No such passkey of the caller's.", content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
            @ApiResponse(responseCode = "409", description = "The passkey was revoked (passkey.revoked).", content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
            @ApiResponse(responseCode = "429", description = "Too many requests (flood).", headers = @Header(name = "Retry-After", ref = "#/components/headers/RetryAfter"),
                content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
            @ApiResponse(responseCode = "503", description = "Passkeys are not set up (signing.not_set_up).", content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS)))})
    public ResponseEntity<byte[]> checkChallenge(@PathVariable("id") String id, HttpServletRequest request) {
        return entity(api.checkChallenge(id, view(request)));
    }

    @PostMapping("passkeys/{id}/check")
    @Operation(operationId = "passkeyCheck", summary = "Check the assertion a passkey test made",
        description = "{token, assertion}. 200 {ok, lastUsed}; 422 passkey.check when it does not verify, passkey.counter when the counter did not go up.",
        requestBody = @RequestBody(required = true, content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
        responses = {
            @ApiResponse(responseCode = "200", description = "It verifies.", content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
            @ApiResponse(responseCode = "400", description = "The body could not be read, or the challenge expired or was used.", content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
            @ApiResponse(responseCode = "404", description = "No such passkey of the caller's.", content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
            @ApiResponse(responseCode = "409", description = "The passkey was revoked.", content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
            @ApiResponse(responseCode = "422", description = "It does not verify, or the counter did not go up.", content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
            @ApiResponse(responseCode = "503", description = "Passkeys are not set up (signing.not_set_up).", content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS)))})
    public ResponseEntity<byte[]> check(@PathVariable("id") String id, HttpServletRequest request) {
        byte[] body = MvcBodies.readJsonBytes(request, api.maxBodyBytes());
        return entity(api.check(id, body, view(request)));
    }

    private static PasskeysRequest view(HttpServletRequest request) {
        return new PasskeysRequest(request.getContentType(), MvcRequestViews.headers(request), MvcRequestViews.remoteAddress(request),
            MvcRequestViews.principal(request));
    }

    private static ResponseEntity<byte[]> entity(PasskeysReply reply) {
        ResponseEntity.BodyBuilder builder = ResponseEntity.status(reply.status());
        reply.headers().forEach(builder::header);
        return builder.contentType(MediaType.parseMediaType(PasskeysApi.contentType())).body(reply.body());
    }
}
