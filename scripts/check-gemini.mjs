import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { jsonRequest, NetworkError } from '../src/http.mjs';
import { redact } from '../src/github.mjs';
import { writeJson } from '../src/storage.mjs';

export async function checkGemini({ config, root = new URL('../', import.meta.url), fetcher = fetch, logger = console }) {
  if (config.provider && config.provider !== 'gemini') throw new Error('Эта проверка только для Gemini. Для выбранного сервиса используй npm run doctor.');
  const report = { checkedAt: new Date().toISOString(), model: config.model, keyConfigured: Boolean(config.apiKey), checks: [] };
  const headers = { 'x-goog-api-key': config.apiKey, 'Content-Type': 'application/json' };
  const base = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}`;
  const check = async (name, url, options, summarize) => {
    const started = Date.now();
    try {
      const result = await jsonRequest(url, { service: 'Gemini', headers, ...options }, fetcher);
      const item = { name, ok: true, elapsedMs: Date.now() - started, ...summarize(result) };
      report.checks.push(item); logger.log(`${name}: OK (${(item.elapsedMs / 1000).toFixed(1)} с).`);
      return true;
    } catch (error) {
      let message = redact(error.message);
      if (config.apiKey) message = message.replaceAll(config.apiKey, '[KEY REMOVED]');
      report.checks.push({ name, ok: false, elapsedMs: Date.now() - started,
        type: error instanceof NetworkError ? error.timedOut ? 'timeout' : 'network' : 'api',
        status: error.status, code: error.code || error.providerCode, reason: error.reason, message });
      logger.error(`${name}: ${message}`); return false;
    }
  };
  if (!config.apiKey) report.checks.push({ name: 'configuration', ok: false, type: 'configuration', message: 'Ключ Gemini не настроен.' });
  else {
    const connected = await check('Доступ к модели', base, { timeout: 15000 }, result => ({
      supportsGenerateContent: result.supportedGenerationMethods?.includes('generateContent') ?? null
    }));
    if (connected) await check('Короткий ответ без кода проекта', `${base}:generateContent`, {
      timeout: 20000, method: 'POST', body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK.' }] }],
        generationConfig: { maxOutputTokens: 512,
          ...(/^gemini-(?:3|4)(?:[.-]|$)/.test(config.model) ? { thinkingConfig: { thinkingLevel: 'LOW' } } : {}) }
      })
    }, result => ({ returnedText: Boolean(result.candidates?.[0]?.content?.parts?.some(part => !part.thought && part.text)),
      finishReason: result.candidates?.[0]?.finishReason }));
  }
  await mkdir(new URL('data/', root), { recursive: true });
  await writeJson(new URL('data/gemini-check.json', root), report);
  logger.log('Проверка завершена. Результат сохранён в data/gemini-check.json.');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const config = await loadConfig(process.env, new URL('../.env', import.meta.url));
    const report = await checkGemini({ config });
    if (report.checks.some(item => !item.ok)) process.exitCode = 1;
  } catch (error) { console.error(redact(error.message)); process.exitCode = 1; }
}
