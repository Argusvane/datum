package com.argusvane.datum.springweb.spring;

import java.util.Map;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.boot.context.properties.bind.Name;
import org.springframework.core.io.Resource;

/**
 * {@code datum.bindings.*}: which design-system binding each form route is drawn by (the host's
 * configuration says it, never the form's definition) and the PDF theme a PDF of it prints under.
 *
 * <pre>
 * datum.bindings.default=datum                       # a route with no override; the catalog's ids, "datum" when unset
 * datum.bindings.routes.contact=gcds                 # per-route overrides: a form key and the binding it is drawn by
 * datum.bindings.catalog.gcds.label=GC Design System # a binding this host registers on its pages is added to the catalog
 * datum.bindings.catalog.gcds.pdf-theme=gcds         #   with the PDF theme it suggests (none: the engine's own)
 * datum.bindings.pdf-themes.gcds=classpath:/pdf/gcds.json   # the theme object of every suggested PDF theme but datum-pdf
 * </pre>
 *
 * <p>The catalog starts with the binding the bundles carry ({@code datum}, suggesting {@code datum-pdf}, the
 * engine's own PDF look). A PDF of a form carries its binding's PDF theme as the request's host
 * theme, below the render call's and the layout's own; {@code host.json} publishes the same table to the page glue,
 * which sets the binding of each form it wires.
 *
 * @param defaultBinding the binding of a route with no override
 * @param routes         form key to binding id
 * @param catalog        bindings the host adds to the catalog, by id
 * @param pdfThemes      PDF theme id to the location of its JSON object (target {@code pdf}, the same {@code id})
 */
@ConfigurationProperties(prefix = "datum.bindings")
public record DatumBindingsProperties(@Name("default") @DefaultValue("datum") String defaultBinding, Map<String, String> routes,
                                      Map<String, Registered> catalog, Map<String, Resource> pdfThemes) {

    public DatumBindingsProperties {
        defaultBinding = defaultBinding == null || defaultBinding.isBlank() ? "datum" : defaultBinding;
        routes = routes == null ? Map.of() : Map.copyOf(routes);
        catalog = catalog == null ? Map.of() : Map.copyOf(catalog);
        pdfThemes = pdfThemes == null ? Map.of() : Map.copyOf(pdfThemes);
    }

    /** What a host that set nothing runs with. */
    public static DatumBindingsProperties defaults() {
        return new DatumBindingsProperties(null, null, null, null);
    }

    /**
     * A binding the host registers.
     *
     * @param label    shown where bindings are listed; the id when blank
     * @param pdfTheme the PDF theme it suggests, or none
     */
    public record Registered(String label, String pdfTheme) {
    }
}
