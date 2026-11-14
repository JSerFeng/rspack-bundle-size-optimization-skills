const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BundleEvidencePlugin } = require('../capture-plugin.cjs');

let core = process.env.RSPACK_CORE_PATH;
if (!core) { try { core = require.resolve('@rspack/core'); } catch {} }
async function buildFixture(directory, options = {}, capture = true, sources = {}) {
  const { rspack } = require(core); let snapshot;
  fs.writeFileSync(path.join(directory, 'index.js'), "import { hot, cold } from './dep.js'; globalThis.api = { hot, cold }; hot(); globalThis.__READY__ = true;\n");
  fs.writeFileSync(path.join(directory, 'dep.js'), "import { leaf } from './leaf.js';\nexport function hot() { return leaf(); }\nexport function cold() { return 'cold'; }\n");
  fs.writeFileSync(path.join(directory, 'leaf.js'), "export function leaf() { return '热😀'; }\n");
  for (const [file, content] of Object.entries(sources)) fs.writeFileSync(path.join(directory, file), content);
  const compiler = rspack({ context: fs.realpathSync(directory), mode: 'production', entry: './index.js', devtool: 'hidden-source-map',
    output: { path: path.join(directory, 'dist'), filename: 'main.js' }, ...options,
    plugins: capture ? [new BundleEvidencePlugin({ directory: path.join(directory, 'capture'), onSnapshot: file => { snapshot = file; } })] : [] });
  try {
    const stats = await new Promise((resolve, reject) => compiler.run((error, value) => error ? reject(error) : resolve(value)));
    assert.equal(stats.hasErrors(), false, stats.toString({ errors: true }));
  } finally { await new Promise(resolve => compiler.close(resolve)); }
  if (capture) assert.ok(snapshot); return snapshot;
}

module.exports = { buildFixture, core };
