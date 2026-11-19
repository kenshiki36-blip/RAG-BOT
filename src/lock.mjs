import { open, readFile, rename, unlink } from 'node:fs/promises';

export function isRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
}

export async function acquireLock(path) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let handle;
    try { handle = await open(path, 'wx', 0o600); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (handle) {
      try { await handle.writeFile(String(process.pid)); }
      catch (error) { await handle.close(); await unlink(path); throw error; }
      return async () => {
        await handle.close();
        try { if ((await readFile(path, 'utf8')).trim() === String(process.pid)) await unlink(path); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    }
    // Only one starter may inspect and recover an old lock at a time.
    const recoveryPath = new URL('bot.lock.recovery', path);
    let recovery;
    try { recovery = await open(recoveryPath, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('Уже идёт запуск бота или остался data/bot.lock.recovery после аварии. Проверь процессы перед повторным запуском.');
      throw error;
    }
    try {
      let pidText;
      try { pidText = (await readFile(path, 'utf8')).trim(); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!/^[1-9]\d*$/.test(pidText) || !Number.isSafeInteger(Number(pidText)) || Number(pidText) > 2147483647) throw new Error('Некорректный data/bot.lock. Файл сохранён: проверь процессы перед его удалением.');
      if (isRunning(Number(pidText))) throw new Error('Бот уже запущен: второй экземпляр не создан.');
      await rename(path, new URL(`bot.lock.stale.${Date.now()}.${pidText}`, path));
    } finally { await recovery.close(); await unlink(recoveryPath); }
  }
  throw new Error('Не удалось занять блокировку бота. Повтори запуск.');
}
