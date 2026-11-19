import { emitKeypressEvents } from 'node:readline';
import { lstat, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_MODEL } from '../src/config.mjs';

export async function saveGeminiKey(key, root = new URL('../', import.meta.url)) {
  if (!/^[A-Za-z0-9_.-]{20,512}$/.test(key)) throw new Error('Ключ должен содержать от 20 до 512 символов: буквы, цифры, точки, дефисы или подчёркивания.');
  if (key.startsWith('AQ') && !key.startsWith('AQ.')) throw new Error('Ключ нового формата Google должен начинаться с AQ. Скопируй ключ целиком, включая точку.');
  const path = new URL('.env', root);
  let text;
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Нельзя записать ключ: .env является ссылкой.');
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    text = await readFile(new URL('.env.example', root), 'utf8');
  }
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  for (const [name, value] of [['AI_PROVIDER', 'gemini'], ['GEMINI_API_KEY', key], ['GEMINI_MODEL', DEFAULT_MODEL]]) {
    // Do not consume the LF half of a preceding Windows CRLF line ending.
    const pattern = new RegExp(`^[ \\t]*${name}[ \\t]*=[^\\r\\n]*`, 'gm');
    text = pattern.test(text) ? text.replace(pattern, `${name}=${value}`) : `${text.replace(/\s*$/, '')}${newline}${name}=${value}${newline}`;
  }
  const temp = new URL(`.env.${randomUUID()}.tmp`, root);
  try {
    await writeFile(temp, text, { flag: 'wx', mode: 0o600 });
    await rename(temp, path);
  } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export function readSecret(input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !input.setRawMode) throw new Error('Открой setup-gemini.cmd двойным кликом или выполни npm run setup:gemini в терминале.');
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = error => {
      input.off('keypress', onKey);
      input.setRawMode(false);
      input.pause();
      output.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onKey = (text, key) => {
      if (key?.ctrl && key.name === 'c') return finish(new Error('Настройка отменена.'));
      if (key?.name === 'return' || key?.name === 'enter') return finish();
      if (key?.name === 'backspace') {
        if (value) { value = value.slice(0, -1); output.write('\b \b'); }
      } else if (text && !key?.ctrl && !key?.meta && /^[\x20-\x7e]+$/.test(text) && value.length + text.length <= 512) {
        value += text; output.write('*'.repeat(text.length));
      }
    };
    input.on('keypress', onKey);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log('Google AI Studio: https://aistudio.google.com/apikey');
    console.log('Используй ключ проекта с тарифом Free tier. Бот не подключает платный тариф.');
    process.stdout.write('Вставь ключ Gemini и нажми Enter (значение скрыто): ');
    const key = await readSecret();
    await saveGeminiKey(key);
    console.log('Ключ сохранён локально в .env. Перезапусти бота через start.cmd.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
