package com.argusvane.datum.webauthn;

import java.security.Principal;
import org.jspecify.annotations.Nullable;

/**
 * Who a request is, for passkeys: the application's principal as a {@link PasskeySubject}. The Spring
 * auto-configuration supplies one over Spring Security when it is present; {@link #byPrincipalName()} reads the
 * plain {@link Principal}.
 */
@FunctionalInterface
public interface PasskeySubjectResolver {

    /** The subject; {@link PasskeySubject#anonymous()} for a request with no principal. Never null. */
    PasskeySubject resolve(@Nullable Principal principal);

    /** The principal's name as its id, name and display name; anonymous without one. */
    static PasskeySubjectResolver byPrincipalName() {
        return principal -> principal == null || principal.getName() == null || principal.getName().isEmpty()
            ? PasskeySubject.anonymous()
            : new PasskeySubject(principal.getName(), principal.getName(), principal.getName());
    }
}
