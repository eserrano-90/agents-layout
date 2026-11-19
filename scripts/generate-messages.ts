/**
 * Generate core/src/messages.ts (browser protocol), core/src/ingestMessages.ts
 * (ingest contract types) and core/src/ingestSchema.ts (ingest runtime JSON Schema)
 * from core/asyncapi.yaml using @asyncapi/modelina.
 *
 * Pipeline:
 *  1. Parse yaml via Modelina's TypeScriptGenerator (which uses asyncapi parser internally).
 *  2. Apply two custom constraints:
 *     - propertyKey: bypass Modelina's hardcoded reserved-keyword renaming (Modelina
 *       renames `type` -> `reservedType` and `status` -> `reservedStatus`, which would
 *       break the discriminated-union narrowing pattern used everywhere in the webview).
 *     - constant: always render `const: 'foo'` as the inline literal `'foo'` instead
 *       of an enum-style reference (`AnonymousSchema_N.FOO`) -- the latter is invalid
 *       TS when `enumType: 'union'` produces type aliases.
 *  3. Filter out unreferenced AnonymousSchema_* enum aliases that Modelina splits but
 *     our `constant` override leaves dead.
 *  4. Concatenate all model outputs into a single core/src/messages.ts file with a
 *     header banner (DO NOT EDIT MANUALLY).
 *  5. Run prettier --write + eslint --fix on the file so it matches repo style and
 *     is reviewable as code (committed file, not gitignored).
 */

import { TypeScriptGenerator } from '@asyncapi/modelina';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = path.resolve(__dirname, '..');
const YAML_PATH = path.join(REPO_ROOT, 'core', 'asyncapi.yaml');
const OUTPUT_PATH = path.join(REPO_ROOT, 'core', 'src', 'messages.ts');
/** Types for the client -> server ingest contract (POST /api/ingest). */
const INGEST_OUTPUT_PATH = path.join(REPO_ROOT, 'core', 'src', 'ingestMessages.ts');
/** Runtime JSON Schema for IngestRequest, used by the server to validate bodies. */
const INGEST_SCHEMA_OUTPUT_PATH = path.join(REPO_ROOT, 'core', 'src', 'ingestSchema.ts');

/** Root schemas of the ingest contract. Everything reachable from these via
 *  `$ref` is emitted to ingestMessages.ts instead of messages.ts. */
const INGEST_ROOTS = ['IngestRequest', 'IngestResponse'];
const SCHEMA_REF_PREFIX = '#/components/schemas/';

const HEADER = `/**
 * AUTO-GENERATED FROM core/asyncapi.yaml. DO NOT EDIT MANUALLY.
 *
 * Run \`npm run asyncapi:generate\` to regenerate.
 *
 * Source of truth: the yaml at core/asyncapi.yaml. 
 * Editors and clients in any language can consume the spec directly.
 */

`;

async function main(): Promise<void> {
  if (!fs.existsSync(YAML_PATH)) {
    console.error(`[generate-messages] ${YAML_PATH} not found.`);
    process.exit(1);
  }

  const generator = new TypeScriptGenerator({
    modelType: 'interface',
    enumType: 'union',
    mapType: 'record',
    moduleSystem: 'ESM',
    useJavascriptReservedKeywords: false,
    constraints: {
      // Bypass reserved-keyword renaming so `type` and `status` stay verbatim.
      // Without this, discriminated-union narrowing (`msg.type === 'foo'`) breaks.
      propertyKey: ({ objectPropertyModel }) => objectPropertyModel.propertyName,
      // Always render const: '<value>' as the inline literal '<value>'. Default
      // Modelina behavior produces enum-style references that aren't valid TS
      // when enumType: 'union' generates plain type aliases.
      constant: ({ constrainedMetaModel }) => {
        const constOptions = constrainedMetaModel.options?.const;
        return constOptions ? `'${String(constOptions.originalInput)}'` : undefined;
      },
    },
  });

  const yaml = fs.readFileSync(YAML_PATH, 'utf-8');
  const models = await generator.generate(yaml);

  // Drop unreferenced single-value anonymous enum aliases. Modelina splits each
  // `const` schema into its own ConstrainedEnumModel; our `constant` override
  // inlines the literal so the alias is dead code. Multi-value enums (real
  // string-literal unions) stay -- they ARE referenced by their containing
  // schema. The yaml should still extract them to named schemas for readability;
  // this filter only drops the const-derived garbage.
  const filtered = models.filter((m) => {
    const isAnon = m.modelName.startsWith('AnonymousSchema_');
    const isEnum = m.model.constructor.name === 'ConstrainedEnumModel';
    if (!isAnon || !isEnum) return true;
    // Keep multi-value enums (still referenced); drop single-value (inlined).
    const enumModel = m.model as { values?: unknown[] };
    return (enumModel.values?.length ?? 0) > 1;
  });

  // Inline objects that Modelina extracts to AnonymousSchema_N interfaces are
  // still referenced. Renaming them in-place to a stable name is out of scope --
  // the yaml is authored to extract reusable shapes (AgentSeatMeta, etc.) so
  // the AnonymousSchema_N shouldn't appear in practice. Warn loudly if any do.
  const leakingAnon = filtered.filter((m) => m.modelName.startsWith('AnonymousSchema_'));
  if (leakingAnon.length > 0) {
    console.warn(
      `[generate-messages] WARNING: ${leakingAnon.length} anonymous schema(s) leaked into output: ` +
        leakingAnon.map((m) => m.modelName).join(', ') +
        '. Consider extracting them to named schemas in core/asyncapi.yaml.',
    );
  }

  // Split models between the browser protocol (messages.ts) and the ingest
  // contract (ingestMessages.ts). Membership is decided from the yaml: a schema
  // belongs to the ingest file when it is reachable from an ingest root.
  const doc = parseYaml(yaml) as { components?: { schemas?: Record<string, unknown> } };
  const schemas = doc.components?.schemas ?? {};
  const ingestNames = collectReachable(schemas, INGEST_ROOTS);
  const browserNames = collectReachable(schemas, ['ServerMessage', 'ClientMessage']);
  const shared = [...ingestNames].filter((n) => browserNames.has(n));
  if (shared.length > 0) {
    console.error(
      `[generate-messages] schema(s) shared between the browser protocol and the ingest contract: ${shared.join(', ')}. ` +
        'Give each contract its own schema so the generated files stay independent.',
    );
    process.exit(1);
  }

  // Each model.result is a complete TS declaration (interface/type). Modelina
  // emits `interface Foo` (no `export`) via .generate(); we add `export`.
  const browserModels = filtered.filter((m) => !ingestNames.has(m.modelName));
  const ingestModels = filtered.filter((m) => ingestNames.has(m.modelName));

  fs.writeFileSync(
    OUTPUT_PATH,
    HEADER + browserModels.map((m) => exportify(m.result)).join('\n\n') + '\n',
    'utf-8',
  );
  console.log(`[generate-messages] wrote ${OUTPUT_PATH} (${browserModels.length} models)`);

  fs.writeFileSync(
    INGEST_OUTPUT_PATH,
    HEADER + ingestModels.map((m) => exportify(m.result)).join('\n\n') + '\n',
    'utf-8',
  );
  console.log(`[generate-messages] wrote ${INGEST_OUTPUT_PATH} (${ingestModels.length} models)`);

  // Runtime JSON Schema for request validation: the ingest subset of the yaml's
  // schemas, with annotation-only keywords removed and refs rewritten to $defs.
  const defs: Record<string, unknown> = {};
  for (const name of [...ingestNames].sort()) {
    defs[name] = toJsonSchema(schemas[name]);
  }
  const ingestSchema = {
    $id: 'pixel-agents-ingest-request',
    $ref: '#/$defs/IngestRequest',
    $defs: defs,
  };
  fs.writeFileSync(
    INGEST_SCHEMA_OUTPUT_PATH,
    HEADER +
      '/** JSON Schema (draft 2020-12 subset) for the body of POST /api/ingest. */\n' +
      `export const INGEST_REQUEST_SCHEMA = ${JSON.stringify(ingestSchema, null, 2)} as const;\n`,
    'utf-8',
  );
  console.log(`[generate-messages] wrote ${INGEST_SCHEMA_OUTPUT_PATH} (${ingestNames.size} schemas)`);

  // Format + lint --fix the generated files so the committed files pass CI.
  const outputs = [OUTPUT_PATH, INGEST_OUTPUT_PATH, INGEST_SCHEMA_OUTPUT_PATH];
  try {
    execSync(`npx prettier --write ${outputs.map(quote).join(' ')}`, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
  } catch (err) {
    console.error('[generate-messages] prettier failed:', err);
    process.exit(1);
  }
  try {
    execSync(
      `npx eslint --fix ${outputs.map((o) => quote(path.relative(REPO_ROOT, o))).join(' ')}`,
      { cwd: REPO_ROOT, stdio: 'inherit' },
    );
  } catch {
    // ESLint may exit non-zero if there are unfixable warnings; that's okay --
    // we want to see them but not fail generation.
    console.warn('[generate-messages] eslint --fix reported issues (non-fatal).');
  }
}

/** Names of every schema reachable from `roots` by following `$ref`s. */
function collectReachable(schemas: Record<string, unknown>, roots: string[]): Set<string> {
  const seen = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string' && value.startsWith(SCHEMA_REF_PREFIX)) {
        visitName(value.slice(SCHEMA_REF_PREFIX.length));
      } else {
        visit(value);
      }
    }
  };
  const visitName = (name: string): void => {
    if (seen.has(name) || !(name in schemas)) return;
    seen.add(name);
    visit(schemas[name]);
  };
  roots.forEach(visitName);
  return seen;
}

/**
 * Convert an AsyncAPI schema object into plain JSON Schema: drop annotation-only
 * keywords the validator does not understand (`description`, AsyncAPI's string
 * `discriminator`) and point `$ref`s at `$defs`.
 */
function toJsonSchema(node: unknown, parentKey?: string): unknown {
  if (Array.isArray(node)) return node.map((n) => toJsonSchema(n));
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  // Under `properties`, keys are property names, not keywords: keep them all.
  const keysAreKeywords = parentKey !== 'properties';
  for (const [key, value] of Object.entries(node)) {
    if (keysAreKeywords && (key === 'description' || key === 'discriminator')) continue;
    if (key === '$ref' && typeof value === 'string' && value.startsWith(SCHEMA_REF_PREFIX)) {
      out[key] = `#/$defs/${value.slice(SCHEMA_REF_PREFIX.length)}`;
    } else {
      out[key] = toJsonSchema(value, key);
    }
  }
  return out;
}

/**
 * Modelina emits declarations like `interface Foo { ... }` or
 * `type Foo = A | B;` without `export`. Add it.
 */
function exportify(decl: string): string {
  const trimmed = decl.trimStart();
  if (trimmed.startsWith('export ')) return decl;
  return `export ${trimmed}`;
}

function quote(s: string): string {
  // execSync runs through cmd.exe on Windows, which does NOT strip single
  // quotes -- prettier would receive a filename containing literal quote chars
  // ("No files matching the pattern"). Use double quotes there; POSIX shells
  // get single-quote escaping.
  if (process.platform === 'win32') {
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  return `'${s.replace(/'/g, "'\\''")}'`;
}

main().catch((err) => {
  console.error('[generate-messages] failed:', err);
  process.exit(1);
});
