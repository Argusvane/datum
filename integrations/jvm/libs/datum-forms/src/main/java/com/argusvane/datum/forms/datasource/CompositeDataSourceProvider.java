package com.argusvane.datum.forms.datasource;

import com.argusvane.datum.core.DatumStartupCheck;
import com.argusvane.datum.core.contracts.OptionItem;
import com.argusvane.datum.forms.DataSourceNotFoundException;
import java.security.Principal;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

/**
 * Several {@link DataSourceProvider}s asked in turn: separate modules (countries, products,
 * a tenant directory) each contribute a provider, and a source id belongs to the first provider, in the order given,
 * whose {@link DataSourceProvider#exists} says it has it. This is the strategy-collected-in-order shape of Spring's
 * argument-resolver composites, written so an application does not need its own dispatcher.
 *
 * <p>{@code exists} is what makes the order safe, and its default answers true for every id. A provider that does not
 * override it would answer every id before the ones after it were asked, so with several providers each one must
 * override {@code exists}; {@link #startupCheck} names any that do not. The composite is not a bean of its own: the
 * binding builds it from the beans in the application's order when there are two or more, and uses a single bean as it
 * always did.
 */
public final class CompositeDataSourceProvider implements DataSourceProvider {

    private final List<DataSourceProvider> providers;

    public CompositeDataSourceProvider(List<? extends DataSourceProvider> providers) {
        Objects.requireNonNull(providers, "providers");
        this.providers = List.copyOf(providers);
        if (this.providers.isEmpty()) {
            throw new IllegalArgumentException("A composite needs at least one DataSourceProvider.");
        }
    }

    /**
     * The provider to use for these: none for an empty list, the one itself for a single provider (exactly as before),
     * a composite in the given order for several.
     */
    public static DataSourceProvider of(List<? extends DataSourceProvider> providers) {
        if (providers.isEmpty()) {
            return null;
        }
        if (providers.size() == 1) {
            return providers.get(0);
        }
        return new CompositeDataSourceProvider(providers);
    }

    /** The providers, in the order they are asked. */
    public List<DataSourceProvider> providers() {
        return providers;
    }

    @Override
    public List<OptionItem> items(String id, String locale, Principal principal) {
        return owner(id).items(id, locale, principal);
    }

    @Override
    public boolean exists(String id) {
        for (DataSourceProvider provider : providers) {
            if (provider.exists(id)) {
                return true;
            }
        }
        return false;
    }

    @Override
    public boolean validatesAnswers(String id) {
        return providers.stream().filter(provider -> provider.exists(id)).findFirst().map(provider -> provider.validatesAnswers(id)).orElse(true);
    }

    @Override
    public List<String> allowed(String id, List<String> candidates, String locale, Principal principal) {
        return owner(id).allowed(id, candidates, locale, principal);
    }

    private DataSourceProvider owner(String id) {
        for (DataSourceProvider provider : providers) {
            if (provider.exists(id)) {
                return provider;
            }
        }
        throw new DataSourceNotFoundException(id);
    }

    /** Providers that keep the default {@code exists} (true for every id) and so would shadow the ones after them. */
    public List<DataSourceProvider> withoutExists() {
        List<DataSourceProvider> out = new ArrayList<>();
        for (DataSourceProvider provider : providers) {
            if (!overridesExists(provider)) {
                out.add(provider);
            }
        }
        return out;
    }

    /**
     * One WARN per provider whose {@code exists} is the default: with several providers it would answer every id and
     * the providers after it would never be asked. A proxy or a subclass that overrides {@code exists} to delegate is not
     * seen as the default, so the check can miss a decorated provider but never blames a correct one.
     */
    public DatumStartupCheck startupCheck() {
        return () -> withoutExists().stream().map(provider -> DatumStartupCheck.Notice.warn(CompositeDataSourceProvider.class,
            provider.getClass().getName() + " is one of " + providers.size() + " DataSourceProvider beans but does not override exists(id), "
                + "which answers true for every source id: it would be asked first and answer for all of them, and the providers after it "
                + "would never be asked. Override exists(id) to say which source ids it owns.")).toList();
    }

    private static boolean overridesExists(DataSourceProvider provider) {
        try {
            return provider.getClass().getMethod("exists", String.class).getDeclaringClass() != DataSourceProvider.class;
        } catch (NoSuchMethodException e) {
            return false;
        }
    }
}
