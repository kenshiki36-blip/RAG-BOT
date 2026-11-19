import { appendFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { redact } from './github.mjs';

export async function createRuntimeLogger(directory, output = console) {
  await mkdir(directory, { recursive: true });
  let warned = false;
  const write = (level, values) => {
    const message = redact(values.map(value => value instanceof Error ? value.message : String(value)).join(' '));
    const line = `[${new Date().toISOString()}] ${message}`;
    output[level](line);
    try {
      appendFileSync(new URL(level === 'log' ? 'bot.stdout.log' : 'bot.stderr.log', directory), line + '\n', { encoding: 'utf8', mode: 0o600 });
    } catch {
      if (!warned) { warned = true; output.error('Не удалось записать журнал бота в data/.'); }
    }
  };
  return { log: (...values) => write('log', values), warn: (...values) => write('warn', values), error: (...values) => write('error', values) };
}
