package com.argusvane.datum.ui.contract;

import com.argusvane.datum.ui.UiTestApp;
import java.net.URI;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.HttpHeaders;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;

/** Spring MVC, builder switched on. */
@SpringBootTest(classes = UiTestApp.class, properties = {"spring.main.web-application-type=servlet", "datum.builder.enabled=true", "datum.web.assets.enabled=true"})
@AutoConfigureMockMvc
class MvcAssetsEnabledTest extends AbstractAssetsContract {

    @Autowired
    MockMvc mvc;

    @Override
    protected boolean builderEnabled() {
        return true;
    }

    @Override
    protected Reply get(String path) {
        try {
            MockHttpServletResponse response = mvc.perform(MockMvcRequestBuilders.get(URI.create(path))).andReturn().getResponse();
            HttpHeaders headers = new HttpHeaders();
            response.getHeaderNames().forEach(name -> headers.addAll(name, response.getHeaders(name)));
            if (response.getContentType() != null) {
                headers.set(HttpHeaders.CONTENT_TYPE, response.getContentType());
            }
            return new Reply(response.getStatus(), headers, response.getContentAsByteArray());
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }
}
