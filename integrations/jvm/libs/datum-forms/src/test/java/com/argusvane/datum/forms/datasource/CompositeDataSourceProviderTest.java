package com.argusvane.datum.forms.datasource;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.DatumStartupCheck;
import com.argusvane.datum.core.contracts.OptionItem;
import com.argusvane.datum.forms.DataSourceNotFoundException;
import java.security.Principal;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.JsonNodeFactory;

/** Several providers asked in turn: the first whose exists(id) is true owns the id. */
class CompositeDataSourceProviderTest {

    /** A provider that owns some ids and records what it was asked. */
    private static final class Owning implements DataSourceProvider {
        final Set<String> ids;
        final String label;
        final boolean validates;
        final List<String> asked = new ArrayList<>();

        Owning(String label, boolean validates, String... ids) {
            this.label = label;
            this.validates = validates;
            this.ids = Set.of(ids);
        }

        @Override
        public List<OptionItem> items(String id, String locale, Principal principal) {
            asked.add(id);
            return List.of(new OptionItem(label + ":" + id, JsonNodeFactory.instance.stringNode(label), null, null, null));
        }

        @Override
        public boolean exists(String id) {
            return ids.contains(id);
        }

        @Override
        public boolean validatesAnswers(String id) {
            return validates;
        }
    }

    @Test
    void theFirstProviderThatHasTheIdAnswersAndTheOthersAreNotAsked() {
        Owning countries = new Owning("countries", true, "countries");
        Owning products = new Owning("products", false, "products", "countries");
        CompositeDataSourceProvider composite = new CompositeDataSourceProvider(List.of(countries, products));

        assertThat(composite.items("countries", "", null)).extracting(OptionItem::value).containsExactly("countries:countries");
        assertThat(composite.items("products", "", null)).extracting(OptionItem::value).containsExactly("products:products");
        assertThat(countries.asked).containsExactly("countries");
        assertThat(products.asked).containsExactly("products");
    }

    @Test
    void existsIsAnyAndAnUnknownIdIsNotFound() {
        CompositeDataSourceProvider composite = new CompositeDataSourceProvider(List.of(new Owning("a", true, "one"), new Owning("b", true, "two")));
        assertThat(composite.exists("one")).isTrue();
        assertThat(composite.exists("two")).isTrue();
        assertThat(composite.exists("three")).isFalse();
        assertThatThrownBy(() -> composite.items("three", "", null)).isInstanceOf(DataSourceNotFoundException.class);
        assertThatThrownBy(() -> composite.allowed("three", List.of("x"), "", null)).isInstanceOf(DataSourceNotFoundException.class);
    }

    @Test
    void validationAndAllowedFollowTheOwner() {
        Owning strict = new Owning("a", true, "one");
        Owning suggestions = new Owning("b", false, "two");
        CompositeDataSourceProvider composite = new CompositeDataSourceProvider(List.of(strict, suggestions));
        assertThat(composite.validatesAnswers("one")).isTrue();
        assertThat(composite.validatesAnswers("two")).isFalse();
        assertThat(composite.allowed("one", List.of("a:one", "nope"), "", null)).containsExactly("a:one");
    }

    @Test
    void ofIsNullForNoneTheSameProviderForOneAndACompositeForSeveral() {
        Owning only = new Owning("a", true, "one");
        assertThat(CompositeDataSourceProvider.of(List.of())).isNull();
        assertThat(CompositeDataSourceProvider.of(List.of(only))).isSameAs(only);
        assertThat(CompositeDataSourceProvider.of(List.of(only, new Owning("b", true, "two")))).isInstanceOf(CompositeDataSourceProvider.class);
        assertThatThrownBy(() -> new CompositeDataSourceProvider(List.of())).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void aProviderKeepingTheDefaultExistsIsNamedInAWarn() {
        DataSourceProvider careless = (id, locale, principal) -> List.of();
        Owning careful = new Owning("a", true, "one");
        CompositeDataSourceProvider composite = new CompositeDataSourceProvider(List.of(careless, careful));

        assertThat(composite.withoutExists()).containsExactly(careless);
        List<DatumStartupCheck.Notice> notices = composite.startupCheck().check();
        assertThat(notices).hasSize(1);
        assertThat(notices.get(0).level()).isEqualTo(DatumStartupCheck.Level.WARN);
        assertThat(notices.get(0).message()).contains("does not override exists(id)").contains("2 DataSourceProvider");
        // The careless one answers everything, so the second is never reached: the reason for the warning.
        assertThat(composite.exists("anything")).isTrue();
        assertThat(new CompositeDataSourceProvider(List.of(careful, new Owning("b", true, "two"))).startupCheck().check()).isEmpty();
    }
}
