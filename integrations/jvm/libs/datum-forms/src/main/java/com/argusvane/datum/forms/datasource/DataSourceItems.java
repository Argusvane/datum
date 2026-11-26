package com.argusvane.datum.forms.datasource;

import com.argusvane.datum.core.contracts.OptionItem;
import java.util.List;
import java.util.Locale;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/** Options as plain strings in a locale, as the option snapshot carries them (sandbox ABI 2.9.0). */
public final class DataSourceItems {

    private DataSourceItems() {
    }

    /**
     * The items with label and description as plain strings. A data source's item text is host data, not form content:
     * a {@code LocalizedText} resolved by locale alone (exact, then primary subtag, then the text's
     * {@code default}), never through a translation catalog. A missing label reads as the value. Values are untouched.
     *
     * @return {@code [{value, label, description?}]}
     */
    public static ArrayNode resolve(List<OptionItem> items, String locale) {
        ArrayNode plain = JsonNodeFactory.instance.arrayNode();
        for (OptionItem item : items) {
            String value = item.value() == null ? "" : item.value();
            ObjectNode resolved = plain.addObject();
            resolved.put("value", value);
            String label = plainText(item.label(), locale);
            resolved.put("label", label != null ? label : value);
            String description = plainText(item.description(), locale);
            if (description != null && !description.isEmpty()) {
                resolved.put("description", description);
            }
        }
        return plain;
    }

    /** A string or LocalizedText as a string in a locale; null when it has none. */
    public static String plainText(JsonNode text, String locale) {
        if (text == null || text.isNull() || text.isMissingNode()) {
            return null;
        }
        if (text.isString()) {
            return text.stringValue();
        }
        if (!text.isObject()) {
            return null;
        }
        String found = byLocale(text.path("locales"), locale);
        if (found != null) {
            return found;
        }
        return text.path("default").isString() ? text.path("default").stringValue() : null;
    }

    /**
     * The engine's {@code resolveLocalizedText} order over the inline {@code locales}: exact, then primary subtag; each
     * compared case-insensitively with an underscore read as a hyphen, an empty string falling through. Null when no step
     * has a text (the caller uses the {@code default}).
     */
    private static String byLocale(JsonNode locales, String locale) {
        if (!locales.isObject() || locale == null) {
            return null;
        }
        String wanted = locale.trim().replace('_', '-').toLowerCase(Locale.ROOT);
        if (wanted.isEmpty()) {
            return null;
        }
        int dash = wanted.indexOf('-');
        String primary = dash < 0 ? wanted : wanted.substring(0, dash);
        for (String step : new String[] {wanted, primary}) {
            for (var candidate : locales.properties()) {
                if (candidate.getValue().isString() && !candidate.getValue().stringValue().isEmpty()
                    && candidate.getKey().replace('_', '-').toLowerCase(Locale.ROOT).equals(step)) {
                    return candidate.getValue().stringValue();
                }
            }
        }
        return null;
    }
}
