import { parseRepo, redact } from './github.mjs';
import { recentCommits, searchRepository } from './local-answer.mjs';

export const COMMANDS = [
  ['repos', 'Мои репозитории'], ['repo', 'Выбрать проект: /repo имя'],
  ['local', 'Прочитать локальный код этого бота'],
  ['search', 'Найти код: /search слово'], ['commits', 'Последние коммиты'],
  ['tree', 'Структура проекта'], ['file', 'Прочитать файл: /file путь'],
  ['status', 'Текущий проект и режим ответов'], ['refresh', 'Обновить код с GitHub'],
  ['reset', 'Очистить историю вопросов'], ['help', 'Справка'], ['id', 'Мой Telegram ID']
].map(([command, description]) => ({ command, description }));

export const HELP = `Я помогаю разобраться в твоих GitHub-проектах.
/repos — список репозиториев
/repo имя — выбрать и прочитать проект (можно owner/repo или ссылку)
/local — прочитать локальные исходники этого бота
/status — текущий проект и дата индексации
/tree [папка] — структура проекта
/file путь — прочитать файл
/search слово — найти фрагменты кода без обращения к ИИ
/commits — последние коммиты
/refresh — обновить код с GitHub
/reset — очистить историю вопросов
/id — узнать свой Telegram ID

После выбора проекта спрашивай: «Как запустить?», «Как устроена авторизация?», «Что менялось в последних коммитах?»
С ключом выбранного ИИ я объясняю код; без ключа показываю найденные фрагменты со ссылками.
Код читается выборочно, команды из репозитория не выполняются.`;

export function splitMessage(text, size = 3800) {
  if (!Number.isInteger(size) || size < 2 || size > 4096) throw new RangeError('Размер сообщения должен быть от 2 до 4096.');
  const parts = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + size, text.length);
    // Do not cut between the two UTF-16 code units of an emoji.
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    parts.push(text.slice(start, end)); start = end;
  }
  return parts;
}

export class Bot {
  constructor({ config, github, localProject, assistant, send, state = {}, save = async () => {}, cache }) {
    Object.assign(this, { config, github, localProject, assistant, send, state, save, cache });
    this.sessions = new Map();
  }
  async restore() {
    if (!this.cache) return;
    for (const id of this.config.allowedIds) {
      if (!this.state[id]) continue;
      try {
        const name = parseRepo(this.state[id], this.config.owner);
        if (name !== this.localProject?.name && name.split('/')[0].toLowerCase() !== this.config.owner.toLowerCase()) continue;
        const session = await this.cache.load(name);
        if (session) this.sessions.set(id, session);
      } catch { console.warn('Индекс не удалось восстановить. Он будет доступен после /refresh.'); }
    }
  }
  async handle(message) {
    if (!message?.text || !message.from || message.chat?.type !== 'private') return;
    const id = String(message.from.id), chatId = message.chat.id;
    const text = message.text.trim();
    if (!text) return;
    const command = text.split(/\s/)[0].split('@')[0].toLowerCase();
    if (command === '/id') { await this.send(chatId, `Твой Telegram ID: ${id}`); return; }
    if (!this.config.allowedIds.has(id)) {
      await this.send(chatId, `Доступ закрыт. Твой ID: ${id}. Владелец должен добавить его в ALLOWED_TELEGRAM_IDS и перезапустить бота.`); return;
    }
    if (text.length > 8000) { await this.send(chatId, 'Сократи вопрос до 8000 символов.'); return; }
    try {
      const arg = text.slice(text.split(/\s/)[0].length).trim();
      if (command === '/start' || command === '/help') return await this.send(chatId, `${HELP}\n\n${this.mode()}`);
      if (command === '/repos') {
        const repos = await this.github.repos();
        return await this.send(chatId, repos.length ? repos.slice(0, 60).map(r => `${r.full_name}${r.private ? ' 🔒' : ''}\n${redact(r.description || '')}\n${r.html_url}`).join('\n\n') + (repos.length > 60 ? `\n\nПоказано 60 из ${repos.length}. Другой проект: /repo имя` : '') : 'Репозитории не найдены. Для приватных проверь GITHUB_TOKEN.');
      }
      if (command === '/repo') {
        if (!arg) return await this.send(chatId, 'Пример: /repo RAG-BOT');
        const name = parseRepo(arg, this.config.owner);
        // Keep GitHub credential use within the configured owner's scope.
        if (name.split('/')[0].toLowerCase() !== this.config.owner.toLowerCase()) throw new Error(`Разрешены проекты владельца ${this.config.owner}. Измени GITHUB_OWNER для другого аккаунта.`);
        return await this.index(id, chatId, name);
      }
      if (command === '/local') {
        if (!this.localProject) throw new Error('Локальный источник не подключён в этом запуске.');
        return await this.index(id, chatId, this.localProject.name);
      }
      if (command === '/reset') {
        const session = this.sessions.get(id);
        if (session) session.history = [];
        return await this.send(chatId, 'История вопросов очищена.');
      }
      if (command === '/refresh') {
        if (!this.state[id]) throw new Error('Сначала выбери проект: /repo имя');
        return await this.index(id, chatId, this.state[id]);
      }
      if (command === '/status') {
        const session = this.sessions.get(id);
        return await this.send(chatId, `${this.mode()}\n\n${session ? `${session.snapshot.name}\nИсточник: ${session.snapshot.source === 'local' ? 'локальная папка проекта' : 'GitHub'}\nСнимок: ${session.snapshot.sha || 'нет'}\nИндекс: ${session.indexedAt}\nФайлов: ${session.snapshot.files.length}\n${session.snapshot.warnings.join('\n')}\nОбновить снимок: /refresh` : this.state[id] ? `Выбран ${this.state[id]}. Сохранённого индекса нет: /refresh` : 'Проект не выбран. /repos → /repo имя или /local'}`);
      }
      if (text.startsWith('/') && !['/tree', '/file', '/search', '/commits'].includes(command)) return await this.send(chatId, HELP);
      const session = this.sessions.get(id);
      if (!session) throw new Error(this.state[id] ? 'После перезапуска нужно обновить индекс: /refresh' : 'Сначала выбери проект: /repos → /repo имя');
      if (command === '/search') {
        if (!arg) return await this.send(chatId, 'Пример: /search авторизация или /search login');
        return await this.send(chatId, redact(searchRepository(session.snapshot, arg)));
      }
      if (command === '/commits') return await this.send(chatId, redact(recentCommits(session.snapshot)));
      if (command === '/tree') {
        const paths = session.snapshot.tree.filter(path => !arg || path.startsWith(arg.replace(/\/$/, '') + '/') || path === arg);
        return await this.send(chatId, paths.length ? `${paths.slice(0, 150).join('\n')}${paths.length > 150 ? `\n… ещё ${paths.length - 150}. Уточни /tree папка` : ''}` : 'Такой папки нет или репозиторий пуст.');
      }
      if (command === '/file') {
        const file = session.snapshot.files.find(f => f.path === arg);
        if (!file) throw new Error('Файла нет в индексе. Проверь /tree. Секреты, бинарные файлы, файлы >100 КБ и файлы сверх MAX_FILES исключаются.');
        const lines = file.text.split('\n');
        return await this.send(chatId, `${file.path}\n${lines.slice(0, 200).map((l, i) => `${i + 1}: ${l.slice(0, 500)}`).join('\n').slice(0, 14000)}\n[Показаны первые 200 строк, максимум 14000 символов]\n${file.url}`);
      }
      await this.send(chatId, 'Смотрю код и готовлю ответ…');
      const answer = await this.assistant.ask(session.snapshot, text, session.history);
      await this.send(chatId, redact(answer));
      session.history.push({ role: 'user', content: redact(text) }, { role: 'assistant', content: redact(answer).slice(0, 6000) });
      session.history = session.history.slice(-6);
    } catch (error) {
      await this.send(chatId, `Не получилось: ${redact(error.message)}`);
    }
  }
  async index(id, chatId, name) {
    name = parseRepo(name, this.config.owner);
    const isLocal = name === this.localProject?.name;
    if (!isLocal && name.split('/')[0].toLowerCase() !== this.config.owner.toLowerCase()) throw new Error('Сохранённый проект другого владельца. Выбери /repo имя заново.');
    await this.send(chatId, isLocal ? 'Читаю локальные исходники этого бота…' : `Читаю ${name}. Для большого проекта это может занять несколько минут…`);
    const snapshot = isLocal ? await this.localProject.snapshot() : await this.github.snapshot(name);
    const session = { snapshot, history: [], indexedAt: new Date().toISOString() };
    const state = { ...this.state, [id]: name };
    if (this.cache) await this.cache.save(name, session);
    await this.save(state);
    this.state = state;
    this.sessions.set(id, session);
    await this.send(chatId, `Готово: ${name}\nИсточник: ${isLocal ? 'локальная папка проекта' : 'GitHub'}.\nФайлов в индексе: ${snapshot.files.length} из ${snapshot.tree.length} в дереве.\n${snapshot.warnings.join('\n')}${!isLocal && snapshot.tree.length === 1 && this.localProject ? '\nДля исходников этого бота с компьютера используй /local.' : ''}\nЗадавай вопрос или используй /tree.`);
  }
  mode() { const label = { groq: 'Groq', xai: 'Grok (xAI)', gemini: 'Google Gemini' }[this.config.provider || 'gemini']; return this.config.apiKey ? `ИИ: ${label} (${this.config.model}). При ошибке — поиск по коду.` : `Режим: поиск по коду без ИИ. Ключ ${label} не настроен.`; }
}
