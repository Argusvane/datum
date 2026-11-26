package com.argusvane.datum.springweb.mvc;

import static org.assertj.core.api.Assertions.assertThat;

import java.security.Principal;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

/** The one servlet rule for the pieces of a request view. */
class MvcRequestViewsTest {

    @Test
    void headersKeepEveryValueInTheOrderTheyCame() {
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/x");
        request.addHeader("X-Probe", "one");
        request.addHeader("X-Probe", "two");
        request.addHeader("Accept", "application/json");
        assertThat(MvcRequestViews.headers(request)).containsOnlyKeys("X-Probe", "Accept");
        assertThat(MvcRequestViews.headers(request).get("X-Probe")).containsExactly("one", "two");
    }

    @Test
    void theRemoteAddressIsTheContainersAndThePrincipalIsTheRequests() {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/x");
        request.setRemoteAddr("203.0.113.7");
        Principal ada = () -> "ada";
        request.setUserPrincipal(ada);
        assertThat(MvcRequestViews.remoteAddress(request)).isEqualTo("203.0.113.7");
        assertThat(MvcRequestViews.principal(request)).isSameAs(ada);
        assertThat(MvcRequestViews.principal(new MockHttpServletRequest())).as("anonymous").isNull();
    }
}
