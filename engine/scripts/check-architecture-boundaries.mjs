import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const projectRoot = process.cwd();
const engineRoot = join(projectRoot, "form-engine");
const coreRoot = join(engineRoot, "core");

/**
 * Icon libraries the engine must not import: its chrome draws every glyph through
 * the icon-set contract in `render/icons/`, and the libraries live in `plugins/icons-*`,
 * registered by the hosts that want them.
 */
const forbiddenIconLibraries = ["@fortawesome/"];

const forbiddenSegments = [
  "/builder/",
  "/render/",
  "/runtime/",
  "/data/",
  "/persistence/",
  "/plugins/",
  "/registry/",
  // The validation layer sits above core: what core shares with the kernel
  // lives in core and the kernel imports it, never the other way round.
  "/validation/",
  // The agent tools sit above the runtime and the renderer: core never names them.
  "/agent/"
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walk(full));
      continue;
    }
    if (full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function collectImports(filePath) {
  const source = readFileSync(filePath, "utf8");
  const pattern = /from\s+["']([^"']+)["']/g;
  const imports = [];
  let match;
  while ((match = pattern.exec(source)) !== null) {
    imports.push(match[1]);
  }
  return imports;
}

const violations = [];
for (const file of walk(coreRoot)) {
  const imports = collectImports(file);
  for (const specifier of imports) {
    if (!specifier.startsWith(".")) {
      continue;
    }

    const normalized = `${specifier.replace(/\\/g, "/")}/`;
    if (forbiddenSegments.some((segment) => normalized.includes(segment))) {
      violations.push({
        file: relative(projectRoot, file),
        importPath: specifier
      });
    }
  }
}

if (violations.length > 0) {
  console.error("Architecture boundary violations detected (core importing upper layers):");
  for (const violation of violations) {
    console.error(`- ${violation.file} imports ${violation.importPath}`);
  }
  process.exit(1);
}

const iconViolations = [];
for (const file of walk(engineRoot)) {
  for (const specifier of collectImports(file)) {
    if (forbiddenIconLibraries.some((prefix) => specifier.startsWith(prefix))) {
      iconViolations.push({ file: relative(projectRoot, file), importPath: specifier });
    }
  }
}

if (iconViolations.length > 0) {
  console.error(
    "Icon library imports detected (the engine draws icons through IconSet; icon libraries live in plugins/icons-*):"
  );
  for (const violation of iconViolations) {
    console.error(`- ${violation.file} imports ${violation.importPath}`);
  }
  process.exit(1);
}

console.log("Architecture boundaries check passed.");
