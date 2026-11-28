package com.argusvane.datum.forms.datasource;

import com.argusvane.datum.core.contracts.OptionItem;
import com.argusvane.datum.forms.DataSourceNotFoundException;
import java.security.Principal;
import java.util.List;
import java.util.Objects;

/**
 * Several {@link DataSourceProvider}s asked in turn: separate modules (countries, products,
 * a tenant directory) each contribute a provider, and a source id belongs to the first provider, in the order given,
 * whose {@link DataSourceProvider#exists} says it has it. This is the strategy-collected-in-order shape of Spring's
 * argument-resolver composites, written so an application does not need its own dispatcher.
 *
 * <p>{@code exists} is what makes the order safe: each provider says which ids it owns, so a provider answers only for
 * those. The composite is not a bean of its own: the binding builds it from the beans in the application's order when
 * there are two or more, and uses a single bean alone.
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
     * The provider to use for these: none for an empty list, the one itself for a single provider, a composite in the
     * given order for several.
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
}
