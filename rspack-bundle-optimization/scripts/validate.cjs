#!/usr/bin/env node
const { randomUUID } = require('node:crypto');
const { parseArgs } = require('node:util');
const { fs, path, fail, json, integer, readJson, fingerprint } = require('./lib/common.cjs');
const { firstScreenBoundary } = require('./lib/page.cjs');
const { measurePaint, summarizePaint, comparePaint } = require('./lib/paint.cjs');

const schemaVersion = 1;
const kind = 'rspack-paint-measurement';
const options = {
  endpoint: { type: 'string' },
  target: { type: 'string' },
  url: { type: 'string' },
  out: { type: 'string' },
  'ready-selector': { type: 'string' },
  'ready-expression': { type: 'string' },
  against: { type: 'string' },
  runs: { type: 'string' },
  timeout: { type: 'string' },
  'settle-ms': { type: 'string' },
  cache: { type: 'string' },
  throttle: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

function requireComparable(baseline, candidate) {
  const different = Object.keys(candidate)
    .filter(name => fingerprint(candidate[name]) !== fingerprint(baseline[name] ?? null));
  if (different.length)
    fail('INCOMPARABLE_RUNS', 'Measure both builds with the same page and browser conditions.', { different });
}

async function validate(args) {
  for (const name of ['endpoint', 'url', 'out']) {
    if (!args[name]) fail('INVALID_ARGUMENT', `--${name} is required.`);
  }
  const url = URL.parse(args.url);
  if (!url || !['http:', 'https:'].includes(url.protocol))
    fail('INVALID_ARGUMENT', '--url must be an HTTP or HTTPS page URL.');

  const destination = path.resolve(args.out);
  if (fs.existsSync(destination)) fail('OUTPUT_EXISTS', 'Measurement output already exists.');
  const settings = {
    url: url.href,
    boundary: firstScreenBoundary(args),
    cache: args.cache ?? 'cold',
    throttle: args.throttle ?? 'none',
    timeout: integer(args.timeout, 30000, 300000, 1, 'timeout'),
    settleMs: integer(args['settle-ms'], 1000, 30000, 100, 'settle-ms'),
  };
  if (settings.settleMs >= settings.timeout)
    fail('INVALID_ARGUMENT', '--settle-ms must be less than --timeout.');
  if (!['cold', 'warm'].includes(settings.cache))
    fail('INVALID_ARGUMENT', '--cache must be cold or warm.');
  if (!['none', 'mobile'].includes(settings.throttle))
    fail('INVALID_ARGUMENT', '--throttle must be none or mobile.');
  const runs = integer(args.runs, 3, 30, 3, 'runs');

  let baseline;
  if (args.against !== undefined) {
    const file = fs.realpathSync(args.against);
    const saved = readJson(file, 1024 * 1024);
    if (saved?.kind !== kind || saved.schemaVersion !== schemaVersion || saved.status !== 'complete' ||
        !saved.conditions || typeof saved.conditions !== 'object')
      fail('INVALID_BASELINE', 'Expected a complete paint report written by validate.cjs.');
    baseline = { file, conditions: saved.conditions, medians: summarizePaint(saved.samples) };
    requireComparable(baseline.conditions, settings);
  }
  const { conditions, samples } = await measurePaint({ ...settings, endpoint: args.endpoint, target: args.target, runs });
  if (baseline) requireComparable(baseline.conditions, conditions);
  const medians = summarizePaint(samples);
  const comparison = baseline && { baseline: baseline.file, ...comparePaint(baseline.medians, medians) };
  const report = { schemaVersion, kind, status: 'complete', conditions, samples, medians, comparison: comparison ?? null };

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const pending = `${destination}.${randomUUID()}.incomplete`;
  fs.writeFileSync(pending, json(report), { flag: 'wx' });
  try { fs.linkSync(pending, destination); }
  finally { fs.unlinkSync(pending); }
  return { ok: true, schemaVersion, report: destination, runs, medians, comparison: comparison ?? null };
}

async function main(argv = process.argv.slice(2)) {
  let args;
  try { args = parseArgs({ args: argv, options }).values; }
  catch (error) { fail('INVALID_ARGUMENT', error.message); }
  if (args.help) return {
    ok: true,
    usage: 'node <skill>/scripts/validate.cjs --endpoint <Chrome-debugging-HTTP-URL-or-page-WebSocket> --url <URL> --ready-selector <selector> --out <report.json> [--against <baseline.json>]',
    options: ['target', 'ready-expression', 'runs 3..30', 'timeout ms', 'settle-ms ms', 'cache cold|warm', 'throttle none|mobile'],
  };
  return validate(args);
}

if (require.main === module) main().then(result => {
  process.stdout.write(`${json(result)}\n`);
  if (result.comparison?.status === 'regressed') process.exitCode = 1;
}, error => {
  const { code = 'MEASUREMENT_FAILED', message, details } = error;
  process.stdout.write(`${json({ ok: false, schemaVersion, error: { code, message, details } })}\n`);
  process.exitCode = 1;
});

module.exports = { main };
