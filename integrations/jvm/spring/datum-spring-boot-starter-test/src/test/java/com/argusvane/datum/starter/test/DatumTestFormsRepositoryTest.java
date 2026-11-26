package com.argusvane.datum.starter.test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.forms.FormOutdatedException;
import com.argusvane.datum.forms.SavedForm;
import java.util.List;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/** The test kit's in-memory repository makes the conditional save the SPI asks of every repository. */
class DatumTestFormsRepositoryTest {

    private static ObjectNode form(String id, String title) {
        ObjectNode definition = JsonNodeFactory.instance.objectNode().put("id", id);
        definition.putObject("root").putObject("configuration").put("title", title);
        return definition;
    }

    @Test
    void theConditionalSaveRefusesAVersionThatIsNotTheStoredOne() {
        DatumTestForms.Repository repository = new DatumTestForms.Repository(List.of());
        SavedForm first = repository.save(form("a", "One"), null);
        assertThatThrownBy(() -> repository.save(form("a", "Again"), null)).as("null: the form must not exist")
            .isInstanceOfSatisfying(FormOutdatedException.class, e -> assertThat(e.currentSha256()).isEqualTo(first.sha256()));
        assertThatThrownBy(() -> repository.save(form("a", "Two"), "not-the-hash"))
            .isInstanceOfSatisfying(FormOutdatedException.class, e -> assertThat(e.currentSha256()).isEqualTo(first.sha256()));
        SavedForm second = repository.save(form("a", "Two"), first.sha256());
        assertThat(second.sha256()).isNotEqualTo(first.sha256());
        assertThatThrownBy(() -> repository.save(form("b", "New"), "some-hash")).as("a hash for a form that does not exist")
            .isInstanceOfSatisfying(FormOutdatedException.class, e -> assertThat(e.currentSha256()).isEmpty());
    }
}
