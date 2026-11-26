package com.argusvane.datum.sandbox.wasi;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.ServiceConfigurationError;
import java.util.ServiceLoader;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import org.jspecify.annotations.Nullable;

/**
 * Finds the engines on a class path ({@link ServiceLoader} over {@link GuestRuntimeProvider}) and selects one by id.
 * A host binding calls {@link #select} with the configured id and creates the runtime from the provider;
 * an application that supplies its own {@link GuestRuntime} needs neither.
 *
 * <p>Discovery never lets one bad entry hide the others: a provider class that cannot be loaded or constructed (a
 * {@link ServiceConfigurationError}, or a {@link LinkageError} such as a class file newer than this JVM, which Java 17's
 * lazy class-path iterator raises from {@code hasNext()}), or whose {@code id()} or {@code availability()} throws, is
 * kept as a broken entry with its reason and the walk goes on. Selection is strict: the id is compared trimmed and in
 * lower case, an unknown id names every id found, an unavailable engine names its reason, and two providers with one id
 * are refused rather than one picked by class-path order.
 */
public final class GuestRuntimes {

    /** The ids a provider may have. */
    private static final Pattern ID = Pattern.compile("[a-z0-9][a-z0-9-]{0,63}");

    /**
     * How many consecutive loading failures end the walk: a broken iterator must not spin. A good entry resets the
     * count, so broken entries spread through a long class path never hide an engine listed after them.
     */
    private static final int MAX_BROKEN = 64;

    private GuestRuntimes() {
    }

    /**
     * One entry of the class path's providers.
     *
     * @param id the provider's id, or null for an entry that could not be loaded or asked
     * @param providerClass the provider's class name, or what the loader said about the entry
     * @param availability whether it can run here; a broken entry is {@link GuestRuntimeProvider.Unavailable}
     * @param provider the provider itself, null for a broken entry
     */
    public record Found(@Nullable String id, String providerClass, GuestRuntimeProvider.Availability availability,
                        @Nullable GuestRuntimeProvider provider) {

        public Found {
            Objects.requireNonNull(providerClass, "providerClass");
            Objects.requireNonNull(availability, "availability");
        }

        /** Whether the entry is a usable provider with an id. */
        public boolean usable() {
            return id != null && provider != null;
        }

        /** How the entry reads in a message: {@code endive (available)}. */
        public String describe() {
            if (id == null) {
                return providerClass + " (could not be loaded: " + ((GuestRuntimeProvider.Unavailable) availability).reason() + ")";
            }
            return id + (availability.isAvailable() ? " (available)" : " (unavailable)");
        }
    }

    /** Every provider the loader's {@code META-INF/services} lists, in class-path order, broken entries included. */
    public static List<Found> discover(ClassLoader loader) {
        List<Found> found = new ArrayList<>();
        Iterator<GuestRuntimeProvider> providers = ServiceLoader.load(GuestRuntimeProvider.class, loader).iterator();
        int broken = 0;
        while (broken < MAX_BROKEN) {
            GuestRuntimeProvider provider;
            try {
                if (!providers.hasNext()) {
                    break;
                }
                provider = providers.next();
            } catch (ServiceConfigurationError | LinkageError e) {
                broken++;
                found.add(new Found(null, String.valueOf(e.getMessage()), GuestRuntimeProvider.Availability.unavailable(e.toString()), null));
                continue;
            }
            broken = 0;
            found.add(ask(provider));
        }
        return List.copyOf(found);
    }

    /** A loaded provider's id and availability, either of which may fail. */
    static Found ask(GuestRuntimeProvider provider) {
        String type = provider.getClass().getName();
        String id;
        try {
            id = provider.id();
        } catch (RuntimeException | LinkageError e) {
            return new Found(null, type, GuestRuntimeProvider.Availability.unavailable("id() failed: " + e), null);
        }
        if (id == null || !ID.matcher(id).matches()) {
            return new Found(null, type, GuestRuntimeProvider.Availability.unavailable("its id " + (id == null ? "is null" : "\"" + id + "\" is not "
                + "lower case letters, digits and hyphens")), null);
        }
        GuestRuntimeProvider.Availability availability;
        try {
            availability = Objects.requireNonNull(provider.availability(), "availability() answered null");
        } catch (RuntimeException | LinkageError e) {
            availability = GuestRuntimeProvider.Availability.unavailable("availability() failed: " + e);
        }
        return new Found(id, type, availability, provider);
    }

    /**
     * The provider of {@code requested} among the loader's.
     *
     * @throws EngineSelectionException when no provider has the id, the one that has it is unavailable, or several do. It
     *     is a {@link WasiException}, not an {@link IllegalStateException}: a caller that caught the standard type for this
     *     must catch {@link WasiException}
     */
    public static GuestRuntimeProvider select(String requested, ClassLoader loader) {
        return select(requested, discover(loader));
    }

    /** The selection rule over what was discovered (tests). */
    static GuestRuntimeProvider select(String requested, List<Found> found) {
        String id = requested == null ? "" : requested.trim().toLowerCase(Locale.ROOT);
        if (id.isEmpty()) {
            throw new EngineSelectionException(requested, found, "No engine id was given; engines found: " + listing(found) + ".");
        }
        List<Found> matching = found.stream().filter(entry -> id.equals(entry.id())).toList();
        if (matching.size() > 1) {
            throw new EngineSelectionException(requested, found, "Several providers claim the engine id \"" + id + "\" ("
                + matching.stream().map(Found::providerClass).collect(Collectors.joining(", ")) + "); keep one engine jar of that id "
                + "on the class path.");
        }
        if (matching.isEmpty()) {
            throw new EngineSelectionException(requested, found, "No engine has the id \"" + id + "\"; engines found: " + listing(found)
                + (found.stream().anyMatch(Found::usable) ? "." : ". Add datum-sandbox-endive (the submissions starter brings it) or supply "
                + "a GuestRuntime of your own."));
        }
        Found chosen = matching.get(0);
        if (chosen.availability() instanceof GuestRuntimeProvider.Unavailable unavailable) {
            throw new EngineSelectionException(requested, found, "The engine \"" + id + "\" is not available here: " + unavailable.reason()
                + "; engines found: " + listing(found) + ".");
        }
        return chosen.provider();
    }

    private static String listing(List<Found> found) {
        return found.isEmpty() ? "none" : found.stream().map(Found::describe).collect(Collectors.joining(", "));
    }
}
