package com.argusvane.datum.springweb.mvc;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;

/**
 * Router-function predicates match the path within the application, so the asset routes must be registered
 * without the context path while the URLs in host.json carry it. A request under a context path proves both.
 */
@SpringBootTest(classes = MvcTestApp.class, properties = {"datum.web.assets.enabled=true", "spring.main.web-application-type=servlet",
    "server.servlet.context-path=/shop"})
@AutoConfigureMockMvc
class MvcContextPathTest {

    @Autowired
    MockMvc mvc;

    @Test
    void assetsAreServedUnderTheContextPath() throws Exception {
        var host = mvc.perform(MockMvcRequestBuilders.get("/shop/datum/assets/host.json").contextPath("/shop"))
            .andReturn().getResponse();
        assertThat(host.getStatus()).isEqualTo(200);
        assertThat(host.getContentAsString()).contains("/shop/datum/assets/testbuild1");
        var file = mvc.perform(MockMvcRequestBuilders.get("/shop/datum/assets/testbuild1/datum-form.js").contextPath("/shop"))
            .andReturn().getResponse();
        assertThat(file.getStatus()).isEqualTo(200);
        assertThat(file.getHeader("Cache-Control")).contains("immutable");
    }
}
