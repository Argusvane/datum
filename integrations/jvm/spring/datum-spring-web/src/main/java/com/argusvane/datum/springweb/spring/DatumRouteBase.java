package com.argusvane.datum.springweb.spring;

import com.argusvane.datum.web.openapi.DatumEndpointCatalog.Base;
import java.util.Objects;

/**
 * Where a capability binding outside this module mapped its routes: the timestamp server's base and the
 * passkeys' base, each contributed as a bean by the binding that maps them, from its own routes bean (and so from its
 * settings bean, which an application may replace). {@code DatumRequestMatchers} and
 * {@code DatumExchangeMatchers} are built from these, so an application's security rule covers the routes that are
 * actually mapped, wherever an overridden {@code TsaSettings} or {@code PasskeySettings} bean put them; reading
 * {@code datum.tsa.path} and {@code datum.webauthn.path} from the environment instead left such a rule on the old path
 * and the routes fell through to the chain's {@code anyRequest()}.
 *
 * <p>Only {@link Base#TSA} and {@link Base#WEBAUTHN}: the API base is the {@code WebSettings} bean's, which this module
 * owns, and a contribution naming it stops the start (the auto-configuration says so; a binding class builds no
 * refusal). Without a contribution (the capability is off or absent) the property is read, as before, so a matcher
 * still names the configured path.
 *
 * <p>{@code open} is what the start-up security WARN judges: whether the binding serves
 * these routes to anyone on purpose, as the timestamp server does with {@code TsaSettings.access() == OPEN}, so they need
 * no chain. It is the settings bean's too, not {@code datum.tsa.access}'s, which an application's bean may contradict.
 *
 * @param base the base the routes sit under
 * @param path the base path the binding mapped, as its routes bean holds it
 * @param open whether the binding serves the routes to anyone on purpose (they then need no security chain)
 */
public record DatumRouteBase(Base base, String path, boolean open) {

    public DatumRouteBase {
        Objects.requireNonNull(base, "base");
        Objects.requireNonNull(path, "path");
    }

    /** Routes that need securing: the passkeys' always, the timestamp server's in client mode. */
    public DatumRouteBase(Base base, String path) {
        this(base, path, false);
    }
}
