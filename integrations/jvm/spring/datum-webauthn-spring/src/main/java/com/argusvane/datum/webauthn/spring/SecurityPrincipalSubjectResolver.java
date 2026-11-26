package com.argusvane.datum.webauthn.spring;

import com.argusvane.datum.webauthn.PasskeySubject;
import com.argusvane.datum.webauthn.PasskeySubjectResolver;
import java.security.Principal;
import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.security.core.Authentication;

/**
 * Who a request is, from Spring Security: an authenticated {@link Authentication}'s name is the passkey owner's id
 * (stable for as long as the application's user names are), its name and display name. Anonymous and
 * unauthenticated tokens, and requests with no principal, are anonymous visitors, who may make passkeys only
 * with {@code datum.webauthn.anonymous=true}. A plain {@link Principal} that is not an {@code Authentication}
 * (a container-authenticated request) is read by its name.
 */
public final class SecurityPrincipalSubjectResolver implements PasskeySubjectResolver {

    @Override
    public PasskeySubject resolve(Principal principal) {
        if (principal == null) {
            return PasskeySubject.anonymous();
        }
        if (principal instanceof Authentication authentication
            && (authentication instanceof AnonymousAuthenticationToken || !authentication.isAuthenticated())) {
            return PasskeySubject.anonymous();
        }
        String name = principal.getName();
        return name == null || name.isEmpty() ? PasskeySubject.anonymous() : new PasskeySubject(name, name, name);
    }
}
