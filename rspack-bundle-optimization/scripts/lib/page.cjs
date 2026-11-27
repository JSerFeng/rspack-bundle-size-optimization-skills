const { fail, json } = require('./common.cjs');

function firstScreenBoundary(args) {
  const selector = args['ready-selector'] || null;
  const expression = args['ready-expression'] || null;
  if (Boolean(selector) === Boolean(expression))
    fail('INVALID_ARGUMENT', 'Specify exactly one --ready-selector or --ready-expression to define the first-screen boundary.');
  return { selector, expression };
}

function readinessJs({ selector, expression }) {
  return expression ?? `document.querySelector(${json(selector)}) !== null`;
}

async function navigate(cdp, url, cache) {
  const previous = (await cdp.send('Page.getFrameTree')).frameTree.frame.loaderId;
  const navigation = await cdp.send('Page.navigate', { url });
  if (navigation.errorText) fail('NAVIGATION_FAILED', navigation.errorText);
  // A fragment-only navigation has no new document and no new paint timings.
  if (!navigation.loaderId || navigation.loaderId === previous)
    await cdp.send('Page.reload', { ignoreCache: cache === 'cold' });
  return previous;
}

function isNavigationTransition(error) {
  return error.code === 'CDP_ERROR' && /context|navigat/i.test(error.message);
}

module.exports = { firstScreenBoundary, readinessJs, navigate, isNavigationTransition };
