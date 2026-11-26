package com.argusvane.datum.webauthn.web;

import java.security.Principal;
import java.util.function.Predicate;

/**
 * Who may make a passkey in a form's Test context: the one-method rule the facade asks, as a
 * type a binding can publish as a bean. An application with another rule (an OIDC group claim, a tenant check) declares
 * one bean of this type instead of replacing the whole {@link PasskeysApi}. The default in the Spring binding is the
 * exact match on {@code datum.webauthn.test-roles}, deliberately not following a role hierarchy: this check gates who may
 * mint test passkeys, so it admits only the roles named. A rule that throws names nobody (the facade fails closed).
 */
@FunctionalInterface
public interface PasskeyTesters extends Predicate<Principal> {

    /** Nobody: the answer when no role is named. */
    PasskeyTesters NOBODY = principal -> false;

    /** Whether this caller may make a passkey in the Test context. */
    @Override
    boolean test(Principal principal);
}
