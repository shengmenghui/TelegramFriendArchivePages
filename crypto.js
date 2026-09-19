const encoder = new TextEncoder();
export const idPattern = /^[a-f0-9]{32}$/;
const decode64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
export async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
}
export function validateBootstrap(b) {
  if (b?.format !== 'TFA1' || !idPattern.test(b.dataset_id) || !idPattern.test(b.manifest?.id) ||
      b.kdf?.name !== 'PBKDF2' || b.kdf.hash !== 'SHA-256' || b.kdf.iterations !== 600000 ||
      decode64(b.kdf.salt).length !== 16 || decode64(b.wrap_nonce).length !== 12 || decode64(b.wrapped_key).length !== 48) {
    throw new Error('网站加密格式不受支持或已损坏');
  }
}
export async function unlock(b, password) {
  validateBootstrap(b);
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  const kek = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: decode64(b.kdf.salt), iterations: 600000, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['unwrapKey']);
  try {
    return await crypto.subtle.unwrapKey('raw', decode64(b.wrapped_key), kek,
      { name: 'AES-GCM', iv: decode64(b.wrap_nonce), additionalData: encoder.encode(`TFA1|key|${b.dataset_id}`), tagLength: 128 },
      { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  } catch {
    throw new Error('密码不正确，或网站密钥数据已损坏');
  }
}
export async function decryptObject(key, dataset, descriptor, encrypted) {
  if (!idPattern.test(descriptor.id) || encrypted.byteLength !== descriptor.bytes ||
      await sha256(encrypted) !== descriptor.sha256) throw new Error('下载文件校验失败，请重试或检查更新');
  let data;
  try {
    data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: encrypted.slice(0, 12), tagLength: 128,
      additionalData: encoder.encode(`TFA1|object|${dataset}|${descriptor.id}`) }, key, encrypted.slice(12));
  } catch {
    throw new Error('内容认证失败，文件可能损坏；已停止显示');
  }
  if (descriptor.encoding === 'gzip') {
    data = await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  } else if (descriptor.encoding !== 'identity') throw new Error('未知数据编码');
  if (descriptor.plain_sha256 && await sha256(data) !== descriptor.plain_sha256) throw new Error('解密内容校验失败');
  return data;
}
