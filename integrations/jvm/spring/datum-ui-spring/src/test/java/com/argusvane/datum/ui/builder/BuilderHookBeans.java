package com.argusvane.datum.ui.builder;

import com.argusvane.datum.core.hooks.HookFindings;
import com.argusvane.datum.core.hooks.HookProblem;
import com.argusvane.datum.core.hooks.HookRefusedException;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import tools.jackson.databind.node.ObjectNode;

/**
 * Builder hook beans declared against their {@code @Order}: two customizers that stamp the definition in order
 * and refuse or fail for magic titles, and a validator that vetoes or warns.
 */
@Configuration(proxyBeanMethods = false)
public class BuilderHookBeans {

    static ObjectNode metadata(ObjectNode definition) {
        return definition.get("metadata") instanceof ObjectNode existing ? existing : definition.putObject("metadata");
    }

    @Bean
    @Order(2)
    BuilderSaveCustomizer stampsSecond() {
        return draft -> metadata(draft.definition()).put("order", metadata(draft.definition()).path("order").asString("") + ",second");
    }

    @Bean
    @Order(1)
    BuilderSaveCustomizer stampsFirst() {
        return draft -> {
            String title = draft.definition().path("title").asString("");
            if (title.equals("refuse")) {
                throw HookRefusedException.invalid(java.util.List.of(HookProblem.at("title", "naming.title", "Titles start with ACME.")));
            }
            if (title.equals("fail")) {
                throw new IllegalStateException("the naming service is down");
            }
            metadata(draft.definition()).put("order", "first").put("by", draft.principal() == null ? "" : draft.principal().getName());
        };
    }

    @Bean
    BuilderSaveValidator vetoes() {
        return candidate -> candidate.definition().path("title").asString("").equals("veto")
            ? HookFindings.errors(HookProblem.at("name", "policy.label", "Every field needs a label."))
            : HookFindings.warnings(HookProblem.of("policy.note", "Remember the owner."));
    }
}
