#!/usr/bin/env node
const { parseArgs } = require('node:util');
const { fs, path, fail, json, integer } = require('./lib/common.cjs');
const { CDP, targetSocket } = require('./lib/cdp.cjs');

async function record(args) {
  for (const name of ['endpoint', 'url', 'out']) if (!args[name]) fail('INVALID_ARGUMENT', `--${name} is required.`);
  if (Boolean(args['ready-selector']) === Boolean(args['ready-expression'])) fail('INVALID_ARGUMENT', 'Specify exactly one --ready-selector or --ready-expression to define the first-screen boundary.');
  const destination = path.resolve(args.out);
  if (fs.existsSync(destination)) fail('OUTPUT_EXISTS', 'Recording output already exists.');
  const timeout = integer(args.timeout, 30000, 300000, 1); const expression = args['ready-expression'] || `document.querySelector(${json(args['ready-selector'])}) !== null`;
  if (args.cache !== undefined && !['cold', 'warm'].includes(args.cache)) fail('INVALID_ARGUMENT', '--cache must be cold or warm.');
  const cache = args.cache || 'cold'; const cdp = await CDP.connect(await targetSocket(args.endpoint, args.target));
  const network = new Map(); const scripts = new Map(); const gaps = [];
  const startedAt = new Date().toISOString(); let started = false;
  cdp.on('Network.requestWillBeSent', event => network.set(event.requestId, { requestId: event.requestId, url: event.request.url, type: event.type, start: event.timestamp }));
  cdp.on('Network.responseReceived', event => {
    const row = network.get(event.requestId); if (row) Object.assign(row, { status: event.response.status, mimeType: event.response.mimeType,
      fromDiskCache: event.response.fromDiskCache || false, fromServiceWorker: event.response.fromServiceWorker || false });
  });
  cdp.on('Network.loadingFinished', event => { const row = network.get(event.requestId); if (row) Object.assign(row, { end: event.timestamp, encodedDataLength: event.encodedDataLength }); });
  cdp.on('Network.loadingFailed', event => { const row = network.get(event.requestId); if (row) Object.assign(row, { error: event.errorText }); });
  cdp.on('Debugger.scriptParsed', event => scripts.set(event.scriptId, event));
  try {
    const browser = await cdp.send('Browser.getVersion');
    await cdp.send('Page.enable'); await cdp.send('Network.enable'); await cdp.send('Debugger.enable'); await cdp.send('Profiler.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: cache === 'cold' });
    await cdp.send('Profiler.startPreciseCoverage', { detailed: true, callCount: true, allowTriggeredUpdates: false }); started = true;
    const previous = await cdp.send('Page.getFrameTree');
    const navigation = await cdp.send('Page.navigate', { url: args.url });
    if (navigation.errorText) fail('NAVIGATION_FAILED', navigation.errorText);
    if (!navigation.loaderId || navigation.loaderId === previous.frameTree.frame.loaderId)
      await cdp.send('Page.reload', { ignoreCache: cache === 'cold' });
    const deadline = Date.now() + timeout;
    while (true) {
      try {
        const tree = await cdp.send('Page.getFrameTree'); const frame = tree.frameTree.frame;
        if (frame.loaderId !== previous.frameTree.frame.loaderId) {
          const state = await cdp.send('Runtime.evaluate', { expression: `Boolean(${expression})`, returnByValue: true, awaitPromise: true });
          if (state.exceptionDetails) fail('READINESS_FAILED', state.exceptionDetails.exception?.description || state.exceptionDetails.text || 'Readiness expression failed.');
          if (state.result?.value === true) break;
        }
      } catch (error) { if (error.code !== 'CDP_ERROR' || !/context|navigat/i.test(error.message)) throw error; }
      if (Date.now() >= deadline) fail('RECORDING_TIMEOUT', 'First-screen readiness condition was not reached; no complete recording was written.');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const coverage = await cdp.send('Profiler.takePreciseCoverage');
    await cdp.send('Profiler.stopPreciseCoverage'); started = false;
    const captured = [];
    for (const script of coverage.result) {
      try {
        const source = await cdp.send('Debugger.getScriptSource', { scriptId: script.scriptId });
        captured.push({ ...script, url: script.url || scripts.get(script.scriptId)?.url || `debugger://script/${script.scriptId}`, text: source.scriptSource });
      } catch (error) { gaps.push({ kind: 'script-source', url: script.url, message: error.message }); }
    }
    gaps.push({ kind: 'recording-scope', message: 'Coverage is limited to the selected page isolate; workers and out-of-process frames are not included.' });
    const result = { schemaVersion: 1, kind: 'rspack-browser-recording', status: 'complete', scenario: args.scenario || 'first-screen',
      precision: 'per-block', startedAt, completedAt: new Date().toISOString(), url: args.url, browser,
      boundary: { selector: args['ready-selector'] ?? null, expression: args['ready-expression'] ?? null }, cache,
      scripts: captured, network: [...network.values()], gaps };
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const pending = `${destination}.${process.pid}.incomplete`;
    try { fs.writeFileSync(pending, json(result), { flag: 'wx' }); fs.linkSync(pending, destination); }
    finally { if (fs.existsSync(pending)) fs.unlinkSync(pending); }
    return { ok: true, schemaVersion: 1, recording: destination, precision: result.precision, counts: { scripts: captured.length, requests: network.size, gaps: gaps.length } };
  } finally {
    if (started) await cdp.send('Profiler.stopPreciseCoverage').catch(() => {});
    // Restore default cache behavior for the page we attached to.
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: false }).catch(() => {});
    await cdp.close();
  }
}
async function main(argv = process.argv.slice(2)) {
  let parsed;
  try { parsed = parseArgs({ args: argv, options: { ...Object.fromEntries(['endpoint', 'target', 'url', 'out', 'ready-selector', 'ready-expression', 'timeout', 'scenario', 'cache'].map(name => [name, { type: 'string' }])), help: { type: 'boolean', short: 'h' } } }); }
  catch (error) { fail('INVALID_ARGUMENT', error.message); }
  if (parsed.values.help) return { ok: true, usage: 'node <skill>/scripts/record.cjs --endpoint <Chrome-debugging-HTTP-URL-or-page-WebSocket> --url <URL> --ready-selector <selector> --out <recording.json>',
    options: ['target', 'ready-expression', 'timeout', 'scenario', 'cache cold|warm'], precision: 'per-block', scope: 'selected-page-isolate', note: 'Connect to an existing Chrome. No browser launch, Puppeteer, or report UI is required.' };
  return record(parsed.values);
}
if (require.main === module) main().then(result => process.stdout.write(`${json(result)}\n`), error => {
  process.stdout.write(`${json({ ok: false, schemaVersion: 1, error: { code: error.code || 'RECORDING_FAILED', message: error.message, ...(error.details ? { details: error.details } : {}) } })}\n`); process.exitCode = 1;
});
module.exports = { main, record };
