package com.argusvane.datum.sandbox.protocol;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.contracts.FieldError;
import com.argusvane.datum.core.contracts.ValidationError;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;

/** statusOf and errorsBody of packages/submissions/src/http-mapping.ts. */
class VerdictMapperTest {

    static final Map<String, Integer> TABLE = new LinkedHashMap<>();

    static {
        TABLE.put("unknown_form", 404);
        TABLE.put("unknown_record", 404);
        TABLE.put("bad_document", 400);
        TABLE.put("payload_too_large", 413);
        TABLE.put("version_superseded", 409);
        TABLE.put("submission.keyConflict", 409);
        TABLE.put("not_extractable", 422);
        TABLE.put("invalid_definition", 422);
        TABLE.put("pdf_unavailable", 503);
        TABLE.put("keys_unavailable", 503);
        TABLE.put("validator_unavailable", 503);
        TABLE.put("server.unavailable", 503);
    }

    @Test
    void statusTable() {
        TABLE.forEach((code, status) -> assertThat(VerdictMapper.statusOf(code)).as(code).isEqualTo(status));
        assertThat(VerdictMapper.statusOf("internal")).isEqualTo(500);
        // A run that gave no verdict is a 503 with its own code, never a 422 or a 500 (RUN_FAILED_CODES in types.ts).
        for (String failed : java.util.List.of("wasm.execution_error", "outcome_too_large", "definition.tooDeep")) {
            assertThat(VerdictMapper.statusOf(failed)).as(failed).isEqualTo(503);
        }
        assertThat(VerdictMapper.statusOf(null)).isEqualTo(500);
    }

    /** The TypeScript switch, read from the source: the same cases, the same statuses. */
    @Test
    void tableIsTheTypeScriptOne() {
        String source = Fixtures.repoText("packages/submissions/src/http-mapping.ts");
        Assumptions.assumeTrue(source != null, "built outside the monorepo");
        int start = source.indexOf("export function statusOf(");
        String body = source.substring(start, source.indexOf("\n}\n", start));
        Map<String, Integer> found = new LinkedHashMap<>();
        Matcher m = Pattern.compile("((?:\\s*case \"[A-Za-z_.]+\":)+)\\s*return (\\d+);").matcher(body);
        while (m.find()) {
            Matcher c = Pattern.compile("case \"([A-Za-z_.]+)\":").matcher(m.group(1));
            while (c.find()) {
                found.put(c.group(1), Integer.parseInt(m.group(2)));
            }
        }
        assertThat(found).containsExactlyInAnyOrderEntriesOf(TABLE);
        assertThat(body).contains("default:\n      return 500;");
        // The failed-run set that the switch answers 503 before it looks at a case.
        String types = Fixtures.repoText("packages/submissions/src/types.ts");
        if (types != null) {
            Matcher set = Pattern.compile("RUN_FAILED_CODES[^=]*=\\s*new Set\\(\\[([^\\]]*)\\]\\)").matcher(types);
            assertThat(set.find()).as("RUN_FAILED_CODES in types.ts").isTrue();
            assertThat(set.group(1).replace("\"", "").replace(" ", "").split(",")).containsExactlyInAnyOrder("wasm.execution_error",
                "outcome_too_large", "definition.tooDeep");
        }
    }

    @Test
    void errorsBodyHasCodesAndFieldsNeverText() throws Exception {
        List<ValidationError> errors = List.of(
            new ValidationError("required", "name", null, null, null, null, null, null),
            new ValidationError("form.custom", null, null, null, null, "error", null, null));
        assertThat(VerdictMapper.errorsBody(errors).errors()).containsExactly(new FieldError("name", "required"), new FieldError(null, "form.custom"));
        assertThat(StrictJson.mapper().writeValueAsString(VerdictMapper.errorsBody(errors)))
            .isEqualTo("{\"errors\":[{\"field\":\"name\",\"code\":\"required\"},{\"code\":\"form.custom\"}]}");
        var raw = StrictJson.decode("[{\"code\":\"required\",\"componentId\":\"name\",\"message\":\"secret text\",\"parameters\":{\"x\":1}},{\"code\":\"x\"}]");
        assertThat(StrictJson.mapper().writeValueAsString(VerdictMapper.errorsBody(raw)))
            .isEqualTo("{\"errors\":[{\"field\":\"name\",\"code\":\"required\"},{\"code\":\"x\"}]}");
    }
}
