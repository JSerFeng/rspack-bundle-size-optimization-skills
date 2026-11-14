const { EventEmitter } = require('node:events');
const { fail } = require('./common.cjs');

class CDP extends EventEmitter {
  constructor(socket) {
    super(); this.socket = socket; this.sequence = 0; this.pending = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id); if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(Object.assign(new Error(message.error.message), { code: 'CDP_ERROR' }));
        else pending.resolve(message.result);
      } else if (message.method) this.emit(message.method, message.params);
    });
    const closed = () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(Object.assign(new Error('Chrome debugging connection closed.'), { code: 'CDP_CLOSED' })); }
      this.pending.clear();
    };
    socket.addEventListener('close', closed); socket.addEventListener('error', closed);
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(Object.assign(new Error('Chrome connection timed out.'), { code: 'CDP_TIMEOUT' })); }, 10000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(Object.assign(new Error('Unable to connect to Chrome.'), { code: 'CDP_ERROR' })); }, { once: true });
    });
    return new CDP(socket);
  }
  send(method, params = {}) {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(Object.assign(new Error('Chrome is disconnected.'), { code: 'CDP_CLOSED' }));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error(`${method} timed out.`), { code: 'CDP_TIMEOUT' })); }, 15000);
      this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise(resolve => { this.socket.addEventListener('close', resolve, { once: true }); this.socket.close(); });
  }
}
async function targetSocket(endpoint, target) {
  if (/^wss?:/.test(endpoint)) {
    if (!/\/devtools\/page\//.test(endpoint)) fail('INVALID_ARGUMENT', 'Use a page WebSocket URL, not the browser WebSocket URL.');
    return endpoint;
  }
  const response = await fetch(new URL('/json/list', endpoint), { signal: AbortSignal.timeout(10000) });
  if (!response.ok) fail('CDP_ERROR', `Chrome target listing returned HTTP ${response.status}.`);
  const pages = (await response.json()).filter(item => item.type === 'page' && item.webSocketDebuggerUrl);
  const selected = target ? pages.find(item => item.id === target) : pages.length === 1 ? pages[0] : null;
  if (!selected) fail('INVALID_ARGUMENT', 'Select one Chrome page with --target.', { totalPages: pages.length, pages: pages.slice(0, 20).map(item => ({ id: item.id, url: item.url })) });
  return selected.webSocketDebuggerUrl;
}
module.exports = { CDP, targetSocket };
