package com.argusvane.datum.webauthn;

import java.util.List;

/**
 * What the browser needs to create a passkey (the challenge answer of endpoint catalog {@code passkeyChallenge}, plus
 * {@code pubKeyCredParams} and {@code attestation}): the engine's {@code registerCredential()} reads these names.
 *
 * @param challenge the challenge, base64url
 * @param token the token to post back with the registration
 * @param expires when the challenge stops holding (epoch seconds)
 * @param rp the relying party
 * @param user the user entity: its id is the random user handle (base64url), never the account id
 * @param userVerification required or preferred
 * @param residentKey "required": a passkey the browser can offer without being told which
 * @param excludeCredentials the owner's passkeys in the same scope, so a device is not registered twice
 * @param pubKeyCredParams the algorithms taken: ES256 then RS256
 * @param attestation "none": who made the authenticator is not asked
 */
public record RegistrationOptions(String challenge, String token, long expires, RelyingParty rp, User user, String userVerification,
                                  String residentKey, List<CredentialReference> excludeCredentials, List<CredentialParameter> pubKeyCredParams,
                                  String attestation) {

    public RegistrationOptions {
        excludeCredentials = List.copyOf(excludeCredentials);
        pubKeyCredParams = List.copyOf(pubKeyCredParams);
    }

    /** The relying party: the passkey domain and the site's name. */
    public record RelyingParty(String id, String name) {
    }

    /** The user entity of the passkey. */
    public record User(String id, String name, String displayName) {
    }

    /** A passkey as the browser names it: its credential id and transports. */
    public record CredentialReference(String id, List<String> transports) {

        public CredentialReference {
            transports = List.copyOf(transports);
        }
    }

    /** One algorithm taken. */
    public record CredentialParameter(String type, int alg) {
    }

    /** ES256 then RS256, the only two taken. */
    public static final List<CredentialParameter> ALGORITHMS = List.of(new CredentialParameter("public-key", CoseKey.ES256),
        new CredentialParameter("public-key", CoseKey.RS256));
}
