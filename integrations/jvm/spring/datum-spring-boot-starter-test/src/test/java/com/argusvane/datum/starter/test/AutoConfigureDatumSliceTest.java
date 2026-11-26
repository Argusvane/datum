package com.argusvane.datum.starter.test;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.sandbox.wasi.GuestRuntime;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.context.ApplicationContext;
import org.springframework.test.web.servlet.assertj.MockMvcTester;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** The annotation composes with a slice: {@code @WebMvcTest} together with {@code @AutoConfigureDatum}. */
@WebMvcTest(AutoConfigureDatumSliceTest.Hello.class)
@AutoConfigureDatum
@org.springframework.context.annotation.Import(AutoConfigureDatumSliceTest.Hello.class)
class AutoConfigureDatumSliceTest {

    @SpringBootApplication
    static class App {
    }

    @RestController
    static class Hello {

        @GetMapping("/hello")
        String hello() {
            return "hi";
        }
    }

    @Autowired
    MockMvcTester mvc;

    @Autowired
    ApplicationContext context;

    @Test
    void theSliceStartsWithTheFakeRuntimeAndNoFixtureForms() {
        assertThat(mvc.get().uri("/hello").exchange()).hasStatusOk().bodyText().isEqualTo("hi");
        assertThat(context.getBeansOfType(GuestRuntime.class).values()).singleElement().isInstanceOf(FakeGuestRuntime.class);
        assertThat(context.getBeansOfType(DatumTestForms.Repository.class)).isEmpty();
    }
}
