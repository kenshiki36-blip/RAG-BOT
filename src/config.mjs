import { readFile } from 'node:fs/promises';

export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

export function parseEnv(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z_0-9]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    result[match[1]] = value;
  }
  return result;
}

export async function loadConfig(env, path) {
  let file = {};
  try { file = parseEnv(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const values = { ...file, ...env };
  if (!values.TELEGRAM_BOT_TOKEN) throw new Error('Заполни TELEGRAM_BOT_TOKEN в .env');
  const ids = (values.ALLOWED_TELEGRAM_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (ids.some(id => !/^\d+$/.test(id))) throw new Error('ALLOWED_TELEGRAM_IDS: нужны числовые ID через запятую.');
  const publicAccess = (values.PUBLIC_ACCESS || 'false').toLowerCase();
  if (!['true', 'false'].includes(publicAccess)) throw new Error('PUBLIC_ACCESS: true or false.');
  const limit = (name, fallback, max) => {
    const value = Number(values[name] ?? fallback);
    if (!Number.isInteger(value) || value < 0 || value > max) throw new Error(`${name} должен быть целым числом от 0 до ${max}.`);
    return value;
  };
  // Daily caps for non-owners in public mode: AI questions cost the owner's API money.
  const publicDailyQuestions = limit('PUBLIC_DAILY_QUESTIONS', 20, 1000);
  const publicDailyIndexes = limit('PUBLIC_DAILY_INDEXES', 5, 100);
  const maxFiles = Number(values.MAX_FILES || 100);
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 500) throw new Error('MAX_FILES должен быть целым числом от 1 до 500.');
  const owner = values.GITHUB_OWNER || 'kenshiki36-blip';
  if (!/^[a-zA-Z0-9-]+$/.test(owner)) throw new Error('Некорректный GITHUB_OWNER.');
  const provider = (values.AI_PROVIDER || (values.GROQ_API_KEY ? 'groq' : (values.XAI_API_KEY || values.GROK_API_KEY) ? 'xai' : 'gemini')).toLowerCase();
  if (!['gemini', 'groq', 'xai'].includes(provider)) throw new Error('AI_PROVIDER: укажи gemini, groq или xai.');
  const model = provider === 'groq' ? values.GROQ_MODEL || 'openai/gpt-oss-20b' : provider === 'xai' ? values.XAI_MODEL || values.GROK_MODEL || 'grok-4.20-0309-non-reasoning' : values.GEMINI_MODEL || DEFAULT_MODEL;
  if (!(provider === 'gemini' ? /^[a-zA-Z0-9_.-]+$/ : /^[a-zA-Z0-9][a-zA-Z0-9_.-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9_.-]*)?$/).test(model)) throw new Error('Некорректное имя модели (GEMINI_MODEL, GROQ_MODEL или XAI_MODEL).');
  const aiTimeoutSeconds = Number(values.AI_TIMEOUT_SECONDS || values.GEMINI_TIMEOUT_SECONDS || 45);
  if (!Number.isInteger(aiTimeoutSeconds) || aiTimeoutSeconds < 5 || aiTimeoutSeconds > 120) throw new Error('GEMINI_TIMEOUT_SECONDS должен быть целым числом от 5 до 120.');
  return { telegramToken: values.TELEGRAM_BOT_TOKEN, allowedIds: new Set(ids), publicAccess: publicAccess === 'true', owner,
    githubToken: values.GITHUB_TOKEN || '', apiKey: provider === 'groq' ? values.GROQ_API_KEY || '' : provider === 'xai' ? values.XAI_API_KEY || values.GROK_API_KEY || '' : values.GEMINI_API_KEY || values.GOOGLE_API_KEY || '',
    provider, model, maxFiles, aiTimeoutSeconds, publicDailyQuestions, publicDailyIndexes };
}
