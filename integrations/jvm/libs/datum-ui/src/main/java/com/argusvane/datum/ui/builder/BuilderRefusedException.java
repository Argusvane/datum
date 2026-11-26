package com.argusvane.datum.ui.builder;

import com.argusvane.datum.core.DatumException;
import com.argusvane.datum.web.error.ErrorDetails;
import com.argusvane.datum.web.error.ErrorItem;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A builder save that stored nothing, with the save routes' refusal body (endpoint catalog {@code saveForm},
 * {@code createForm}) in the shape the error mapper writes: {@code errors} lists one entry per finding (its code and a
 * sentence for the author, the sentence naming where it is), and {@code kernel} lists the findings ({@code code},
 * {@code where}, {@code limit}), so a client reads codes from one list whichever side found the problem. A typed
 * refusal (a too-deep or too-costly definition, an unavailable sandbox, an invalid catalog) carries a top-level
 * {@code code} too: the conformance suite reads a 503's {@code code} to tell a typed 503 from a server error (REC-16,
 * SEC-05).
 */
public class BuilderRefusedException extends DatumException implements ErrorDetails {

    private static final long serialVersionUID = 1L;

    private final transient List<DefinitionShape.Finding> findings;
    private final boolean kernelList;
    private final boolean topLevelCode;
    private final transient Map<String, String> headers;

    private BuilderRefusedException(String code, int status, String message, List<DefinitionShape.Finding> findings,
                                    boolean kernelList, boolean topLevelCode, Map<String, String> headers, Throwable cause) {
        super(code, status, message, cause);
        this.findings = List.copyOf(findings);
        this.kernelList = kernelList;
        this.topLevelCode = topLevelCode;
        this.headers = Map.copyOf(headers);
    }

    /**
     * 422 {@code definition.refused}: the host's shape findings or the kernel's verdict, with the {@code kernel} list.
     * The code is the exception's only: the body carries no top-level {@code code}, so a client reads
     * {@code errors[].code} and {@code kernel[].code}.
     */
    public static BuilderRefusedException refused(List<DefinitionShape.Finding> findings) {
        StringBuilder words = new StringBuilder();
        for (DefinitionShape.Finding finding : findings) {
            if (words.length() > 0) {
                words.append(' ');
            }
            words.append(finding.message());
            if (words.length() > 500) {
                break;
            }
        }
        return new BuilderRefusedException("definition.refused", 422, words.toString(), findings, true, false, Map.of(), null);
    }

    /** A refusal with one code and sentence, answered with a top-level {@code code}. */
    public static BuilderRefusedException typed(String code, int status, String message, boolean kernelEntry, Throwable cause) {
        List<DefinitionShape.Finding> one = List.of(new DefinitionShape.Finding(code, "definition", message, null));
        return new BuilderRefusedException(code, status, message, one, kernelEntry, true, Map.of(), cause);
    }

    /** {@link #typed} with response headers (a busy sandbox's {@code Retry-After}). */
    public static BuilderRefusedException typed(String code, int status, String message, Map<String, String> headers, Throwable cause) {
        List<DefinitionShape.Finding> one = List.of(new DefinitionShape.Finding(code, "definition", message, null));
        return new BuilderRefusedException(code, status, message, one, false, true, headers, cause);
    }

    /**
     * 422 {@code catalog.invalid}: one entry per problem of the catalog, in TranslationCatalog's sentences. Each finding's
     * {@code where} is the JSON path of the offence.
     */
    public static BuilderRefusedException catalog(List<DefinitionShape.Finding> problems) {
        List<String> sentences = new ArrayList<>();
        for (DefinitionShape.Finding problem : problems) {
            sentences.add(problem.message());
        }
        return new BuilderRefusedException("catalog.invalid", 422, String.join(" ", sentences), problems, false, true, Map.of(), null);
    }

    /** The findings, in order. */
    public List<DefinitionShape.Finding> findings() {
        return findings;
    }

    @Override
    public List<ErrorItem> errorItems() {
        List<ErrorItem> items = new ArrayList<>();
        for (DefinitionShape.Finding finding : findings) {
            items.add(new ErrorItem(null, finding.code(), finding.message()));
        }
        return items;
    }

    @Override
    public Map<String, String> responseHeaders() {
        return headers;
    }

    @Override
    public Map<String, Object> extraBody() {
        Map<String, Object> extra = new LinkedHashMap<>();
        if (topLevelCode) {
            extra.put("code", code());
        }
        if (kernelList) {
            List<Map<String, Object>> kernel = new ArrayList<>();
            for (DefinitionShape.Finding finding : findings) {
                Map<String, Object> entry = new LinkedHashMap<>();
                entry.put("code", finding.code());
                entry.put("where", finding.where());
                if (finding.limit() != null) {
                    entry.put("limit", finding.limit());
                }
                kernel.add(entry);
            }
            extra.put("kernel", kernel);
        }
        return extra;
    }
}
