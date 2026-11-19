import { loadConfig } from '../src/config.mjs';
import { jsonRequest } from '../src/http.mjs';

try {
  const config = await loadConfig(process.env, new URL('../.env', import.meta.url));
  console.log(`Node.js ${process.version}. Разрешённых пользователей: ${config.allowedIds.size}. GitHub: ${config.owner}.`);
  console.log(`ИИ: ${config.provider}, ${config.model}. Ключ: ${config.apiKey ? 'настроен' : 'не настроен, доступен поиск без ИИ'}.`);
  const checks = [
    ['Telegram', `https://api.telegram.org/bot${config.telegramToken}/getMe`, {}],
    ['GitHub', `https://api.github.com/users/${config.owner}/repos?per_page=1`, { headers: { 'User-Agent': 'RepoTelegramBot', ...(config.githubToken ? { Authorization: `Bearer ${config.githubToken}` } : {}) } }]
  ];
  if (config.apiKey) {
    if (config.provider === 'groq') checks.push(['Groq', 'https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${config.apiKey}` } }]);
    else if (config.provider === 'xai') checks.push(['Grok (xAI)', 'https://api.x.ai/v1/models', { headers: { Authorization: `Bearer ${config.apiKey}` } }]);
    else checks.push(['Gemini', `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}`, { headers: { 'x-goog-api-key': config.apiKey } }]);
  }
  for (const [service, url, options] of checks) {
    try {
      const result = await jsonRequest(url, { service, timeout: 10000, ...options });
      if (service === 'Telegram' && !result.ok) throw new Error('Telegram отклонил проверку токена.');
      if (['Groq', 'Grok (xAI)'].includes(service) && !result.data?.some(item => item.id === config.model)) throw new Error(`${service}: модель ${config.model} отсутствует в списке доступных для этого ключа. Проверь имя модели в .env.`);
      console.log(`${service}: OK${service === 'Telegram' ? ` (@${result.result.username})` : ''}`);
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
