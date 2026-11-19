import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { ApiError, NetworkError, jsonRequest, sleep } from './http.mjs';
import { GitHub, redact } from './github.mjs';
import { Assistant } from './ai.mjs';
import { Bot, COMMANDS, splitMessage } from './bot.mjs';
import { readState, SnapshotStore, writeJson } from './storage.mjs';
import { acquireLock } from './lock.mjs';
import { LocalProject } from './local-project.mjs';
import { createRuntimeLogger } from './logging.mjs';

export async function runBot({ root = new URL('../', import.meta.url), env = process.env, fetcher = fetch,
  signal = new AbortController().signal, pause = sleep, logger = console } = {}) {
  const config = await loadConfig(env, new URL('.env', root));
  const dataDir = new URL('data/', root);
  await mkdir(dataDir, { recursive: true });
  const release = await acquireLock(new URL('bot.lock', dataDir));
  try {
    const statePath = new URL('state.json', dataDir);
    let disk = await readState(statePath);
    async function telegram(method, body, requestSignal) {
      const result = await jsonRequest(`https://api.telegram.org/bot${config.telegramToken}/${method}`, {
        service: 'Telegram', timeout: 50000, signal: requestSignal, method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      }, fetcher);
      if (!result.ok) throw new ApiError('Telegram', result.error_code || 500, result.parameters?.retry_after || 0);
      return result.result;
    }
    let nextSendAt = 0;
    async function send(chatId, text) {
      for (const part of splitMessage(text)) {
        await pause(Math.max(0, nextSendAt - Date.now()));
        for (let attempt = 0; ; attempt++) {
          try {
            await telegram('sendMessage', { chat_id: chatId, text: part, link_preview_options: { is_disabled: true } });
            nextSendAt = Date.now() + 1100;
            break;
          } catch (error) {
            if (error.status !== 429 || attempt >= 2 || error.retryAfter > 60) throw error;
            await pause(Math.max(error.retryAfter || 5, 1) * 1000);
          }
        }
      }
    }
    const bot = new Bot({ config, github: new GitHub(config, fetcher), localProject: new LocalProject(root, config.maxFiles), assistant: new Assistant(config, fetcher, logger), send,
      cache: new SnapshotStore(new URL('indexes/', dataDir), config.maxFiles), state: disk.selected,
      save: async selected => { const next = { ...disk, selected }; await writeJson(statePath, next); disk = next; } });
    await bot.restore();
    let me;
    while (!signal.aborted) {
      try {
        me = await telegram('getMe', {}, signal);
        const hook = await telegram('getWebhookInfo', {}, signal);
        if (hook.url) throw new Error('У бота настроен webhook. Отключи его перед запуском polling или используй нового бота.');
        break;
      } catch (error) {
        if (signal.aborted) return;
        if (!error.status && !(error instanceof NetworkError)) throw error;
        if ([401, 403, 409].includes(error.status)) throw error;
        logger.error(`${redact(error.message)} Повтор подключения через 5 секунд.`);
        await pause(5000);
      }
    }
    if (signal.aborted) return;
    try { await telegram('setMyCommands', { commands: COMMANDS }, signal); }
    catch (error) { if (signal.aborted) return; logger.warn(`Меню команд не обновлено: ${redact(error.message)}`); }
    logger.log(`Бот @${me.username} запущен. Остановка: Ctrl+C.`);
    logger.log(bot.mode());
    logger.log(`Восстановлено индексов: ${bot.sessions.size}.`);
    if (!config.allowedIds.size) logger.log('Доступ закрыт. Отправь боту /id, внеси ID в .env и перезапусти.');
    while (!signal.aborted) {
      try {
        const updates = await telegram('getUpdates', { offset: disk.offset, timeout: 25, allowed_updates: ['message'] }, signal);
        if (updates.length) logger.log(`Telegram: получено обновлений ${updates.length}.`);
        for (const update of updates) {
          if (signal.aborted) break;
          try { await bot.handle(update.message); }
          catch (error) {
            // A blocked/deleted chat must not hold up all subsequent updates.
            if (error.service !== 'Telegram' || ![400, 403].includes(error.status)) throw error;
            logger.warn(`Сообщение пропущено: ${redact(error.message)}`);
          }
          const next = { ...disk, offset: update.update_id + 1 };
          await writeJson(statePath, next);
          disk = next;
        }
      } catch (error) {
        if (signal.aborted) break;
        if ([401, 409].includes(error.status)) throw error;
        logger.error(redact(error.message));
        await pause(Math.min(Math.max(error.retryAfter || 5, 1), 60) * 1000);
      }
    }
  } finally { await release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const logger = await createRuntimeLogger(new URL('../data/', import.meta.url));
  logger.log(`Запуск процесса бота PID ${process.pid}.`);
  const stop = () => controller.abort();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
  try { await runBot({ signal: controller.signal, logger }); }
  catch (error) { logger.error(redact(error.message)); process.exitCode = 1; }
  finally { for (const signal of ['SIGINT', 'SIGTERM']) process.off(signal, stop); logger.log('Процесс бота завершён.'); }
}
