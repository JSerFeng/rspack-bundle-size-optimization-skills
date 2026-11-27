const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { CDP, targetSocket } = require('./cdp.cjs');
const { fail, fingerprint, json } = require('./common.cjs');
const { readinessJs, navigate, isNavigationTransition } = require('./page.cjs');

const mobileNetwork = { offline: false, latency: 150, downloadThroughput: 200000, uploadThroughput: 94000 };
const paints = ['fcpMs', 'lcpMs'];

function paintObserver(key) {
  return `(() => {
    if (window !== window.top) return;
    const state = globalThis[${key}] = {
      lcpMs: null, lcpElement: null, becameHidden: document.visibilityState !== 'visible',
    };
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') state.becameHidden = true;
    };
    const observeLcp = (entries) => {
      for (const entry of entries) {
        state.lcpMs = entry.startTime;
        state.lcpElement = { tag: entry.element?.localName ?? null, size: entry.size };
      }
    };
    const observer = new PerformanceObserver(list => observeLcp(list.getEntries()));
    observer.observe({ type: 'largest-contentful-paint', buffered: true });
    document.addEventListener('visibilitychange', onVisibility);
    state.flush = () => observeLcp(observer.takeRecords());
    state.stop = () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      delete globalThis[${key}];
    };
  })()`;
}

async function samplePaint(cdp, options, expression, tracker) {
  tracker.reset();
  const initialLoader = (await cdp.send('Page.getFrameTree')).frameTree.frame.loaderId;
  tracker.start(initialLoader);
  const previousLoader = await navigate(cdp, options.url, options.cache);
  tracker.setIgnoreLoader(previousLoader);
  const deadline = performance.now() + options.timeout;
  let measuredLoader;
  let stableSince = null;
  let lastLcp = null;
  let sample;

  while (performance.now() < deadline) {
    try {
      const { frameTree } = await cdp.send('Page.getFrameTree');
      const { loaderId } = frameTree.frame;
      if (measuredLoader && measuredLoader !== loaderId)
        fail('UNEXPECTED_NAVIGATION', 'The measured document changed during a sample.');
      if (loaderId !== previousLoader) {
        const evaluation = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
        if (evaluation.exceptionDetails)
          fail('READINESS_FAILED', evaluation.exceptionDetails.exception?.description || evaluation.exceptionDetails.text);
        sample = evaluation.result.value;
        if (sample) measuredLoader = loaderId;
        if (sample?.becameHidden)
          fail('PAGE_HIDDEN', 'Keep the measured Chrome tab visible throughout each navigation.');
        if (sample?.responseStatus >= 400)
          fail('NAVIGATION_FAILED', `The measured page returned HTTP ${sample.responseStatus}.`);
        if (sample?.ready && sample.url !== options.url)
          fail('UNEXPECTED_URL', 'The measured page finished on a different URL.', { actual: sample.url });

        if (sample?.ready && paints.every(name => Number.isFinite(sample[name]) && sample[name] > 0)) {
          const now = performance.now();
          if (stableSince === null || sample.lcpMs !== lastLcp) stableSince = now;
          lastLcp = sample.lcpMs;
          if (now - stableSince >= options.settleMs) {
            const { fcpMs, lcpMs, lcpElement, viewport } = sample;
            const diagnostics = tracker.snapshot();
            return { fcpMs, lcpMs, lcpElement, viewport, diagnostics };
          }
        } else {
          stableSince = null;
        }
      }
    } catch (error) {
      if (!isNavigationTransition(error)) throw error;
      stableSince = null;
    }
    await sleep(50);
  }

  fail('MEASUREMENT_TIMEOUT', 'The measured page did not reach a loaded, ready state with stable FCP/LCP.', {
    ready: sample?.ready ?? false,
    fcpMs: sample?.fcpMs ?? null,
    lcpMs: sample?.lcpMs ?? null,
    diagnostics: tracker.snapshot(),
  });
}

async function measurePaint({ endpoint, target, runs, onProgress, ...options }) {
  const cdp = await CDP.connect(await targetSocket(endpoint, target));
  const progress = typeof onProgress === 'function' ? onProgress : () => {};
  const targetOrigin = new URL(options.url).origin;
  const requests = new Map();
  let active = false; let ignoreLoader = null;
  let failedAssets = 0; let pageErrors = 0;
  const isSameOriginAsset = row => {
    if (!row || (row.type !== 'Script' && row.type !== 'Stylesheet')) return false;
    try { return new URL(row.url).origin === targetOrigin; } catch { return false; }
  };
  cdp.on('Network.requestWillBeSent', event => {
    if (!active || (ignoreLoader && event.loaderId === ignoreLoader)) return;
    requests.set(event.requestId, { url: event.request.url, type: event.type, failed: false });
  });
  cdp.on('Network.responseReceived', event => {
    if (!active) return;
    const row = requests.get(event.requestId);
    if (row && !row.failed && event.response.status >= 400 && isSameOriginAsset(row)) {
      row.failed = true; failedAssets++;
    }
  });
  cdp.on('Network.loadingFailed', event => {
    if (!active || event.canceled) return;
    const row = requests.get(event.requestId);
    if (row && !row.failed && isSameOriginAsset(row)) {
      row.failed = true; failedAssets++;
    }
  });
  cdp.on('Runtime.exceptionThrown', () => {
    if (active) pageErrors++;
  });
  const tracker = {
    reset() { active = false; ignoreLoader = null; requests.clear(); failedAssets = 0; pageErrors = 0; },
    start(prevLoader) { ignoreLoader = prevLoader; active = true; },
    setIgnoreLoader(prevLoader) { ignoreLoader = prevLoader; },
    snapshot() { active = false; return { failedAssets, pageErrors }; },
  };
  const key = json(`__rspackPaint_${randomUUID()}`);
  const expression = `(() => {
    const state = globalThis[${key}];
    if (!state) return null;
    state.flush();
    const nav = performance.getEntriesByType('navigation')[0];
    return {
      url: location.href,
      ready: nav?.loadEventEnd > 0 && Boolean(${readinessJs(options.boundary)}),
      responseStatus: nav?.responseStatus,
      becameHidden: state.becameHidden || document.visibilityState !== 'visible',
      fcpMs: performance.getEntriesByName('first-contentful-paint', 'paint')[0]?.startTime ?? null,
      lcpMs: state.lcpMs,
      lcpElement: state.lcpElement,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    };
  })()`;
  let scriptId;
  try {
    const { product, userAgent } = await cdp.send('Browser.getVersion');
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.bringToFront');
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: options.cache === 'cold' });
    if (options.throttle === 'mobile') {
      await cdp.send('Network.emulateNetworkConditions', mobileNetwork);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    }
    const script = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: paintObserver(key) });
    scriptId = script.identifier;

    const warmup = await samplePaint(cdp, options, expression, tracker);
    progress(`warmup: fcp=${Math.round(warmup.fcpMs)}ms lcp=${Math.round(warmup.lcpMs)}ms${warmup.diagnostics.failedAssets || warmup.diagnostics.pageErrors ? ` (failedAssets=${warmup.diagnostics.failedAssets} pageErrors=${warmup.diagnostics.pageErrors})` : ''}`);
    const samples = [];
    for (let i = 0; i < runs; i++) {
      const sample = await samplePaint(cdp, options, expression, tracker);
      if (fingerprint(sample.viewport) !== fingerprint(warmup.viewport))
        fail('VIEWPORT_CHANGED', 'The Chrome viewport changed during the measurement.');
      progress(`run ${i + 1}/${runs}: fcp=${Math.round(sample.fcpMs)}ms lcp=${Math.round(sample.lcpMs)}ms${sample.diagnostics.failedAssets || sample.diagnostics.pageErrors ? ` (failedAssets=${sample.diagnostics.failedAssets} pageErrors=${sample.diagnostics.pageErrors})` : ''}`);
      samples.push(sample);
    }
    const conditions = {
      ...options,
      browser: { product, userAgent },
      platform: os.platform(),
      arch: os.arch(),
      cpu: os.cpus()[0]?.model ?? null,
      viewport: warmup.viewport,
    };
    return { conditions, samples };
  } finally {
    if (scriptId) {
      await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId }).catch(() => {});
      await cdp.send('Runtime.evaluate', { expression: `globalThis[${key}]?.stop?.()` }).catch(() => {});
    }
    if (options.throttle === 'mobile') {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {});
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
      }).catch(() => {});
    }
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: false }).catch(() => {});
    await cdp.close();
  }
}

function summarizePaint(samples) {
  if (!Array.isArray(samples) || samples.length < 3 ||
      !samples.every(sample => paints.every(name => Number.isFinite(sample?.[name]) && sample[name] > 0)))
    fail('INVALID_BASELINE', 'Paint reports require at least three valid FCP/LCP samples.');

  return Object.fromEntries(paints.map(name => {
    const sorted = samples.map(sample => sample[name]).sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    return [name, median];
  }));
}

function comparePaint(baseline, candidate) {
  const metrics = Object.fromEntries(paints.map(name => {
    const baselineMs = baseline[name];
    const candidateMs = candidate[name];
    const deltaMs = candidateMs - baselineMs;
    const thresholdMs = Math.max(30, baselineMs * 0.02);
    let status = 'within-noise';
    if (deltaMs >= thresholdMs) status = 'regressed';
    else if (deltaMs <= -thresholdMs) status = 'improved';
    return [name, { baselineMs, candidateMs, deltaMs, thresholdMs, status }];
  }));
  const states = Object.values(metrics).map(metric => metric.status);
  const status = ['regressed', 'improved', 'within-noise'].find(state => states.includes(state));
  return { status, metrics };
}

module.exports = { measurePaint, summarizePaint, comparePaint };
