import { parseAccount, parseRepo, redact } from './github.mjs';
import { recentCommits, searchRepository } from './local-answer.mjs';

export const COMMANDS = [
  ['github', 'Мой GitHub: /github логин'], ['disconnect', 'Сбросить свой GitHub и выбранный проект'],
  ['repos', 'Мои репозитории'], ['repo', 'Выбрать проект: /repo имя'],
  ['local', 'Прочитать локальный код этого бота'],
  ['search', 'Найти код: /search слово'], ['commits', 'Последние коммиты'],
  ['tree', 'Структура проекта'], ['file', 'Прочитать файл: /file путь'],
  ['status', 'Текущий проект и режим ответов'], ['refresh', 'Обновить код с GitHub'],
  ['reset', 'Очистить историю вопросов'], ['help', 'Справка'], ['id', 'Мой Telegram ID']
].map(([command, description]) => ({ command, description }));

export const HELP = `Я помогаю разобраться в твоих GitHub-проектах.
/github логин — выбрать свой GitHub (можно ссылку на профиль)
/disconnect — сбросить свой GitHub и выбранный проект
/repos — список репозиториев выбранного аккаунта
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

Для публичных проектов пароль и токен GitHub не нужны.
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
  constructor({ config, github, publicGithub, localProject, assistant, send, state = {}, githubAccounts = {}, usage = {}, saveUsage = async () => {}, save = async () => {}, cache, now = () => new Date() }) {
    Object.assign(this, { config, github, publicGithub, localProject, assistant, send, state, githubAccounts, saveUsage, save, cache, now });
    this.sessions = new Map();
    this.usage = new Map(Object.entries(usage).map(([id, entry]) => [id, { ...entry }]));
  }
  isOwner(id) { return this.config.allowedIds.has(id); }
  // Persist quota before a costly operation; a restart must not reset today's usage.
  async spend(id, kind) {
    if (this.isOwner(id) || !this.config.publicAccess) return;
    if (!['questions', 'indexes'].includes(kind)) throw new Error('Unknown quota kind.');
    const max = kind === 'questions' ? this.config.publicDailyQuestions ?? 20 : this.config.publicDailyIndexes ?? 5;
    const day = this.now().toISOString().slice(0, 10);
    const previous = this.usage.get(id);
    const entry = previous?.day === day ? { ...previous } : { day, questions: 0, indexes: 0 };
    if (entry[kind] >= max) throw new Error(kind === 'questions'
      ? `Дневной лимит вопросов к ИИ исчерпан (${max}). Поиск без ИИ работает: /search слово, /tree, /file путь. Лимит обновится после 00:00 UTC.`
      : `Дневной лимит загрузки проектов исчерпан (${max}). Лимит обновится после 00:00 UTC.`);
    entry[kind]++;
    const usage = Object.fromEntries([...this.usage].filter(([, value]) => value.day === day));
    usage[id] = entry;
    await this.saveUsage(usage);
    this.usage = new Map(Object.entries(usage));
  }
  account(id) { return this.githubAccounts[id] || this.config.owner; }
  client(id, owner = this.account(id)) {
    if (this.isOwner(id) && owner.toLowerCase() === this.config.owner.toLowerCase()) return this.github;
    if (!this.publicGithub) throw new Error('Public GitHub client unavailable.');
    return this.publicGithub;
  }
  readable(id, snapshot) {
    if (this.isOwner(id) && (snapshot.source === 'local'
      ? snapshot.name === this.localProject?.name
      : snapshot.name.split('/')[0].toLowerCase() === this.config.owner.toLowerCase())) return true;
    return (this.isOwner(id) || this.config.publicAccess) && snapshot.source === 'github' && snapshot.isPublic === true;
  }
  help(id) { return this.isOwner(id) ? HELP : HELP.replace(/^\/local[^\n]*\n/m, ''); }
  async setAccount(id, login) {
    const accounts = { ...this.githubAccounts }, selected = { ...this.state };
    if (login) accounts[id] = login;
    else delete accounts[id];
    delete selected[id];
    // Persist the account and cleared selection together before changing live sessions.
    await this.save(selected, accounts);
    this.githubAccounts = accounts;
    this.state = selected;
    this.sessions.delete(id);
  }
  async restore() {
    if (!this.cache) return;
    for (const id of this.config.allowedIds) {
      if (!this.state[id]) continue;
      try {
        const name = parseRepo(this.state[id], this.account(id));
        const session = await this.cache.load(name);
        if (session && this.readable(id, session.snapshot)) this.sessions.set(id, session);
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
    if (!this.isOwner(id) && !this.config.publicAccess) {
      await this.send(chatId, `Доступ закрыт. Твой ID: ${id}. Владелец должен добавить его в ALLOWED_TELEGRAM_IDS и перезапустить бота.`); return;
    }
    if (text.length > 8000) { await this.send(chatId, 'Сократи вопрос до 8000 символов.'); return; }
    try {
      const arg = text.slice(text.split(/\s/)[0].length).trim();
      if (command === '/start' || command === '/help') return await this.send(chatId, `${this.help(id)}\n\n${this.mode()}`);
      if (command === '/github') {
        if (!arg) return await this.send(chatId, `GitHub для /repos: ${this.account(id)}\nСвой аккаунт: /github логин или /github https://github.com/логин\nЗатем /repos → /repo имя → вопрос по коду. Для публичных проектов пароль и токен не нужны. Сбросить: /disconnect.`);
        const login = parseAccount(arg);
        if (!this.publicGithub) throw new Error('Подключение GitHub недоступно в этом запуске.');
        const profile = await this.publicGithub.profile(login);
        await this.setAccount(id, parseAccount(profile.login));
        return await this.send(chatId, `GitHub выбран: ${profile.login}\nhttps://github.com/${profile.login}\nДоступны публичные репозитории. Отправь /repos, затем /repo имя и задай вопрос.\nПредыдущий проект и история вопросов сброшены только в твоём чате.`);
      }
      if (command === '/disconnect') {
        await this.setAccount(id, null);
        return await this.send(chatId, 'Твой GitHub, выбранный проект и история вопросов сброшены. Для своих проектов: /github логин.');
      }
      if (command === '/repos') {
        const account = this.account(id);
        const all = await this.client(id, account).repos(account);
        const repos = this.isOwner(id) ? all : all.filter(repo => repo.private === false);
        return await this.send(chatId, repos.length ? repos.slice(0, 60).map(r => `${r.full_name}${r.private ? ' 🔒' : ''}\n${redact(r.description || '')}\n${r.html_url}`).join('\n\n') + (repos.length > 60 ? `\n\nПоказано 60 из ${repos.length}. Другой проект: /repo имя` : '') : `Публичные репозитории ${account} не найдены. Проверить аккаунт: /github. Приватные проекты по логину недоступны.`);
      }
      if (command === '/repo') {
        if (!arg) return await this.send(chatId, 'Пример: /repo RAG-BOT');
        const name = parseRepo(arg, this.account(id));
        await this.spend(id, 'indexes');
        return await this.index(id, chatId, name);
      }
      if (command === '/local') {
        if (!this.isOwner(id)) throw new Error('Локальные файлы доступны только владельцу бота.');
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
        await this.spend(id, 'indexes');
        return await this.index(id, chatId, this.state[id]);
      }
      if (command === '/status') {
        const session = this.sessions.get(id);
        return await this.send(chatId, `${this.mode()}\nGitHub для /repos: ${this.account(id)}\n\n${session ? `${session.snapshot.name}\nИсточник: ${session.snapshot.source === 'local' ? 'локальная папка проекта' : 'GitHub'}\nСнимок: ${session.snapshot.sha || 'нет'}\nИндекс: ${session.indexedAt}\nФайлов: ${session.snapshot.files.length}\n${session.snapshot.warnings.join('\n')}\nОбновить снимок: /refresh` : this.state[id] ? `Выбран ${this.state[id]}. Сохранённого индекса нет: /refresh` : 'Проект не выбран. /github логин → /repos → /repo имя'}`);
      }
      if (text.startsWith('/') && !['/tree', '/file', '/search', '/commits'].includes(command)) return await this.send(chatId, this.help(id));
      const session = this.sessions.get(id);
      if (!session) throw new Error(this.state[id] ? 'После перезапуска нужно обновить индекс: /refresh' : 'Сначала выбери проект: /repos → /repo имя');
      if (!this.readable(id, session.snapshot)) throw new Error('Выбери публичный репозиторий: /repo владелец/имя');
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
      await this.spend(id, 'questions');
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
    name = parseRepo(name, this.account(id));
    const isLocal = name === this.localProject?.name;
    if (isLocal && !this.isOwner(id)) throw new Error('\u041b\u043e\u043a\u0430\u043b\u044c\u043d\u044b\u0435 \u0444\u0430\u0439\u043b\u044b \u0434\u043e\u0441\u0442\u0443\u043f\u043d\u044b \u0442\u043e\u043b\u044c\u043a\u043e \u0432\u043b\u0430\u0434\u0435\u043b\u044c\u0446\u0443 \u0431\u043e\u0442\u0430.');
    await this.send(chatId, isLocal ? 'Читаю локальные исходники этого бота…' : `Читаю ${name}. Для большого проекта это может занять несколько минут…`);
    const snapshot = isLocal ? await this.localProject.snapshot() : await this.client(id, name.split('/')[0]).snapshot(name);
    if (!this.readable(id, snapshot)) throw new Error('Доступны только публичные репозитории GitHub.');
    const session = { snapshot, history: [], indexedAt: new Date().toISOString() };
    const state = { ...this.state, [id]: name };
    if (this.cache) await this.cache.save(name, session);
    await this.save(state);
    this.state = state;
    this.sessions.set(id, session);
    await this.send(chatId, `Готово: ${name}\nИсточник: ${isLocal ? 'локальная папка проекта' : 'GitHub'}.\nФайлов в индексе: ${snapshot.files.length} из ${snapshot.tree.length} в дереве.\n${snapshot.warnings.join('\n')}${!isLocal && snapshot.tree.length === 1 && this.localProject && this.isOwner(id) ? '\nДля исходников этого бота с компьютера используй /local.' : ''}\nЗадавай вопрос или используй /tree.`);
  }
  mode() { const label = { groq: 'Groq', xai: 'Grok (xAI)', gemini: 'Google Gemini' }[this.config.provider || 'gemini']; return this.config.apiKey ? `ИИ: ${label} (${this.config.model}). При ошибке — поиск по коду.` : `Режим: поиск по коду без ИИ. Ключ ${label} не настроен.`; }
}
