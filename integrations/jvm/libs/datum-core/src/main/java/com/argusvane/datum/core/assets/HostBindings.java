package com.argusvane.datum.core.assets;

import com.argusvane.datum.core.DatumConfigurationException;
import com.argusvane.datum.core.FormKeyRule;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.regex.Pattern;
import tools.jackson.databind.JsonNode;

/**
 * Which design-system binding each form route is drawn by, and the PDF theme a PDF of it prints under (a server host knows a form's
 * binding from its own configuration, one binding for the host or one per form route, never from a field of the
 * definition).
 *
 * <p>The catalog is the manifest's {@link AssetManifest#builtinBindings()} (the Datum binding and the PDF theme it
 * suggests; dark is the element's {@code scheme} attribute, not a binding) plus the entries the host adds for a binding it registers on its pages ({@code gcds} suggesting the PDF
 * theme {@code gcds}, say). A route is a form key: its binding is the host's override for that key, else the host's
 * default, else {@value #DEFAULT_BINDING}. The PDF theme is the catalog's {@code pdfTheme} for that binding: the rung
 * of the engine's PDF ladder after the call, the layout and the host's own default theme object. {@value #DEFAULT_PDF_THEME}
 * is the engine's own look, so nothing is sent for it; any other id needs its theme object, which the host supplies
 * ({@code datum.bindings.pdf-themes.*}). Nothing is written into a layout.
 *
 * <p>Immutable. A setting that cannot work (a binding the catalog does not list, a PDF theme nobody supplies) is a
 * {@link DatumConfigurationException} when the host starts, never a PDF printed under the wrong look.
 */
public final class HostBindings {

    /** The binding of a host that names none: the Datum binding. */
    public static final String DEFAULT_BINDING = "datum";

    /** The engine's own PDF theme: it is what a request prints under with no theme object, so none is sent. */
    public static final String DEFAULT_PDF_THEME = "datum-pdf";

    /** The property a route key misses. */
    public static final String ROUTES_PROPERTY = "datum.bindings.routes";

    private static final Pattern ID = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");

    private final String defaultBinding;
    private final Map<String, String> routes;
    private final Map<String, AssetManifest.Binding> catalog;
    private final Map<String, JsonNode> pdfThemes;

    private HostBindings(String defaultBinding, Map<String, String> routes, Map<String, AssetManifest.Binding> catalog,
                         Map<String, JsonNode> pdfThemes) {
        this.defaultBinding = defaultBinding;
        this.routes = routes;
        this.catalog = catalog;
        this.pdfThemes = pdfThemes;
    }

    /** What a host that configured nothing runs with: the manifest's bindings, the Datum binding everywhere. */
    public static HostBindings of(AssetManifest manifest) {
        return of(manifest, null, Map.of(), List.of(), Map.of());
    }

    /**
     * The bindings of a host.
     *
     * @param manifest       the assets' manifest (its {@code builtinBindings} are the catalog's first entries)
     * @param defaultBinding the binding of a route with no override; null or blank for {@value #DEFAULT_BINDING}
     * @param routes         form key to binding id
     * @param registered     the entries the host adds to the catalog (a binding it registers on its pages); an entry with
     *                       a built-in's id replaces it
     * @param pdfThemes      PDF theme id to the theme object the host supplies (target {@code pdf}, the same {@code id})
     * @throws DatumConfigurationException a binding or a form key that cannot be used, or a PDF theme nobody supplies
     */
    public static HostBindings of(AssetManifest manifest, String defaultBinding, Map<String, String> routes,
                                  List<AssetManifest.Binding> registered, Map<String, JsonNode> pdfThemes) {
        Objects.requireNonNull(manifest, "manifest");
        Map<String, AssetManifest.Binding> catalog = new LinkedHashMap<>();
        manifest.builtinBindings().forEach(binding -> catalog.put(binding.id(), binding));
        if (catalog.isEmpty()) {
            // A classpath without generated assets (a development build, AssetManifest.absent()) still has the Datum binding.
            catalog.put(DEFAULT_BINDING, new AssetManifest.Binding(DEFAULT_BINDING, "Datum", DEFAULT_PDF_THEME));
        }
        for (AssetManifest.Binding entry : registered == null ? List.<AssetManifest.Binding>of() : registered) {
            if (entry.id() == null || !ID.matcher(entry.id()).matches()) {
                throw new DatumConfigurationException("datum.bindings.catalog", "A binding id is letters, digits, '.', '_' and '-' (1 to 64 characters).",
                    "Give the registered binding a short id such as gcds.");
            }
            if (entry.pdfTheme() != null && !ID.matcher(entry.pdfTheme()).matches()) {
                throw new DatumConfigurationException("datum.bindings.catalog." + entry.id() + ".pdf-theme",
                    "A PDF theme id is letters, digits, '.', '_' and '-' (1 to 64 characters).");
            }
            catalog.put(entry.id(), new AssetManifest.Binding(entry.id(), entry.label() == null || entry.label().isBlank() ? entry.id() : entry.label(),
                entry.pdfTheme()));
        }
        Map<String, JsonNode> themes = new LinkedHashMap<>();
        (pdfThemes == null ? Map.<String, JsonNode>of() : pdfThemes).forEach((id, theme) -> {
            if (theme == null || !theme.isObject()) {
                throw new DatumConfigurationException("datum.bindings.pdf-themes." + id, "The PDF theme is a JSON object.");
            }
            if (!id.equals(theme.path("id").asString(""))) {
                throw new DatumConfigurationException("datum.bindings.pdf-themes." + id,
                    "The PDF theme object under '" + id + "' has the id '" + theme.path("id").asString("") + "'; the two are one name.");
            }
            if (!"pdf".equals(theme.path("target").asString(""))) {
                throw new DatumConfigurationException("datum.bindings.pdf-themes." + id,
                    "The theme is not a PDF theme (its target is not 'pdf'); a form look is never printed from.");
            }
            themes.put(id, theme.deepCopy());
        });
        String chosen = defaultBinding == null || defaultBinding.isBlank() ? DEFAULT_BINDING : defaultBinding.strip();
        requireListed(catalog, chosen, "datum.bindings.default");
        Map<String, String> byRoute = new LinkedHashMap<>();
        (routes == null ? Map.<String, String>of() : routes).forEach((key, id) -> {
            if (!FormKeyRule.isValid(key)) {
                throw new DatumConfigurationException(ROUTES_PROPERTY, "'" + key + "' is not a form key.",
                    "Name the route by its form key: 1 to 128 letters, digits, dots, hyphens or underscores.");
            }
            requireListed(catalog, id == null ? "" : id.strip(), ROUTES_PROPERTY + "." + key);
            byRoute.put(key, id.strip());
        });
        List<String> used = new ArrayList<>();
        used.add(chosen);
        used.addAll(byRoute.values());
        for (String binding : used) {
            String theme = catalog.get(binding).pdfTheme();
            if (theme != null && !DEFAULT_PDF_THEME.equals(theme) && !themes.containsKey(theme)) {
                throw new DatumConfigurationException("datum.bindings.pdf-themes." + theme,
                    "The binding '" + binding + "' suggests the PDF theme '" + theme + "', which this host does not supply.",
                    "Add the theme object under datum.bindings.pdf-themes." + theme + ", or name another PDF theme for the binding.");
            }
        }
        return new HostBindings(chosen, Map.copyOf(byRoute), Map.copyOf(catalog), Map.copyOf(themes));
    }

    private static void requireListed(Map<String, AssetManifest.Binding> catalog, String id, String property) {
        if (!catalog.containsKey(id)) {
            throw new DatumConfigurationException(property, "The binding '" + id + "' is not in the host's catalog.",
                "Use one of " + String.join(", ", catalog.keySet().stream().sorted().toList())
                    + ", or add it under datum.bindings.catalog.");
        }
    }

    /** The binding id every route without an override is drawn by. */
    public String defaultBinding() {
        return defaultBinding;
    }

    /** The per-route overrides: form key to binding id. */
    public Map<String, String> routes() {
        return routes;
    }

    /** The catalog: every binding the host knows, built in or registered, by id. */
    public Map<String, AssetManifest.Binding> catalog() {
        return catalog;
    }

    /** The binding id a form is drawn by. */
    public String bindingOf(String formKey) {
        return formKey == null ? defaultBinding : routes.getOrDefault(formKey, defaultBinding);
    }

    /** The catalog entry of a form's binding. */
    public AssetManifest.Binding bindingEntry(String formKey) {
        return catalog.get(bindingOf(formKey));
    }

    /** The id of the PDF theme the form's binding suggests, or null when it suggests none. */
    public String pdfThemeId(String formKey) {
        return bindingEntry(formKey).pdfTheme();
    }

    /**
     * The theme object a PDF of the form carries as the request's {@code theme} (the host rung), or null: the binding
     * suggests no PDF theme, or the engine's own ({@value #DEFAULT_PDF_THEME}), which needs none.
     */
    public JsonNode pdfTheme(String formKey) {
        String id = pdfThemeId(formKey);
        return id == null || DEFAULT_PDF_THEME.equals(id) ? null : pdfThemes.get(id);
    }

    /** {@code host.json}'s {@code bindings}: the default, the overrides and the catalog's ids with their PDF themes. */
    public Map<String, Object> describe() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("default", defaultBinding);
        out.put("routes", new java.util.TreeMap<>(routes));
        List<Map<String, Object>> entries = new ArrayList<>();
        catalog.values().stream().sorted(java.util.Comparator.comparing(AssetManifest.Binding::id)).forEach(binding -> {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("id", binding.id());
            entry.put("label", binding.label());
            if (binding.pdfTheme() != null) {
                entry.put("pdfTheme", binding.pdfTheme());
            }
            entries.add(entry);
        });
        out.put("catalog", entries);
        return out;
    }
}
