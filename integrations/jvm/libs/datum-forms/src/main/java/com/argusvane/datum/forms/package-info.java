/**
 * Datum forms: where definitions live and what is done with them.
 *
 * <p>The SPIs an application replaces ({@code FormDefinitionRepository}, {@code DefinitionSnapshotStore},
 * {@code TranslationCatalogStore}, {@code DataSourceProvider}), the
 * {@code DefinitionService} over the sandbox kernel's {@code public} and {@code check} ops, the option
 * snapshot walk ({@code DataSourceOptions}), the exceptions with their wire codes, and the auto-configuration.
 * The web endpoints are in the {@code web.mvc} and {@code web.webflux} sub-packages.
 */
package com.argusvane.datum.forms;
