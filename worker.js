import { unlock, decryptObject, idPattern } from './crypto.js';

let key = null, bootstrap = null, manifest = null, catalogue = null, byId = null, searchIndex = null;
let root;
const cache = new Map(), pending = new Map();
const decoder = new TextDecoder();
let inFlight = 0;
const queue = [];
async function limitedFetch(url, options) {
  if (inFlight >= 4) await new Promise(resolve => queue.push(resolve));
  inFlight++;
  try {
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(response.status === 404 ? '网站版本可能已更新，请检查更新并重新解锁' : `下载失败（${response.status}），请重试`);
    return await response.arrayBuffer();
  } finally { inFlight--; queue.shift()?.(); }
}
async function object(id, override) {
  const descriptor = override || manifest?.objects?.[id];
  if (!descriptor || !idPattern.test(id)) throw new Error('归档引用无效');
  const encrypted = await limitedFetch(new URL(`objects/${id}.bin`, root), { cache: 'force-cache', credentials: 'omit', referrerPolicy: 'no-referrer' });
  return decryptObject(key, bootstrap.dataset_id, descriptor, encrypted);
}
async function jsonObject(id, keep = true, override) {
  if (cache.has(id)) { const value = cache.get(id); cache.delete(id); cache.set(id, value); return value; }
  if (pending.has(id)) return pending.get(id);
  const loading = (async () => {
    const value = JSON.parse(decoder.decode(await object(id, override)));
    if (keep) { cache.set(id, value); while (cache.size > 12) cache.delete(cache.keys().next().value); }
    return value;
  })();
  pending.set(id, loading);
  try { return await loading; } finally { pending.delete(id); }
}
async function boot() {
  const bytes = await limitedFetch(new URL(`bootstrap.json?check=${Date.now()}`, root), { cache: 'no-store', credentials: 'omit' });
  return JSON.parse(decoder.decode(bytes));
}
async function record(row) {
  if (!row) throw new Error('此消息未保存在当前归档');
  const records = await jsonObject(row.shard);
  const value = records[row.index];
  if (value?.record_id !== row.id) throw new Error('消息定位校验失败');
  return value;
}
function matches(row, q) {
  return (!q.platform || q.platform === 'all' || row.platform === q.platform) &&
    (!q.sender_role || row.sender === q.sender_role) &&
    (!q.conversation_id || `${row.platform}\u001f${row.conversation}` === q.conversation_id) &&
    (!q.topic_class || row.topic === q.topic_class) &&
    (!q.deleted || row.deleted === (q.deleted === 'true')) &&
    (!q.media_type || row.media.includes(q.media_type)) &&
    (!q.date_from || (row.date && row.date >= q.date_from)) && (!q.date_to || (row.date && row.date <= q.date_to));
}
const bounded = (n, fallback, max) => Math.max(1, Math.min(max, Number(n) || fallback));
async function hydrate(rows) {
  const result = [];
  // Bound decoded shard memory even when search hits many different months.
  for (const row of rows) result.push(await record(row));
  return result;
}
async function messages(q) {
  const limit = bounded(q.limit, 100, 200);
  if (q.around) {
    const target = byId.get(q.around);
    if (!target) throw new Error('此消息未保存在当前归档');
    const same = catalogue.filter(row => row.platform === target.platform && row.conversation === target.conversation);
    const position = same.findIndex(row => row.id === q.around);
    const half = Math.floor(limit / 2), start = Math.max(0, position - half), rows = same.slice(start, position + half + 1);
    return { items: await hydrate(rows), has_older: start > 0, has_newer: position + half + 1 < same.length,
      oldest_row_id: rows[0]?.row, newest_row_id: rows.at(-1)?.row,
      conversation: `${target.platform}\u001f${target.conversation}` };
  }
  const all = catalogue.filter(row => matches(row, q) && (q.platform === 'manual' || row.type === 'message'));
  let rows = all.filter(row => (!q.before || row.row < Number(q.before)) && (!q.after || row.row > Number(q.after)));
  rows = q.after ? rows.slice(0, limit) : rows.slice(-limit);
  return { items: await hydrate(rows), oldest_row_id: rows[0]?.row, newest_row_id: rows.at(-1)?.row,
    has_older: !!rows.length && all[0]?.row < rows[0].row, has_newer: !!rows.length && all.at(-1)?.row > rows.at(-1).row };
}
function fold(s) { return String(s).toLowerCase().replaceAll('ß', 'ss').replaceAll('ς', 'σ'); }
async function search(q) {
  if (!searchIndex) searchIndex = await jsonObject(manifest.search, false);
  const term = fold(String(q.q || '').trim().slice(0, 200));
  if (!term) return { items: [], has_more: false, next_offset: 0 };
  const matching = [];
  for (const [id, text] of searchIndex) {
    const row = byId.get(id);
    if (row && matches(row, q) && text.includes(term)) matching.push({ row, text });
  }
  matching.sort((a, b) => (b.row.time || '').localeCompare(a.row.time || '') || b.row.row - a.row.row);
  const offset = Math.max(0, Number(q.offset) || 0), limit = bounded(q.limit, 80, 200);
  const page = matching.slice(offset, offset + limit), items = [];
  for (const hit of page) {
    const position = hit.text.indexOf(term), value = await record(hit.row);
    items.push({ ...value, match_context: hit.text.slice(Math.max(0, position - 70), position + term.length + 150) });
  }
  return { items, has_more: offset + limit < matching.length, next_offset: offset + items.length, total: matching.length };
}
async function handle(method, payload) {
  if (method === 'unlock') {
    root = new URL(payload.base);
    if (root.origin !== self.location.origin) throw new Error('不允许跨站读取归档');
    bootstrap = await boot();
    key = await unlock(bootstrap, payload.password);
    payload.password = '';
    manifest = await jsonObject(bootstrap.manifest.id, false, bootstrap.manifest);
    if (manifest.format !== 'TFA1') throw new Error('归档格式错误');
    const publication = JSON.parse(decoder.decode(await limitedFetch(new URL('publication.json', root), { cache: 'no-store', credentials: 'omit' })));
    if (publication.manifest_id !== bootstrap.manifest.id || !Number.isFinite(Date.parse(publication.built_at_utc))) {
      throw new Error('网站版本正在更新，请稍后重新解锁');
    }
    manifest.meta.published_at_utc = publication.built_at_utc;
    catalogue = await jsonObject(manifest.catalogue, false);
    byId = new Map(catalogue.map(row => [row.id, row]));
    return manifest.meta;
  }
  if (!key || !manifest) throw new Error('请先输入密码解锁');
  if (method === 'meta') return manifest.meta;
  if (method === 'messages') return messages(payload);
  if (method === 'search') return search(payload);
  if (method === 'message') return record(byId.get(payload.id));
  if (method === 'history') {
    const value = await record(byId.get(payload.id));
    return value.history_object ? (await jsonObject(value.history_object))[payload.id] : {};
  }
  if (method === 'media') {
    const image = manifest.images[payload.id];
    if (!image) throw new Error('图片未保存在归档中');
    const original = payload.original === true;
    return { data: await object(original ? image.original : image.thumbnail), mime: original ? image.mime_type : 'image/webp' };
  }
  if (method === 'check') {
    const latest = await boot();
    return { changed: latest.manifest.id !== bootstrap.manifest.id || latest.dataset_id !== bootstrap.dataset_id };
  }
  throw new Error('未知读取操作');
}
self.addEventListener('message', async event => {
  const { id, method, payload = {} } = event.data;
  try {
    const result = await handle(method, payload);
    self.postMessage({ id, result }, result?.data instanceof ArrayBuffer ? [result.data] : []);
  } catch (error) {
    self.postMessage({ id, error: error.message || '读取失败' });
  }
});
