package com.argusvane.datum.forms.datasource;

import com.argusvane.datum.core.contracts.OptionItem;
import java.security.Principal;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Where a data-sourced choice component gets its options: a bean that answers by source id. There is no default:
 * without a bean the data-source endpoint answers 404 and a definition that names a source goes unchecked for it
 * (the option snapshot is empty).
 *
 * <p>Implementations are called on a worker thread under a timeout ({@code datum.forms.data-sources.timeout}),
 * so they must not rely on thread-bound state such as the security context: the principal is passed in.
 */
public interface DataSourceProvider {

    /**
     * The options of source {@code id} in a locale, as {@code principal} (null when anonymous) may see them.
     * Labels and descriptions are plain text in the locale, or a LocalizedText ({@code default, locales?})
     * a source holding every language returns; the browser resolves it, and {@link DataSourceItems#resolve}
     * does for anything that crosses the sandbox.
     *
     * @param locale the form's locale (fr-CA), or "" for the application's default
     * @throws com.argusvane.datum.forms.DataSourceNotFoundException for an id this provider lacks
     */
    List<OptionItem> items(String id, String locale, Principal principal);

    /** Whether the provider has a source with this id; a source it lacks is left out of the option snapshot. */
    default boolean exists(String id) {
        return true;
    }

    /**
     * Whether answers are held to this source's options. A source that returns false (free text with
     * suggestions) has its choices marked {@code answersFree}, so the kernel skips the option check.
     */
    default boolean validatesAnswers(String id) {
        return true;
    }

    /**
     * The values among some answers that are options of this source, checked afresh for the person submitting
     * (for example a query narrowed to the ids asked, or a record's published state). The default
     * filters {@link #items}, which suits short lists; a source with a large option set should override it
     * with a query for the candidates, because a submission must never list a whole table.
     */
    default List<String> allowed(String id, List<String> candidates, String locale, Principal principal) {
        Set<String> options = new HashSet<>();
        for (OptionItem item : items(id, locale, principal)) {
            if (item.value() != null) {
                options.add(item.value());
            }
        }
        return candidates.stream().filter(options::contains).toList();
    }
}
