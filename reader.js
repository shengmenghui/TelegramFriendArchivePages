export class Reader {
  constructor() { this.pending = new Map(); this.serial = 0; this.generation = 0; this.worker = null; }
  async unlock(password) {
    this.lock();
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = event => {
      const pending = this.pending.get(event.data.id);
      if (!pending) return;
      this.pending.delete(event.data.id);
      event.data.error ? pending.reject(new Error(event.data.error)) : pending.resolve(event.data.result);
    };
    this.worker.onerror = () => this.lock();
    return this.call('unlock', { password, base: new URL('./', import.meta.url).href });
  }
  call(method, payload = {}) {
    if (!this.worker) return Promise.reject(new Error('请先输入密码解锁'));
    const id = ++this.serial;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.worker.postMessage({ id, method, payload }); });
  }
  api(path) {
    const url = new URL(path, location.origin), method = url.pathname.split('/').at(-1);
    return this.call(method, Object.fromEntries(url.searchParams));
  }
  lock() {
    this.generation++;
    this.worker?.terminate(); this.worker = null;
    for (const { reject } of this.pending.values()) reject(new DOMException('页面已锁定', 'AbortError'));
    this.pending.clear();
  }
}
