export function newRequestId(): string {
  const crypto = globalThis.crypto;
  if (crypto?.randomUUID) return crypto.randomUUID();
  if (!crypto?.getRandomValues) throw new Error('请通过 HTTPS 打开训练室。');
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function boundedFetch(input: RequestInfo | URL, init?: RequestInit, timeout = 12000): Promise<Response> {
  const controller = new AbortController();
  const signal = init?.signal;
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeout);
  return fetch(input, { ...init, signal: controller.signal }).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  });
}
