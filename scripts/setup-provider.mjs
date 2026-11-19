import { readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readSecret } from './setup-gemini.mjs';

export async function saveProviderKey(provider, key, root = new URL('../', import.meta.url)) {
  if (!['groq', 'xai'].includes(provider)) throw new Error('Выбери groq или xai.');
  if (!(provider === 'groq' ? /^gsk_[A-Za-z0-9_-]{16,}$/ : /^xai-[A-Za-z0-9_-]{16,}$/).test(key) || key.length > 512) throw new Error('Ключ не соответствует выбранному сервису. Скопируй полное значение без названия переменной.');
  const path = new URL('.env', root);
  if ((await lstat(path)).isSymbolicLink()) throw new Error('.env является ссылкой; запись отменена.');
  let text = await readFile(path, 'utf8');
  const values = { AI_PROVIDER: provider, [provider === 'groq' ? 'GROQ_API_KEY' : 'XAI_API_KEY']: key };
  for (const [name, value] of Object.entries(values)) {
    const pattern = new RegExp(`^[ \\t]*${name}[ \\t]*=[^\\r\\n]*`, 'gm');
    text = pattern.test(text) ? text.replace(pattern, `${name}=${value}`) : text.trimEnd() + `\n${name}=${value}\n`;
  }
  const temp = new URL(`.env.${randomUUID()}.tmp`, root);
  await writeFile(temp, text, { flag: 'wx', mode: 0o600 }); await rename(temp, path);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const provider = process.argv[2];
    if (!['groq', 'xai'].includes(provider)) throw new Error('Укажи groq или xai.');
    console.log(provider === 'groq' ? 'Настройка Groq (console.groq.com).' : 'Настройка Grok от xAI (console.x.ai).');
    process.stdout.write('Вставь полный API-ключ и нажми Enter (ввод скрыт): ');
    await saveProviderKey(provider, await readSecret());
    console.log('Ключ сохранён локально. Запусти restart.cmd.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
