#!/usr/bin/env node
// Materialize source and nearest-package evidence for side-effect bailout rows.
// This tool deliberately makes no purity decision.

const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} = require('fs');
const { createHash } = require('crypto');
const { basename, dirname, isAbsolute, relative, resolve } = require('path');
const { tmpdir } = require('os');

const SIDE_EFFECT_RE = /side[_ ]effects in source code/i;
const LOC_RE = /at\s+(.+?):(\d+):(\d+)/;

function parseArgs(argv) {
  const result = {};
  for (let i = 2; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) result[key] = true;
    else { result[key] = next; i += 1; }
  }
  return result;
}

function canonicalPath(value, root) {
  const absolute = isAbsolute(value) ? resolve(value) : resolve(root, value);
  try { return realpathSync.native(absolute); } catch { return absolute; }
}

function hashBuffer(value) {
  return createHash('sha256').update(value).digest('hex');
}

function findNearestPackageJson(resource, projectRoot) {
  let current = dirname(resource);
  const stop = dirname(resolve(projectRoot));
  while (current && current !== stop) {
    const candidate = resolve(current, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function pickPackageMetadata(packageJson) {
  if (!packageJson) return null;
  const raw = readFileSync(packageJson);
  const parsed = JSON.parse(raw.toString('utf8'));
  return {
    packageJson,
    packageJsonHash: hashBuffer(raw),
    name: parsed.name ?? null,
    version: parsed.version ?? null,
    type: parsed.type ?? null,
    sideEffects: Object.prototype.hasOwnProperty.call(parsed, 'sideEffects') ? parsed.sideEffects : 'field-absent',
    main: parsed.main ?? null,
    module: parsed.module ?? null,
    browser: parsed.browser ?? null,
    exports: parsed.exports ?? null,
  };
}

function qualityFor(source) {
  const lines = source.split('\n');
  const maxLineLength = lines.reduce((max, line) => Math.max(max, line.length), 0);
  return {
    lineCount: lines.length,
    maxLineLength,
    probablyMinified: lines.length <= 5 && maxLineLength > 2000,
  };
}

function loadPostLoaderSources(jsonlPath, projectRoot) {
  const result = new Map();
  if (!jsonlPath) return result;
  if (!existsSync(jsonlPath)) throw new Error(`Missing post-loader source capture: ${jsonlPath}`);
  for (const line of readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean)) {
    const row = JSON.parse(line);
    if (!row.path || typeof row.source !== 'string') continue;
    result.set(canonicalPath(row.path, projectRoot), row);
  }
  return result;
}

function buildWorklist({ summaryPath, outPath, projectRoot, postLoaderSources = new Map() }) {
  if (!existsSync(summaryPath)) throw new Error(`Missing summary: ${summaryPath}`);
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  const outDir = dirname(outPath);
  const sourceDir = resolve(outDir, 'review-sources');
  const postLoaderDir = resolve(outDir, 'review-post-loader-sources');
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(postLoaderDir, { recursive: true });

  const sourceRows = Array.isArray(summary.retainedUnusedEntries) ? summary.retainedUnusedEntries : [];
  const entries = sourceRows
    .filter((entry) => (entry.sideEffectBailouts || entry.bailouts || []).some((value) => SIDE_EFFECT_RE.test(value)))
    .map((entry, index) => {
      const resource = canonicalPath(entry.resource || entry.relResource, projectRoot);
      if (!existsSync(resource)) {
        return {
          index,
          resource,
          relativeResource: relative(projectRoot, resource),
          moduleSize: Number(entry.size || 0),
          error: 'source file is missing',
          verdict: null,
        };
      }
      const source = readFileSync(resource, 'utf8');
      const sourceHash = hashBuffer(Buffer.from(source));
      const sourceArtifact = resolve(sourceDir, `${String(index + 1).padStart(4, '0')}-${sourceHash.slice(0, 12)}-${basename(resource)}.txt`);
      writeFileSync(sourceArtifact, source);
      const postLoader = postLoaderSources.get(resource);
      let postLoaderArtifact = null;
      let postLoaderSourceHash = null;
      if (postLoader) {
        postLoaderSourceHash = hashBuffer(Buffer.from(postLoader.source));
        postLoaderArtifact = resolve(postLoaderDir, `${String(index + 1).padStart(4, '0')}-${postLoaderSourceHash.slice(0, 12)}-${basename(resource)}.txt`);
        writeFileSync(postLoaderArtifact, postLoader.source);
      }
      const packageJson = findNearestPackageJson(resource, projectRoot);
      const bailout = (entry.sideEffectBailouts || entry.bailouts || []).find((value) => SIDE_EFFECT_RE.test(value)) || '';
      const loc = LOC_RE.exec(bailout);
      return {
        index,
        resource,
        relativeResource: relative(projectRoot, resource),
        moduleSize: Number(entry.size || 0),
        isEntryModule: Boolean(entry.isEntryModule),
        bailout,
        bailoutLocation: loc ? { line: Number(loc[2]), column: Number(loc[3]) } : null,
        sourceHash,
        sourceBytes: Buffer.byteLength(source),
        sourceQuality: qualityFor(source),
        sourceArtifact: relative(outDir, sourceArtifact),
        postLoaderSourceAvailable: Boolean(postLoader),
        postLoaderSourceHash,
        postLoaderSourceBytes: postLoader ? Buffer.byteLength(postLoader.source) : 0,
        postLoaderSourceQuality: postLoader?.sourceQuality || (postLoader ? qualityFor(postLoader.source) : null),
        postLoaderSourceArtifact: postLoaderArtifact ? relative(outDir, postLoaderArtifact) : null,
        package: pickPackageMetadata(packageJson),
        reviewChecklist: [
          'read the complete source artifact',
          'classify every top-level statement and import-only execution path',
          'read the nearest package metadata and relevant entry/barrel declarations',
          'inspect importers that may depend on execution order',
          'record source and package evidence before choosing safe-experiment',
        ],
        verdict: null,
      };
    });

  const result = {
    version: 1,
    generatedAt: new Date().toISOString(),
    projectRoot,
    summaryPath,
    reviewCount: entries.length,
    postLoaderCaptureCount: entries.filter((entry) => entry.postLoaderSourceAvailable).length,
    missingPostLoaderCaptureCount: entries.filter((entry) => !entry.postLoaderSourceAvailable).length,
    warning: 'This is an evidence worklist, not a purity classifier. No row is safe until an agent reads its post-loader source, disk source, and package and writes a hash-pinned decision.',
    entries,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');

  const decisionTemplate = {
    version: 1,
    decisions: entries.map((entry) => ({
      resource: entry.resource,
      decision: 'unknown',
      packageJson: entry.package?.packageJson ?? null,
      sourceHash: entry.sourceHash ?? null,
      postLoaderSourceArtifact: entry.postLoaderSourceArtifact ? resolve(outDir, entry.postLoaderSourceArtifact) : null,
      postLoaderSourceHash: entry.postLoaderSourceHash ?? null,
      postLoaderSourceReadable: null,
      packageJsonHash: entry.package?.packageJsonHash ?? null,
      sourceEvidence: [],
      packageEvidence: [],
      reason: 'not reviewed',
      risk: 'unknown',
      reviewedAt: null,
    })),
  };
  const templatePath = resolve(outDir, 'side-effects-decisions.template.json');
  writeFileSync(templatePath, JSON.stringify(decisionTemplate, null, 2) + '\n');
  return { result, templatePath };
}

function selfTest() {
  const root = mkdtempSync(resolve(tmpdir(), 'side-effects-worklist-'));
  try {
    const source = resolve(root, 'src', 'pure.js');
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(resolve(root, 'package.json'), JSON.stringify({ name: 'fixture', sideEffects: false }));
    writeFileSync(source, 'export const value = 1;\n');
    const summaryPath = resolve(root, 'summary.json');
    writeFileSync(summaryPath, JSON.stringify({ retainedUnusedEntries: [{ resource: source, size: 24, sideEffectBailouts: ['Statement with side_effects in source code at ./src/pure.js:1:0'] }] }));
    const outPath = resolve(root, 'out', 'worklist.json');
    const postLoaderJsonl = resolve(root, 'post-loader-sources.jsonl');
    writeFileSync(postLoaderJsonl, `${JSON.stringify({ path: source, source: 'export const value = 1;\n', sourceQuality: { lineCount: 2 } })}\n`);
    const postLoaderSources = loadPostLoaderSources(postLoaderJsonl, root);
    const { result } = buildWorklist({ summaryPath, outPath, projectRoot: root, postLoaderSources });
    if (result.reviewCount !== 1 || result.postLoaderCaptureCount !== 1 || result.entries[0].package.name !== 'fixture' || result.entries[0].verdict !== null) {
      throw new Error('self-test assertion failed');
    }
    console.log('side-effects-review-worklist self-test passed');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args['self-test']) return selfTest();
  const projectRoot = canonicalPath(args['project-root'] || process.cwd(), process.cwd());
  const summaryPath = resolve(args.summary || 'retained-unused-side-effects-summary.json');
  const outPath = resolve(args.out || resolve(dirname(summaryPath), 'side-effects-review-worklist.json'));
  const postLoaderJsonl = args['post-loader-jsonl'] ? resolve(args['post-loader-jsonl']) : null;
  const postLoaderSources = loadPostLoaderSources(postLoaderJsonl, projectRoot);
  const { result, templatePath } = buildWorklist({ summaryPath, outPath, projectRoot, postLoaderSources });
  console.log(`reviewCount=${result.reviewCount}`);
  console.log(`wrote ${outPath}`);
  console.log(`decision template ${templatePath}`);
}

if (require.main === module) main();
module.exports = { buildWorklist, findNearestPackageJson, loadPostLoaderSources, main, pickPackageMetadata, qualityFor };
