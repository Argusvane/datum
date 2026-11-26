package com.argusvane.datum.springweb.mvc;

import com.argusvane.datum.web.assets.AssetReply;
import com.argusvane.datum.web.assets.AssetService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.List;
import java.util.Optional;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.Resource;
import org.springframework.http.CacheControl;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;
import org.springframework.web.servlet.resource.ResourceResolver;
import org.springframework.web.servlet.resource.ResourceResolverChain;

/**
 * The versioned asset files on Spring MVC's own resource handler (framework-first). Finding the file, its
 * media type (Spring's {@code mime.types}), conditional requests, ranges and the {@code Last-Modified} and
 * {@code ETag} validators are the framework's; the immutable {@code Cache-Control} is the registration's. What Datum
 * adds is the gate ({@link AssetService#gate}): the build id, the files of omitted features, the builder's files while
 * the builder is off, case-folded, and a strict path.
 *
 * <p>The gate runs twice. A {@link ResourceResolver} placed first in the handler's chain is the authority: it checks
 * exactly the string the framework resolves against the class path, so what is checked is what is read. An interceptor
 * on the same path answers a refused request itself with a bare 404 that no cache keeps ({@code no-store}); it cannot
 * set that header on a success (a 304 would carry it and make a browser forget the immutable copy), and the error
 * page of a handler that found nothing carries none.
 *
 * <p>{@code host.json} and the glue are the router function's ({@link MvcAssetRoutes}), which is asked first.
 */
public final class MvcAssetResources implements WebMvcConfigurer {

    private final AssetService service;

    public MvcAssetResources(AssetService service) {
        this.service = service;
    }

    @Override
    public void addResourceHandlers(ResourceHandlerRegistry registry) {
        if (!service.assets().enabled()) {
            return;
        }
        registry.addResourceHandler(service.routePath() + "/**")
            .addResourceLocations(AssetService.RESOURCE_LOCATION)
            .setCacheControl(CacheControl.maxAge(service.cachePeriod()).cachePublic().immutable())
            .resourceChain(false)
            .addResolver(new Gate(service));
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        if (!service.assets().enabled()) {
            return;
        }
        String root = service.routePath();
        registry.addInterceptor(new Refusal(service)).addPathPatterns(root + "/**")
            .excludePathPatterns(root + "/host.json", root + "/datum-host.js");
    }

    /** The authority: refuses what the gate refuses, and hands the framework the path below the build id. */
    static final class Gate implements ResourceResolver {

        private final AssetService service;

        Gate(AssetService service) {
            this.service = service;
        }

        @Override
        public Resource resolveResource(HttpServletRequest request, String requestPath, List<? extends Resource> locations,
                                        ResourceResolverChain chain) {
            Optional<String> file = service.gate(requestPath);
            return file.isEmpty() ? null : chain.resolveResource(request, file.get(), locations);
        }

        @Override
        public String resolveUrlPath(String resourcePath, List<? extends Resource> locations, ResourceResolverChain chain) {
            // Datum builds no URLs through the framework's resource URL provider; nothing is offered.
            return null;
        }
    }

    /**
     * The early, header-bearing refusal: the raw request URI (nothing decoded, no parameters dropped, no slash collapsed)
     * goes through the same gate, and a file that passes but is not on the class path is refused here too, so every
     * miss is one wire: a bare 404 that no cache keeps, the same as on WebFlux (its filter).
     */
    static final class Refusal implements HandlerInterceptor {

        private final AssetService service;

        Refusal(AssetService service) {
            this.service = service;
        }

        @Override
        public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
            String uri = request.getRequestURI();
            String context = request.getContextPath();
            String path = uri.startsWith(context) ? uri.substring(context.length()) : uri;
            String prefix = service.routePath() + "/";
            String within = path.startsWith(prefix) ? path.substring(prefix.length()) : path;
            Optional<String> file = service.gate(within);
            if (file.isPresent() && new ClassPathResource(AssetService.LOCATION + file.get()).isReadable()) {
                return true;
            }
            AssetReply refusal = service.notFoundReply();
            response.setStatus(refusal.status());
            refusal.headers().forEach(response::setHeader);
            return false;
        }
    }
}
