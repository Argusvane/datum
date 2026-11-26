package com.argusvane.datum.webauthn.spring;

import java.security.Principal;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Predicate;
import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;

/**
 * Who may make a passkey in a form's Test context ({@code PasskeysApi.Options#testers}), from Spring Security: an
 * authenticated, non-anonymous {@link Authentication} holding one of {@code datum.webauthn.test-roles} (a role given
 * as {@code FORM_ADMIN} matches the authority {@code ROLE_FORM_ADMIN} or {@code FORM_ADMIN}, as Spring Security's
 * {@code hasRole} and {@code hasAuthority} read it; the prefix is the application's {@code GrantedAuthorityDefaults}
 * when it defines one, {@code ROLE_} otherwise). The route itself is the
 * application's security, but the context is in the body, where no request matcher can see it, and the Test context
 * is the one way to make a passkey at a form while {@code register-at-submit} is off, so it stays closed to everyone
 * the application has not named (a {@code canTest} policy with a permit-all default would leave it open).
 */
public final class SecurityRoleTesters implements Predicate<Principal> {

    private final Set<String> authorities = new LinkedHashSet<>();

    /** With Spring Security's default role prefix, {@code ROLE_}. */
    public SecurityRoleTesters(List<String> roles) {
        this(roles, "ROLE_");
    }

    /**
     * @param rolePrefix what the application's {@code GrantedAuthorityDefaults} says ({@code ""} for none), so a role named
     *     {@code FORM_ADMIN} matches the authority the application's own {@code hasRole} would
     */
    public SecurityRoleTesters(List<String> roles, String rolePrefix) {
        String prefix = rolePrefix == null ? "" : rolePrefix;
        for (String role : roles) {
            String clean = role == null ? "" : role.strip();
            if (!clean.isEmpty()) {
                authorities.add(clean);
                authorities.add(clean.startsWith(prefix) ? clean : prefix + clean);
            }
        }
    }

    @Override
    public boolean test(Principal principal) {
        if (!(principal instanceof Authentication authentication) || authentication instanceof AnonymousAuthenticationToken
            || !authentication.isAuthenticated()) {
            return false;
        }
        for (GrantedAuthority authority : authentication.getAuthorities()) {
            if (authority != null && authorities.contains(authority.getAuthority())) {
                return true;
            }
        }
        return false;
    }
}
