#!/usr/bin/env node
// Local-only static server for large bundle reports. It serves only files whose
// real paths remain inside the selected report root and supports byte ranges.

const { createReadStream, existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } = require('fs');
const { createServer } = require('http');
const { extname, resolve, sep } = require('path');
const { tmpdir } = require('os');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

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

function isWithin(root, file) {
  return file === root || file.startsWith(root.endsWith(sep) ? root : root + sep);
}

function safeResolve(root, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes('\0')) return null;
  const relative = decoded.replace(/^\/+/, '') || 'bundle-optimization-report.html';
  const candidate = resolve(root, relative);
  if (!isWithin(root, candidate) || !existsSync(candidate)) return null;
  let real;
  try { real = realpathSync.native(candidate); } catch { return null; }
  return isWithin(root, real) ? real : null;
}

function securityHeaders(response, file) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' blob:; worker-src blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'");
  response.setHeader('Cache-Control', extname(file) === '.json' ? 'no-store' : 'no-cache');
}

function parseRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value || '');
  if (!match) return null;
  let start = match[1] ? Number(match[1]) : null;
  let end = match[2] ? Number(match[2]) : null;
  if (start == null && end != null) { start = Math.max(0, size - end); end = size - 1; }
  else { start = start == null ? 0 : start; end = end == null ? size - 1 : Math.min(end, size - 1); }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) return null;
  return { start, end };
}

function createReportServer(root) {
  const realRoot = realpathSync.native(resolve(root));
  return createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/health') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method || 'GET')) {
      response.writeHead(405, { Allow: 'GET, HEAD' }); response.end('Method Not Allowed'); return;
    }
    const file = safeResolve(realRoot, url.pathname);
    if (!file || !statSync(file).isFile()) { response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); response.end('Not Found'); return; }
    const stat = statSync(file);
    const range = request.headers.range ? parseRange(request.headers.range, stat.size) : null;
    securityHeaders(response, file);
    response.setHeader('Content-Type', MIME[extname(file).toLowerCase()] || 'application/octet-stream');
    response.setHeader('Accept-Ranges', 'bytes');
    if (request.headers.range && !range) {
      response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); response.end(); return;
    }
    if (range) {
      response.writeHead(206, { 'Content-Length': range.end - range.start + 1, 'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}` });
      if (request.method === 'HEAD') return response.end();
      createReadStream(file, range).pipe(response);
    } else {
      response.writeHead(200, { 'Content-Length': stat.size });
      if (request.method === 'HEAD') return response.end();
      createReadStream(file).pipe(response);
    }
  });
}

function selfTest() {
  const root = mkdtempSync(resolve(tmpdir(), 'bundle-report-server-'));
  try {
    writeFileSync(resolve(root, 'bundle-optimization-report.html'), '<!doctype html>');
    if (!safeResolve(realpathSync(root), '/') || safeResolve(realpathSync(root), '/../etc/passwd')) throw new Error('path containment self-test failed');
    const range = parseRange('bytes=2-4', 10);
    if (!range || range.start !== 2 || range.end !== 4) throw new Error('range self-test failed');
    console.log('serve-bundle-report self-test passed');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args['self-test']) return selfTest();
  const root = resolve(args.root || process.cwd());
  if (!existsSync(resolve(root, 'bundle-optimization-report.html'))) throw new Error(`Report root is missing bundle-optimization-report.html: ${root}`);
  const host = String(args.host || '127.0.0.1');
  const port = Number(args.port || 4173);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid port: ${args.port}`);
  const server = createReportServer(root);
  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    console.log(`Bundle report: http://${host}:${actualPort}/`);
    console.log(`Serving only: ${realpathSync(root)}`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}
module.exports = { createReportServer, isWithin, parseRange, safeResolve };
