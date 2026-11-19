export class ApiError extends Error {
  constructor(service, status, retryAfter = 0, { code, reason } = {}) {
    const hint = reason === 'API_KEY_INVALID' ? 'Google не принял ключ. Проверь его полное значение, включая точку в ключах AQ.'
      : status === 400 ? 'Проверь ключ и параметры запроса. Повтор без исправлений не поможет.'
      : status === 401 ? 'Проверь токен.' : status === 403 ? 'Нет доступа или исчерпан лимит запросов.' : status === 404 ? 'Не найдено или нет доступа.' : status === 409 ? 'Конфликт: проверь, не запущен ли второй экземпляр бота.' : status === 429 ? 'Превышен лимит запросов, попробуй позже.' : 'Попробуй позже.';
    super(`${service}: HTTP ${status}${code ? ` (${code}${reason ? `, ${reason}` : ''})` : ''}. ${hint}`);
    this.status = status;
    this.retryAfter = retryAfter;
    this.service = service;
    this.providerCode = code;
    this.reason = reason;
  }
}

export class NetworkError extends Error {
  constructor(service, error, timeout) {
    const timedOut = ['TimeoutError', 'AbortError'].includes(error?.name);
    const candidate = error?.cause?.code || error?.code || error?.cause?.errors?.[0]?.code;
    const code = timedOut ? 'REQUEST_TIMEOUT' : typeof candidate === 'string' && /^[A-Z][A-Z_0-9]{0,79}$/.test(candidate) ? candidate : 'FETCH_FAILED';
    super(timedOut ? `${service}: истекло время ожидания ответа (${timeout / 1000} с).` : `${service}: не удалось установить соединение (${code}).`);
    this.service = service; this.code = code; this.timedOut = timedOut;
  }
}

async function request(url, { service, timeout = 45000, signal, ...options }, fetcher) {
  let response;
  try { response = await fetcher(url, { ...options, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout), redirect: 'error' }); }
  catch (error) { if (signal?.aborted) throw error; throw new NetworkError(service, error, timeout); }
  if (!response.ok) {
    // Telegram returns retry_after in JSON; Gemini may use RetryInfo.retryDelay.
    let data;
    try { data = await response.json(); } catch { /* Do not expose remote error text. */ }
    const delay = data?.error?.details?.find(item => typeof item.retryDelay === 'string')?.retryDelay;
    const retryAfter = Number(response.headers.get('retry-after')) || Number(data?.parameters?.retry_after) || parseFloat(delay) || 0;
    const safeCode = value => typeof value === 'string' && /^[A-Z][A-Z_0-9]{0,79}$/.test(value) ? value : undefined;
    // Keep only machine-readable identifiers; provider messages may echo secrets.
    const code = service === 'Gemini' ? safeCode(data?.error?.status) : undefined;
    const reason = service === 'Gemini' ? safeCode(data?.error?.details?.find(item => item.reason)?.reason) : undefined;
    throw new ApiError(service, response.status, retryAfter, { code, reason });
  }
  return response;
}

export async function jsonRequest(url, options, fetcher = fetch) {
  const response = await request(url, options, fetcher);
  try { return await response.json(); }
  catch (error) {
    if (options.signal?.aborted) throw error;
    if (['TimeoutError', 'AbortError'].includes(error.name) || error.cause?.code) throw new NetworkError(options.service, error, options.timeout || 45000);
    throw new Error(`${options.service}: некорректный ответ сервера.`);
  }
}

export async function textRequest(url, { maxBytes = 100000, ...options }, fetcher = fetch) {
  const response = await request(url, options, fetcher);
  const reader = response.body?.getReader();
  if (!reader) return '';
  const parts = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error(`${options.service}: файл превышает лимит размера.`); }
      parts.push(value);
    }
    return Buffer.concat(parts).toString('utf8');
  } catch (error) {
    if (size > maxBytes) throw error;
    throw new Error(`${options.service}: не удалось загрузить файл.`);
  } finally { reader.releaseLock(); }
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
