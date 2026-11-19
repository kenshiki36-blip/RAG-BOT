import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { parseEnv, loadConfig } from '../src/config.mjs';
import { GitHub, safePath, redact, parseRepo, parseAccount } from '../src/github.mjs';
import { retrieve } from '../src/retrieval.mjs';
import { Assistant } from '../src/ai.mjs';
import { Bot, splitMessage } from '../src/bot.mjs';
import { jsonRequest, textRequest } from '../src/http.mjs';
import { SnapshotStore, readState, writeJson } from '../src/storage.mjs';
import { acquireLock, isRunning } from '../src/lock.mjs';
import { runBot } from '../src/main.mjs';
import { approvedPath, auditFiles, readPublication } from '../scripts/publish-github.mjs';
import { saveGeminiKey, readSecret } from '../scripts/setup-gemini.mjs';
import { LocalProject } from '../src/local-project.mjs';
import { createRuntimeLogger } from '../src/logging.mjs';
import { checkGemini } from '../scripts/check-gemini.mjs';
import { saveProviderKey } from '../scripts/setup-provider.mjs';

async function inTemp(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'repo-bot-test-'));
  try { return await fn(pathToFileURL(directory + sep)); }
  finally {
    const target = await realpath(directory);
    assert.equal(dirname(target), await realpath(tmpdir()));
    assert.ok(basename(target).startsWith('repo-bot-test-'));
    await rm(target, { recursive: true, force: true });
  }
}

export async function runTests() {
  let passed = 0;
  const check = async (name, fn) => { await fn(); passed++; console.log(`OK ${name}`); };
  await check('env quotes and empty values', () => {
    assert.deepEqual(parseEnv('# comment\nKEY="hello world"\nEMPTY=\nNUM=12'), { KEY: 'hello world', EMPTY: '', NUM: '12' });
  });
  await check('repo validation and URL normalization', () => {
    assert.equal(parseRepo('https://github.com/me/project.git', 'me'), 'me/project');
    assert.equal(parseRepo('repo', 'me'), 'me/repo');
    for (const bad of ['../../etc', 'https://evil.test/repo', 'me/..', 'me/repo/tree/main']) assert.throws(() => parseRepo(bad, 'me'));
  });
  await check('exclude secrets, binary, dependencies and lockfiles', () => {
    for (const path of ['.env', '.env.local', 'keys/private.key', 'credentials.json', 'dist/a.js', 'node_modules/a.js', 'img.png', 'package-lock.json']) assert.equal(safePath(path), false, path);
    for (const path of ['src/main.py', 'README.md', 'Dockerfile', 'src/auth.ts']) assert.equal(safePath(path), true, path);
    assert.equal(redact('password=supersecret\ncode=ok'), 'password=[REDACTED]\ncode=ok');
    assert.ok(!redact('ghp_123456789012345678901234').includes('ghp_'));
    assert.ok(!redact('AIza' + 'a'.repeat(35)).includes('AIza'));
    for (const secret of ['DB_PASSWORD=my.pass.word', 'API_KEY=abc def', 'password: hunter2', '"password": "abc123",', "const secret = 'xyz'", 'token_secret = 9f8e7d6c5b4a'])
      assert.ok(redact(secret).includes('[REDACTED]') && !/my\.pass|abc def|hunter2|abc123|xyz|9f8e7d/.test(redact(secret)), secret);
    for (const code of ['const password = req.body.password', 'if (secret === undefined) return login(token)', 'apiKey: process.env.KEY, model: x',
      'password = getpass()', 'client_secret = os.environ["X"]', '  password: string;', 'const fn = (password) => check(password)'])
      assert.equal(redact(code), code);
  });
  const snapshot = { name: 'me/project', sha: 'abc123', branch: 'main', tree: ['README.md', 'src/auth.js'], commits: [], warnings: [], files: [
    { path: 'README.md', text: '# Project\nInstall\nnpm start', url: 'https://github.com/me/project/blob/abc123/README.md' },
    { path: 'src/auth.js', text: 'function login(token) { return verify(token); }', url: 'https://github.com/me/project/blob/abc123/src/auth.js' }
  ] };
  await check('retrieval finds auth and launch instructions with source lines', () => {
    assert.equal(retrieve(snapshot, 'Как устроена авторизация?')[0].path, 'src/auth.js');
    assert.equal(retrieve(snapshot, 'Как запустить проект?')[0].path, 'README.md');
    assert.equal(retrieve(snapshot, 'login')[0].start, 1);
  });
  const config = { owner: 'me', allowedIds: new Set(['1']), maxFiles: 10, apiKey: 'test-key', model: 'test-model' };
  const message = (text, id = 1, type = 'private') => ({ text, from: { id }, chat: { id, type } });
  let reads = 0, calls = 0, saved;
  const sent = [];
  const bot = new Bot({ config, github: { snapshot: async () => { reads++; return snapshot; }, repos: async () => [] },
    assistant: { ask: async () => { calls++; return 'answer'; } }, send: async (id, text) => sent.push(text), save: async state => { saved = { ...state }; } });
  await check('deny strangers and groups before GitHub or AI calls', async () => {
    await bot.handle(message('/repo project', 2)); await bot.handle(message('/repo project', 1, 'group'));
    assert.equal(reads, 0); assert.equal(calls, 0);
    await bot.handle(message('/id', 2)); assert.match(sent.at(-1), /2/);
  });
  await check('select repo, answer, reset, refresh and persist selection', async () => {
    await bot.handle(message('/repo project')); assert.equal(reads, 1); assert.equal(saved['1'], 'me/project');
    await bot.handle(message('Как запустить?')); assert.equal(calls, 1); assert.equal(bot.sessions.get('1').history.length, 2);
    await bot.handle(message('/reset')); assert.equal(bot.sessions.get('1').history.length, 0);
    await bot.handle(message('/refresh')); assert.equal(reads, 2);
    await bot.handle(message('/file .env')); assert.match(sent.at(-1), /нет в индексе/);
    await bot.handle(message('/repo other/project')); assert.equal(reads, 2);
    bot.state['1'] = 'other/project'; await bot.handle(message('/refresh')); assert.equal(reads, 2);
  });
  await check('failed refresh retains previous working index', async () => {
    bot.state['1'] = 'me/project'; bot.github.snapshot = async () => { throw new Error('GitHub: HTTP 403'); };
    await bot.handle(message('/refresh')); assert.equal(bot.sessions.get('1').snapshot.sha, 'abc123');
  });
  await check('Telegram splitting preserves Unicode', () => {
    const text = '😀Привет\n'.repeat(1800), parts = splitMessage(text);
    assert.equal(parts.join(''), text); assert.ok(parts.every(p => p.length <= 4096));
    assert.throws(() => splitMessage(text, 1), RangeError);
  });
  await check('Gemini request includes sources and history, hides key in header and excludes thoughts', async () => {
    let body;
    const ai = new Assistant(config, async (url, options) => {
      assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent'); body = JSON.parse(options.body);
      assert.equal(options.headers['x-goog-api-key'], 'test-key');
      assert.ok(!url.includes('test-key')); assert.equal(options.method, 'POST');
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'internal reasoning', thought: true }, { text: 'See README.md:3' }] } }] }));
    });
    const answer = await ai.ask(snapshot, 'Как запустить?', [{ role: 'user', content: 'Что за проект?' }, { role: 'assistant', content: 'A project' }]);
    assert.equal(body.contents[1].role, 'model'); assert.equal(body.generationConfig.maxOutputTokens, 4096);
    assert.match(body.systemInstruction.parts[0].text, /недоверенные данные/);
    assert.match(body.contents.at(-1).parts[0].text, /npm start/); assert.match(answer, /blob\/abc123/);
    assert.ok(!answer.includes('internal reasoning')); assert.ok(!body.tools);
  });
  await check('GitHub pins source to commit, filters secrets, loads blobs', async () => {
    const urls = [];
    const github = new GitHub(config, async url => {
      const path = new URL(url).pathname + new URL(url).search; urls.push(path);
      const payload = path === '/repos/me/project' ? { default_branch: 'main' }
        : path === '/repos/me/project/commits/main' ? { sha: 'abc123', commit: { tree: { sha: 'tree123' } } }
        : path.includes('/git/trees/') ? { tree: [ { type: 'blob', mode: '100644', size: 10, path: 'README.md', sha: 'blob123' }, { type: 'blob', size: 20, path: '.env', sha: 'secret' } ] }
        : path.includes('/git/blobs/blob123') ? { encoding: 'base64', content: Buffer.from('npm start').toString('base64') }
        : [];
      return new Response(JSON.stringify(payload));
    });
    const result = await github.snapshot('me/project');
    assert.equal(result.files.length, 1); assert.match(result.files[0].url, /abc123/);
    assert.ok(!urls.some(u => u.includes('/secret'))); assert.ok(urls.includes('/repos/me/project/commits?sha=abc123&per_page=5'));
  });
  await check('empty and truncated repositories are explicit', async () => {
    const empty = new GitHub(config, async url => new Response(JSON.stringify(url.endsWith('/commits/main') ? {} : { default_branch: 'main' }), { status: url.endsWith('/commits/main') ? 409 : 200 }));
    assert.equal((await empty.snapshot('me/project')).files.length, 0);
    const large = new GitHub(config); large.get = async path => path.includes('git/trees') ? { truncated: true } : path.endsWith('/commits/main') ? { sha: 'a', commit: { tree: { sha: 'b' } } } : { default_branch: 'main' };
    await assert.rejects(large.snapshot('me/project'), /неполное дерево/);
  });
  await check('network errors never leak URLs or credentials', async () => {
    await assert.rejects(jsonRequest('https://secret.test/token', { service: 'Test' }, async () => { throw new Error('sensitive-token'); }), error => !error.message.includes('sensitive-token'));
    await assert.rejects(jsonRequest('https://example.test', { service: 'Test' }, async () => new Response('no', { status: 401 })), /Проверь токен/);
  });
  await check('configuration uses Google keys and ignores legacy OpenAI credentials', async () => inTemp(async root => {
    const envPath = new URL('.env', root);
    await writeFile(envPath, 'TELEGRAM_BOT_TOKEN=test\nGEMINI_API_KEY="google-key"\nGEMINI_MODEL=gemini-3.8-flash # free tier\n');
    const google = await loadConfig({}, envPath);
    assert.equal(google.apiKey, 'google-key'); assert.equal(google.model, 'gemini-3.8-flash');
    assert.equal((await loadConfig({ TELEGRAM_BOT_TOKEN: 'test', GOOGLE_API_KEY: 'alias' }, new URL('missing', root))).apiKey, 'alias');
    assert.equal((await loadConfig({ TELEGRAM_BOT_TOKEN: 'test', OPENAI_API_KEY: 'ignored' }, new URL('missing', root))).apiKey, '');
    await assert.rejects(loadConfig({ GEMINI_MODEL: '../evil' }, envPath), /GEMINI_MODEL/);
  }));
  await check('no-key answers cite code and no-match searches do not invent results', async () => {
    let requests = 0;
    const local = new Assistant({}, async () => { requests++; throw new Error('must not call API'); });
    const answer = await local.ask(snapshot, 'Как запустить?');
    assert.match(answer, /Режим без ИИ/); assert.match(answer, /npm start/); assert.match(answer, /#L1-L3/);
    const missing = await local.ask(snapshot, 'NonexistentSymbol12345');
    assert.match(missing, /совпадений не найдено/); assert.ok(!missing.includes('npm start')); assert.equal(requests, 0);
    const commits = await local.ask({ ...snapshot, commits: [{ sha: '123', message: 'Fix login', url: 'https://github.com/me/project/commit/123' }] }, 'Что нового в коммитах?');
    assert.match(commits, /Fix login/);
  });
  await check('Gemini quota uses RetryInfo and cooldown without switching to a paid provider', async () => {
    let requests = 0;
    const ai = new Assistant(config, async url => {
      requests++; assert.match(url, /^https:\/\/generativelanguage\.googleapis\.com\//);
      return new Response(JSON.stringify({ error: { details: [{ retryDelay: '30s' }] } }), { status: 429 });
    });
    assert.match(await ai.ask(snapshot, 'login'), /HTTP 429/);
    assert.ok(ai.cooldownUntil >= Date.now() + 29000);
    assert.match(await ai.ask(snapshot, 'login'), /Лимит Gemini/); assert.equal(requests, 1);
    const blocked = new Assistant(config, async () => new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } })));
    assert.match(await blocked.ask(snapshot, 'login'), /Режим без ИИ/);
  });
  await check('public indexing downloads 75 pinned files without 75 REST calls or leaked headers', async () => {
    let rest = 0, raw = 0;
    const github = new GitHub({ ...config, githubToken: 'private-token', maxFiles: 100 }, async (url, options) => {
      const target = new URL(url);
      if (target.hostname === 'raw.githubusercontent.com') {
        raw++; assert.ok(!options.headers?.Authorization); assert.match(target.pathname, /^\/me\/project\/abc123\//);
        return new Response('export const value = 1;');
      }
      rest++;
      const payload = target.pathname === '/repos/me/project' ? { default_branch: 'main', private: false }
        : target.pathname.endsWith('/commits/main') ? { sha: 'abc123', commit: { tree: { sha: 'tree123' } } }
        : target.pathname.includes('/git/trees/') ? { tree: Array.from({ length: 75 }, (_, index) => ({ type: 'blob', mode: '100644', path: `src/file${index}.mjs`, size: 25, sha: String(index) })) }
        : [];
      return new Response(JSON.stringify(payload));
    });
    const result = await github.snapshot('me/project');
    assert.equal(result.files.length, 75); assert.equal(raw, 75); assert.equal(rest, 4);
  });
  await check('raw downloads stop at the byte limit and Telegram retries use JSON metadata', async () => {
    await assert.rejects(textRequest('https://example.test', { service: 'GitHub', maxBytes: 3 }, async () => new Response('too long')), /лимит размера/);
    await assert.rejects(jsonRequest('https://example.test', { service: 'Telegram' }, async () => new Response(JSON.stringify({ parameters: { retry_after: 17 } }), { status: 429 })), error => error.retryAfter === 17 && error.service === 'Telegram');
  });
  await check('cached index restores after restart and supports search without GitHub', async () => inTemp(async root => {
    const cache = new SnapshotStore(new URL('indexes/', root));
    let selected;
    const output = [];
    const first = new Bot({ config, github: { snapshot: async () => snapshot }, assistant: new Assistant({}), send: async (id, text) => output.push(text), cache,
      save: async state => { selected = state; } });
    await first.handle(message('/repo project'));
    const second = new Bot({ config, github: { snapshot: async () => { throw new Error('offline'); } }, assistant: new Assistant({}), send: async (id, text) => output.push(text), state: selected, cache });
    await second.restore(); assert.equal(second.sessions.size, 1);
    await second.handle(message('/search login')); assert.match(output.at(-1), /src\/auth.js/);
    await second.handle(message('Как запустить?')); assert.match(output.at(-1), /npm start/);
    await second.handle(message('/commits')); assert.match(output.at(-1), /нет коммитов/);
    const wrongOwner = new Bot({ config: { ...config, owner: 'other' }, state: selected, cache });
    await wrongOwner.restore(); assert.equal(wrongOwner.sessions.size, 0);
    await writeFile(cache.path('me/project'), 'null'); assert.equal(await cache.load('me/project'), null);
  }));
  await check('failed state write keeps the selected project and previous working session', async () => {
    const output = [];
    const failing = new Bot({ config, github: { snapshot: async () => ({ ...snapshot, name: 'me/new' }) }, send: async (id, text) => output.push(text),
      state: { '1': 'me/project' }, save: async () => { throw new Error('disk full'); } });
    failing.sessions.set('1', { snapshot, history: [], indexedAt: 'old' });
    await failing.handle(message('/repo new'));
    assert.equal(failing.state['1'], 'me/project'); assert.equal(failing.sessions.get('1').snapshot.name, 'me/project'); assert.match(output.at(-1), /disk full/);
  });
  await check('lock rejects a live instance, recovers a dead PID, and never removes a changed lock', async () => inTemp(async root => {
    const path = new URL('bot.lock', root);
    const release = await acquireLock(path);
    await assert.rejects(acquireLock(path), /уже запущен/);
    await release();
    assert.equal(isRunning(2147483647), false);
    await writeFile(path, '2147483647');
    const recovered = await acquireLock(path);
    assert.ok((await readdir(root)).some(name => name.startsWith('bot.lock.stale.')));
    await writeFile(path, '123'); await recovered(); assert.equal(await readFile(path, 'utf8'), '123');
  }));
  await check('corrupt state is preserved and blocks startup without leaving a lock', async () => inTemp(async root => {
    await mkdir(new URL('data/', root));
    const path = new URL('data/state.json', root);
    await writeFile(path, '{bad json');
    await assert.rejects(readState(path), /state.json/);
    await assert.rejects(runBot({ root, env: { TELEGRAM_BOT_TOKEN: 'test' } }), /state.json/);
    assert.equal(await readFile(path, 'utf8'), '{bad json');
    assert.ok(!(await readdir(new URL('data/', root))).includes('bot.lock'));
  }));
  await check('full polling flow indexes GitHub, searches, answers via Gemini and persists the offset', async () => inTemp(async root => {
    const controller = new AbortController(), outgoing = [], logs = [], offsets = [];
    let polls = 0, gemini = 0;
    const fetcher = async (url, options) => {
      const target = new URL(url);
      let payload;
      if (target.hostname === 'api.telegram.org') {
        const method = target.pathname.split('/').at(-1), body = JSON.parse(options.body);
        if (method === 'getMe') payload = { username: 'testbot' };
        else if (method === 'getWebhookInfo') payload = { url: '' };
        else if (method === 'setMyCommands') { assert.ok(body.commands.some(item => item.command === 'search')); payload = true; }
        else if (method === 'sendMessage') { outgoing.push(body.text); payload = {}; }
        else if (method === 'getUpdates') {
          offsets.push(body.offset); polls++;
          if (polls === 1) payload = ['/repo project', '/search login', 'Как запустить?', '/commits'].map((text, i) => ({ update_id: 30 + i, message: message(text) }));
          else { controller.abort(); payload = []; }
        } else throw new Error(`unexpected method: ${method}`);
        return new Response(JSON.stringify({ ok: true, result: payload }));
      }
      if (target.hostname === 'generativelanguage.googleapis.com') {
        gemini++; payload = { candidates: [{ content: { parts: [{ text: 'Запуск: npm start. Источник README.md:3.' }] } }] };
      } else if (target.hostname === 'raw.githubusercontent.com') return new Response('login(token)\nInstall\nnpm start');
      else if (target.pathname === '/repos/me/project') payload = { default_branch: 'main', private: false };
      else if (target.pathname.endsWith('/commits/main')) payload = { sha: 'abc123', commit: { tree: { sha: 'tree123' } } };
      else if (target.pathname.includes('/git/trees/')) payload = { tree: [{ type: 'blob', mode: '100644', path: 'README.md', size: 32, sha: 'blob123' }] };
      else if (target.pathname.endsWith('/commits')) payload = [{ sha: 'abc123', commit: { message: 'Initial commit' }, html_url: 'https://github.com/me/project/commit/abc123' }];
      else throw new Error(`unexpected host: ${target.hostname}`);
      return new Response(JSON.stringify(payload));
    };
    await runBot({ root, env: { TELEGRAM_BOT_TOKEN: 'test', ALLOWED_TELEGRAM_IDS: '1', GITHUB_OWNER: 'me', GEMINI_API_KEY: 'test-key' },
      fetcher, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]), pause: async () => setImmediate(),
      logger: { log: text => logs.push(text), warn: text => logs.push(text), error: text => logs.push(text) } });
    assert.equal(gemini, 1); assert.equal(polls, 2); assert.deepEqual(offsets, [0, 34]);
    assert.ok(outgoing.some(text => text.includes('Найденные фрагменты')));
    assert.ok(outgoing.some(text => text.includes('Запуск: npm start.')));
    assert.ok(outgoing.some(text => text.includes('Initial commit')));
    const state = await readState(new URL('data/state.json', root));
    assert.deepEqual(state, { offset: 34, selected: { '1': 'me/project' } });
    assert.equal((await readdir(new URL('data/indexes/', root))).length, 1);
    assert.ok(!(await readdir(new URL('data/', root))).includes('bot.lock'));
    assert.ok(logs.some(text => text.includes('запущен')));
  }));
  await check('polling skips a permanently blocked chat and continues to the next user', async () => inTemp(async root => {
    const controller = new AbortController(); let polls = 0, delivered = 0;
    await runBot({ root, env: { TELEGRAM_BOT_TOKEN: 'test', ALLOWED_TELEGRAM_IDS: '1' }, signal: controller.signal,
      pause: async () => setImmediate(), logger: { log() {}, warn() {}, error() { controller.abort(); } },
      fetcher: async (url, options) => {
        const method = new URL(url).pathname.split('/').at(-1), body = JSON.parse(options.body);
        let result = true;
        if (method === 'getMe') result = { username: 'testbot' };
        if (method === 'getWebhookInfo') result = { url: '' };
        if (method === 'sendMessage') {
          if (body.chat_id === 2) return new Response('{}', { status: 403 });
          delivered++;
        }
        if (method === 'getUpdates') {
          if (++polls === 1) result = [{ update_id: 1, message: message('/help', 2) }, { update_id: 2, message: message('/help') }];
          else { controller.abort(); result = []; }
        }
        return new Response(JSON.stringify({ ok: true, result }));
      } });
    assert.equal(delivered, 1); assert.equal((await readState(new URL('data/state.json', root))).offset, 3);
  }));
  await check('local Gemini setup preserves Telegram settings and rejects malformed keys before writing', async () => inTemp(async root => {
    const path = new URL('.env', root);
    await writeFile(path, 'TELEGRAM_BOT_TOKEN=keep-telegram\r\nALLOWED_TELEGRAM_IDS=1\r\nAI_PROVIDER=xai\r\nGEMINI_API_KEY=old\r\n');
    await saveGeminiKey('AIza' + 'a'.repeat(35), root);
    const values = parseEnv(await readFile(path, 'utf8'));
    assert.equal(values.TELEGRAM_BOT_TOKEN, 'keep-telegram'); assert.equal(values.ALLOWED_TELEGRAM_IDS, '1');
    assert.equal(values.AI_PROVIDER, 'gemini');
    assert.equal(values.GEMINI_MODEL, 'gemini-3.5-flash-lite'); assert.equal(values.GEMINI_API_KEY, 'AIza' + 'a'.repeat(35));
    const before = await readFile(path, 'utf8');
    await assert.rejects(saveGeminiKey('bad\nGITHUB_TOKEN=changed', root), /Ключ должен/);
    assert.equal(await readFile(path, 'utf8'), before);
    assert.deepEqual(await readdir(root), ['.env']);
  }));
  await check('fatal Telegram credentials and webhook errors stop cleanly without removing webhook', async () => inTemp(async root => {
    await assert.rejects(runBot({ root, env: { TELEGRAM_BOT_TOKEN: 'test' }, fetcher: async () => new Response('{}', { status: 401 }) }), /HTTP 401/);
    const methods = [];
    await assert.rejects(runBot({ root, env: { TELEGRAM_BOT_TOKEN: 'test' }, fetcher: async url => {
      const method = new URL(url).pathname.split('/').at(-1); methods.push(method);
      return new Response(JSON.stringify({ ok: true, result: method === 'getMe' ? { username: 'testbot' } : { url: 'https://example.test/hook' } }));
    } }), /webhook/);
    assert.deepEqual(methods, ['getMe', 'getWebhookInfo']);
    assert.ok(!(await readdir(new URL('data/', root))).includes('bot.lock'));
  }));
  await check('hidden input preserves AQ auth-key separator and never echoes the credential', async () => inTemp(async root => {
    const authKey = 'AQ.' + 'x'.repeat(50);
    const input = new PassThrough(), output = new PassThrough(), modes = [];
    input.isTTY = true; input.setRawMode = value => modes.push(value);
    let shown = ''; output.on('data', chunk => { shown += chunk.toString(); });
    const pending = readSecret(input, output);
    input.write(authKey + '\r');
    assert.equal(await pending, authKey);
    assert.deepEqual(modes, [true, false]); assert.equal(shown, '*'.repeat(authKey.length) + '\n');
    assert.ok(!shown.includes(authKey));
    await writeFile(new URL('.env', root), 'TELEGRAM_BOT_TOKEN=keep\n');
    await saveGeminiKey(authKey, root);
    assert.equal(parseEnv(await readFile(new URL('.env', root), 'utf8')).GEMINI_API_KEY, authKey);
    await assert.rejects(saveGeminiKey('AQ' + 'x'.repeat(50), root), /включая точку/);
    assert.ok(!redact(authKey).includes(authKey));
  }));
  await check('Gemini 400 identifies an invalid key without echoing remote secrets or suggesting retry', async () => {
    const key = 'AQ.' + 'x'.repeat(50);
    await assert.rejects(jsonRequest('https://example.test', { service: 'Gemini' }, async () => new Response(JSON.stringify({
      error: { status: 'INVALID_ARGUMENT', message: `Bad credential: ${key}`, details: [{ reason: 'API_KEY_INVALID' }] }
    }), { status: 400 })), error => {
      assert.equal(error.reason, 'API_KEY_INVALID'); assert.equal(error.providerCode, 'INVALID_ARGUMENT');
      assert.ok(!error.message.includes(key)); assert.ok(!error.message.includes('Попробуй позже'));
      return true;
    });
  });
  await check('local project indexes real source and CMD files while excluding secrets and runtime data', async () => inTemp(async root => {
    await mkdir(new URL('src/', root)); await mkdir(new URL('data/', root)); await mkdir(new URL('node_modules/', root));
    await writeFile(new URL('README.md', root), '# Local project');
    await writeFile(new URL('src/main.mjs', root), `const key = "${'AQ.' + 'x'.repeat(50)}";\nexport const login = () => true;`);
    await writeFile(new URL('start.cmd', root), 'node src/main.mjs');
    await writeFile(new URL('.env', root), 'PRIVATE=do-not-read');
    await writeFile(new URL('data/state.json', root), 'runtime-secret');
    await writeFile(new URL('node_modules/lib.mjs', root), 'dependency-secret');
    const local = new LocalProject(root);
    const indexed = await local.snapshot();
    assert.equal(indexed.source, 'local'); assert.ok(indexed.sha.startsWith('local-'));
    assert.deepEqual(indexed.files.map(file => file.path).sort(), ['README.md', 'src/main.mjs', 'start.cmd']);
    assert.ok(!JSON.stringify(indexed).includes('runtime-secret')); assert.ok(!JSON.stringify(indexed).includes('AQ.' + 'x'.repeat(50)));
    assert.ok(indexed.files.every(file => file.url === ''));
    const limited = await new LocalProject(root, 1).snapshot(); assert.equal(limited.files.length, 1); assert.ok(limited.warnings.length);
  }));
  await check('authorized local selection restores and refreshes without GitHub calls', async () => inTemp(async root => {
    await writeFile(new URL('README.md', root), '# Local project\nHow it works');
    const localProject = new LocalProject(root), cache = new SnapshotStore(new URL('indexes/', root));
    const output = []; let selected = {}, reads = 0;
    const originalSnapshot = localProject.snapshot.bind(localProject);
    localProject.snapshot = async () => { reads++; return originalSnapshot(); };
    const first = new Bot({ config, github: { snapshot: async () => { throw new Error('must not use GitHub'); } }, localProject, assistant: new Assistant({}),
      send: async (id, text) => output.push(text), cache, save: async state => { selected = state; } });
    await first.handle(message('/local', 2)); assert.equal(reads, 0);
    await first.handle(message('/local')); assert.equal(reads, 1); assert.equal(selected['1'], 'local/RAG-BOT');
    assert.match(output.at(-1), /локальная папка/);
    const second = new Bot({ config, localProject, cache, state: selected, assistant: new Assistant({}), send: async (id, text) => output.push(text) });
    await second.restore(); assert.equal(second.sessions.get('1').snapshot.source, 'local');
    await second.handle(message('/refresh')); assert.equal(reads, 2);
    await second.handle(message('Как работает проект?')); assert.match(output.at(-1), /How it works/); assert.ok(!output.at(-1).includes('#L'));
  }));
  await check('placeholder GitHub repository explains missing source instead of a no-match answer', async () => {
    const answer = await new Assistant({}).ask({ ...snapshot, tree: ['README.md'], files: [snapshot.files[0]], source: 'github' }, 'Как работает проект?');
    assert.match(answer, /только README/); assert.match(answer, /\/local/); assert.ok(!answer.includes('совпадений не найдено'));
  });
  await check('Gemini fast mode uses LOW thinking and cancels a slow request before falling back', async () => {
    let cancelled = false, body;
    const ai = new Assistant({ ...config, model: 'gemini-3.8-flash', aiTimeoutSeconds: 0.02 }, async (url, options) => {
      body = JSON.parse(options.body);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response('{}')), 1000);
        options.signal.addEventListener('abort', () => { cancelled = true; clearTimeout(timer); reject(options.signal.reason); }, { once: true });
      });
    });
    const answer = await ai.ask(snapshot, 'login');
    assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
    assert.ok(cancelled); assert.match(answer, /Режим без ИИ/);
    assert.equal((await loadConfig({ TELEGRAM_BOT_TOKEN: 'test' }, new URL('missing.env', import.meta.url))).aiTimeoutSeconds, 45);
    await assert.rejects(loadConfig({ TELEGRAM_BOT_TOKEN: 'test', GEMINI_TIMEOUT_SECONDS: '0' }, new URL('missing.env', import.meta.url)), /GEMINI_TIMEOUT_SECONDS/);
  });
  await check('runtime logs persist dated activity and errors while masking Google auth keys', async () => inTemp(async root => {
    const logger = await createRuntimeLogger(root, { log() {}, warn() {}, error() {} });
    const key = 'AQ.' + 'x'.repeat(50);
    logger.log('Started test session'); logger.warn('Gemini failure ' + key); logger.error(new Error('Test stopped'));
    const out = await readFile(new URL('bot.stdout.log', root), 'utf8');
    const errors = await readFile(new URL('bot.stderr.log', root), 'utf8');
    assert.match(out, /^\[\d{4}-\d\d-\d\dT/); assert.match(out, /Started test session/);
    assert.match(errors, /Gemini failure/); assert.match(errors, /Test stopped/); assert.ok(!errors.includes(key));
  }));
  if (process.platform === 'win32') await check('Windows restart launches with a stale PID or no lock and refuses malformed locks', async () => inTemp(async root => {
    await mkdir(new URL('src/', root)); await mkdir(new URL('data/', root));
    await writeFile(new URL('restart.cmd', root), await readFile(new URL('../restart.cmd', import.meta.url)));
    await writeFile(new URL('src/main.mjs', root), "import { writeFileSync } from 'node:fs'; writeFileSync(new URL('../started.txt', import.meta.url), 'started');");
    const launch = () => spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'restart.cmd'], {
      cwd: new URL(root), encoding: 'utf8', input: '\r\n', timeout: 10000, windowsHide: true
    });
    await writeFile(new URL('data/bot.lock', root), '2147483647');
    const stale = launch();
    assert.equal(stale.status, 0, stale.stdout + stale.stderr);
    assert.equal(await readFile(new URL('started.txt', root), 'utf8'), 'started');
    await rm(new URL('data/bot.lock', root)); await rm(new URL('started.txt', root));
    const absent = launch(); assert.equal(absent.status, 0, absent.stdout + absent.stderr);
    assert.equal(await readFile(new URL('started.txt', root), 'utf8'), 'started');
    await rm(new URL('started.txt', root)); await writeFile(new URL('data/bot.lock', root), 'bad-pid');
    const invalid = launch(); assert.equal(invalid.status, 1);
    await assert.rejects(readFile(new URL('started.txt', root)), error => error.code === 'ENOENT');
  }));
  await check('Gemini connection check separates model lookup and tiny generation without sending repository code', async () => inTemp(async root => {
    const key = 'AQ.' + 'x'.repeat(50), requests = [];
    const report = await checkGemini({ root, config: { ...config, apiKey: key }, logger: { log() {}, error() {} }, fetcher: async (url, options) => {
      requests.push(url); assert.ok(!url.includes(key)); assert.equal(options.headers['x-goog-api-key'], key);
      if (url.endsWith(':generateContent')) {
        const body = JSON.parse(options.body);
        assert.equal(body.contents.length, 1); assert.equal(body.contents[0].parts[0].text, 'Reply with the single word OK.');
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] }));
      }
      return new Response(JSON.stringify({ supportedGenerationMethods: ['generateContent'] }));
    } });
    assert.equal(requests.length, 2); assert.ok(report.checks.every(item => item.ok));
    const saved = await readFile(new URL('data/gemini-check.json', root), 'utf8');
    assert.ok(!saved.includes(key)); assert.equal(JSON.parse(saved).checks[1].returnedText, true);
  }));
  await check('failed Gemini connection records a safe network code and skips generation', async () => inTemp(async root => {
    const key = 'AQ.' + 'x'.repeat(50); let requests = 0;
    const report = await checkGemini({ root, config: { ...config, apiKey: key }, logger: { log() {}, error() {} }, fetcher: async () => {
      requests++; throw new Error(key, { cause: { code: 'EACCES' } });
    } });
    assert.equal(requests, 1); assert.equal(report.checks[0].type, 'network'); assert.equal(report.checks[0].code, 'EACCES');
    assert.ok(!JSON.stringify(report).includes(key));
  }));
  await check('Gemini check distinguishes a generation timeout from successful model access', async () => inTemp(async root => {
    const report = await checkGemini({ root, config, logger: { log() {}, error() {} }, fetcher: async url => {
      if (url.endsWith(':generateContent')) throw new DOMException('timeout', 'TimeoutError');
      return new Response('{}');
    } });
    assert.equal(report.checks[0].ok, true); assert.equal(report.checks[1].type, 'timeout');
    assert.equal(report.checks[1].code, 'REQUEST_TIMEOUT');
  }));
  await check('Groq and xAI use separate keys and never reuse the Gemini credential', async () => inTemp(async root => {
    const path = new URL('.env', root);
    await writeFile(path, 'TELEGRAM_BOT_TOKEN=keep\nGEMINI_API_KEY=google-secret\n');
    for (const provider of ['groq', 'xai']) {
      const missing = await loadConfig({ AI_PROVIDER: provider }, path); assert.equal(missing.apiKey, '');
      await assert.rejects(checkGemini({ config: { ...config, provider }, root, fetcher: async () => { throw new Error('must not send another provider key to Google'); } }), /только для Gemini/);
      const key = (provider === 'groq' ? 'gsk_' : 'xai-') + 'a'.repeat(32);
      await saveProviderKey(provider, key, root);
      const selected = await loadConfig({}, path);
      assert.equal(selected.provider, provider); assert.equal(selected.apiKey, key);
      assert.equal(parseEnv(await readFile(path, 'utf8')).TELEGRAM_BOT_TOKEN, 'keep');
      assert.ok(!redact(key).includes(key));
    }
  }));
  await check('Groq chat and Grok Responses calls carry grounded context and return source citations', async () => {
    for (const provider of ['groq', 'xai']) {
      const ai = new Assistant({ ...config, provider }, async (url, options) => {
        const body = JSON.parse(options.body);
        assert.equal(options.headers.Authorization, 'Bearer test-key');
        assert.match(JSON.stringify(body), /npm start/);
        assert.ok(!JSON.stringify(body).includes('generationConfig'));
        if (provider === 'groq') {
          assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
          assert.equal(body.messages[0].role, 'system');
          return new Response(JSON.stringify({ choices: [{ message: { content: 'Groq answer' } }] }));
        }
        assert.equal(url, 'https://api.x.ai/v1/responses'); assert.equal(body.store, false);
        return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Grok answer' }] }] }));
      });
      assert.match(await ai.ask(snapshot, 'How to start?'), /answer/);
    }
  });
  await check('Public access isolates credentials, local files and private snapshots', async () => {
    const replies = [];
    let privateCalls = 0, publicCalls = 0, localCalls = 0;
    const bot = new Bot({
      config: { ...config, publicAccess: true },
      github: { repos: async () => { privateCalls++; return []; }, snapshot: async () => { privateCalls++; return snapshot; } },
      publicGithub: {
        repos: async () => [{full_name:'me/public',private:false,html_url:'https://github.com/me/public'}, {full_name:'me/secret',private:true}],
        snapshot: async () => { publicCalls++; return {...snapshot,source:'github',isPublic:true}; }
      },
      localProject: {name:'local/project',snapshot:async()=>{localCalls++;return snapshot;}},
      assistant: {ask:async()=> 'Public answer'},
      send: async (id,text)=>replies.push(text)
    });
    await bot.handle(message('/start',2));
    assert.ok(!replies.at(-1).includes('/local'));
    await bot.handle(message('/repos',2));
    assert.ok(replies.at(-1).includes('me/public'));
    assert.ok(!replies.at(-1).includes('me/secret'));
    await bot.handle(message('/local',2));
    assert.equal(localCalls,0);
    await bot.handle(message('/repo project',2));
    await bot.handle(message('Explain project',2));
    assert.equal(replies.at(-1),'Public answer');
    assert.equal(privateCalls,0); assert.equal(publicCalls,1);
    assert.equal(bot.sessions.has('1'),false);
    bot.publicGithub.snapshot = async()=>({...snapshot,source:'github',isPublic:false});
    await bot.handle(message('/repo secret',3));
    assert.equal(bot.sessions.has('3'),false);
    bot.state['3']='local/project';
    await bot.handle(message('/refresh',3));
    assert.equal(localCalls,0);
    bot.sessions.set('4',{snapshot:{...snapshot,source:'local'},history:[]});
    await bot.handle(message('/file README.md',4));
    assert.ok(!replies.at(-1).includes('# Project'));
  });

  await check('Public users have daily AI and indexing limits; the owner does not', async () => {
    const replies = []; let asks = 0, snapshots = 0;
    const bot = new Bot({
      config: { ...config, publicAccess: true, publicDailyQuestions: 2, publicDailyIndexes: 1 },
      github: { repos: async () => [], snapshot: async () => { snapshots++; return { ...snapshot, source: 'github', isPublic: true }; } },
      publicGithub: { repos: async () => [], snapshot: async () => { snapshots++; return { ...snapshot, source: 'github', isPublic: true }; } },
      assistant: { ask: async () => { asks++; return 'AI answer'; } },
      send: async (id, text) => replies.push(text)
    });
    await bot.handle(message('/repo project', 2));
    await bot.handle(message('/refresh', 2));
    assert.equal(snapshots, 1); assert.match(replies.at(-1), /лимит загрузки/);
    for (let i = 0; i < 3; i++) await bot.handle(message('Explain project', 2));
    assert.equal(asks, 2); assert.match(replies.at(-1), /лимит вопросов/);
    await bot.handle(message('/search login', 2));
    assert.ok(!/лимит/.test(replies.at(-1)));
    await bot.handle(message('/repo project', 1)); await bot.handle(message('/refresh', 1));
    for (let i = 0; i < 3; i++) await bot.handle(message('Explain project', 1));
    assert.equal(snapshots, 3); assert.equal(asks, 5);
    bot.usage.get('2').day = '2000-01-01';
    await bot.handle(message('Explain project', 2));
    assert.equal(asks, 6);
    const missingEnv = pathToFileURL(join(tmpdir(), `repo-bot-missing-${Date.now()}`, '.env'));
    await assert.rejects(loadConfig({ TELEGRAM_BOT_TOKEN: 'x', PUBLIC_DAILY_QUESTIONS: '-1' }, missingEnv), /PUBLIC_DAILY_QUESTIONS/);
    const defaults = await loadConfig({ TELEGRAM_BOT_TOKEN: 'x' }, missingEnv);
    assert.equal(defaults.publicDailyQuestions, 20); assert.equal(defaults.publicDailyIndexes, 5);
  });
  await check('GitHub account parser accepts profiles and rejects paths, credentials and tokens', () => {
    for (const [value, login] of [['alice','alice'], ['@alice','alice'], ['https://github.com/Alice/','Alice'], ['https://github.com/alice?tab=repositories','alice']]) assert.equal(parseAccount(value), login);
    for (const value of ['','-alice','alice-','a'.repeat(40),'alice/project','https://evil.test/alice','https://github.com@evil.test/alice','https://user:pass@github.com/alice','https://github.com:8443/alice','ghp_'+'x'.repeat(30)]) assert.throws(() => parseAccount(value));
  });
  await check('Personal GitHub selection, repositories and histories are isolated by Telegram user', async () => {
    const replies = [], asked = [], listed = [], indexed = [];
    let savedAccounts = {}, savedSelected = {}, privateCalls = 0;
    const bot = new Bot({
      config: {...config, publicAccess:true},
      github: {repos:async()=>{privateCalls++;return[];},snapshot:async()=>{privateCalls++;return snapshot;}},
      publicGithub: {
        profile: async login=>({login,type:'User'}),
        repos:async login=>{listed.push(login);return [{full_name:login+'/project',private:false,html_url:'https://github.com/'+login+'/project'}, {full_name:login+'/secret',private:true}];},
        snapshot:async name=>{indexed.push(name);return {...snapshot,name,source:'github',isPublic:true};}
      },
      assistant:{ask:async(s,text,history)=>{asked.push({name:s.name,history:history.map(x=>({...x}))});return s.name;}},
      send:async(id,text)=>replies.push({id,text}),
      save:async(selected,accounts)=>{savedSelected={...selected};if(accounts!==undefined)savedAccounts={...accounts};}
    });
    await bot.handle(message('/github alice',2));
    await bot.handle(message('/github https://github.com/bob',3));
    await bot.handle(message('/repos',2)); assert.match(replies.at(-1).text,/alice\/project/); assert.ok(!replies.at(-1).text.includes('secret'));
    await bot.handle(message('/repos',3)); assert.match(replies.at(-1).text,/bob\/project/);
    assert.deepEqual(listed,['alice','bob']);
    await bot.handle(message('/repo project',2)); await bot.handle(message('/repo project',3));
    assert.deepEqual(indexed,['alice/project','bob/project']);
    await bot.handle(message('Question Alice',2)); await bot.handle(message('Question Bob',3)); await bot.handle(message('Follow-up Alice',2));
    assert.equal(asked[0].history.length,0); assert.equal(asked[1].history.length,0); assert.equal(asked[2].history.length,2);
    assert.equal(asked[2].history[0].content,'Question Alice');
    assert.equal(bot.sessions.get('3').history[0].content,'Question Bob');
    await bot.handle(message('/github charlie',2));
    assert.equal(bot.sessions.has('2'),false); assert.equal(bot.sessions.has('3'),true);
    assert.equal(savedSelected['2'],undefined); assert.equal(savedSelected['3'],'bob/project');
    assert.deepEqual(savedAccounts,{'2':'charlie','3':'bob'});
    await bot.handle(message('/repo https://github.com/bob/other',2));
    assert.equal(indexed.at(-1),'bob/other'); assert.equal(bot.account('2'),'charlie');
    await bot.handle(message('/disconnect',2));
    assert.deepEqual(savedAccounts,{'3':'bob'}); assert.equal(bot.sessions.has('3'),true); assert.equal(bot.sessions.has('2'),false);
    assert.equal(privateCalls,0);
    await bot.handle(message('/repo alice/project'));
    assert.equal(indexed.at(-1),'alice/project'); assert.equal(privateCalls,0);
  });
  await check('Invalid accounts and failed account saves preserve the working project and history', async () => {
    const replies = []; let lookups = 0, saves = 0;
    const bot = new Bot({
      config:{...config,publicAccess:true}, githubAccounts:{'2':'alice'},state:{'2':'alice/project'},
      publicGithub:{profile:async login=>{lookups++;if(login==='missing')throw new Error('GitHub: HTTP 404');return {login};}},
      send:async(id,text)=>replies.push(text),save:async()=>{saves++;throw new Error('disk unavailable');}
    });
    const session={snapshot:{...snapshot,name:'alice/project',source:'github',isPublic:true},history:[{role:'user',content:'keep'}]};
    bot.sessions.set('2',session);
    await bot.handle(message('/github https://evil.test/alice',2));
    assert.equal(lookups,0);assert.equal(saves,0);
    await bot.handle(message('/github missing',2));assert.equal(saves,0);
    await bot.handle(message('/github bob',2));assert.equal(saves,1);
    assert.equal(bot.account('2'),'alice');assert.equal(bot.state['2'],'alice/project');assert.equal(bot.sessions.get('2'),session);
    await bot.handle(message('/disconnect',2));assert.equal(bot.account('2'),'alice');assert.equal(bot.sessions.get('2'),session);
    assert.match(replies.at(-1),/disk unavailable/);
  });
  await check('Owner credentials are never used for another account or profile lookup', async () => {
    const requests=[];
    const github=new GitHub({...config,githubToken:'owner-secret'},async(url,options)=>{
      const target=new URL(url); requests.push(target.pathname);
      assert.equal(options.headers.Authorization,undefined);
      let payload;
      if(target.pathname==='/users/alice')payload={login:'Alice',type:'User'};
      else if(target.pathname==='/users/alice/repos')payload=[{owner:{login:'alice'},private:false,full_name:'alice/project'}];
      else if(target.pathname==='/repos/alice/project')payload={private:false,default_branch:'main'};
      else if(target.pathname.endsWith('/commits/main'))return new Response('{}',{status:409});
      else throw new Error('Unexpected public path: '+target.pathname);
      return new Response(JSON.stringify(payload));
    });
    assert.deepEqual(await github.profile('alice'),{login:'Alice',type:'User'});
    assert.equal((await github.repos('alice'))[0].full_name,'alice/project');
    assert.equal((await github.snapshot('alice/project')).isPublic,true);
    assert.equal(requests.length,4);
    const malformed=new GitHub(config,async()=>new Response(JSON.stringify({login:'other-user',type:'User'})));
    await assert.rejects(malformed.profile('alice'),/GitHub/);
  });
  await check('State migration keeps existing users and validates saved personal GitHub accounts', async () => inTemp(async root=>{
    const path=new URL('state.json',root),legacy={offset:8,selected:{'1':'me/project'}};
    await writeJson(path,legacy);assert.deepEqual(await readState(path),legacy);
    const current={...legacy,githubAccounts:{'2':'Alice'}};
    await writeJson(path,current);assert.deepEqual(await readState(path),current);
    for(const githubAccounts of [null,[],{'2':'https://github.com/alice'},{bad:'alice'},{'2':7},{'2':'../private'}]){
      const raw=JSON.stringify({...legacy,githubAccounts});
      await writeFile(path,raw);await assert.rejects(readState(path),/state.json/);assert.equal(await readFile(path,'utf8'),raw);
    }
  }));
  await check('Public GitHub connections survive polling restart without sharing owner credentials', async () => inTemp(async root=>{
    const sent=[],requests=[];let menu=false;
    const launch=async updates=>{
      const controller=new AbortController();let polls=0;
      await runBot({root,env:{TELEGRAM_BOT_TOKEN:'test',ALLOWED_TELEGRAM_IDS:'1',GITHUB_OWNER:'me',GITHUB_TOKEN:'owner-secret',PUBLIC_ACCESS:'true',PUBLIC_DAILY_INDEXES:'2'},
        signal:AbortSignal.any([controller.signal,AbortSignal.timeout(5000)]),pause:async()=>setImmediate(),
        logger:{log(){},warn(){},error(error){throw new Error(error);}},
        fetcher:async(url,options)=>{
          const target=new URL(url);
          if(target.hostname==='api.telegram.org'){
            const method=target.pathname.split('/').at(-1),body=JSON.parse(options.body);let result=true;
            if(method==='getMe')result={username:'testbot'};
            else if(method==='getWebhookInfo')result={url:''};
            else if(method==='setMyCommands'){menu=body.commands.some(x=>x.command==='github')&&body.commands.some(x=>x.command==='disconnect');}
            else if(method==='sendMessage')sent.push({id:body.chat_id,text:body.text});
            else if(method==='getUpdates'){if(++polls===1)result=updates;else{controller.abort();result=[];}}
            return new Response(JSON.stringify({ok:true,result}));
          }
          assert.equal(options.headers?.Authorization,undefined);requests.push(target.pathname);
          if(target.hostname==='raw.githubusercontent.com')return new Response('# Public project\nnpm start');
          let data;
          if(/^\/users\/(alice|bob)$/.test(target.pathname))data={login:target.pathname.split('/')[2],type:'User'};
          else if(/^\/users\/(alice|bob)\/repos$/.test(target.pathname)){const login=target.pathname.split('/')[2];data=[{owner:{login},full_name:login+'/project',private:false,html_url:'https://github.com/'+login+'/project'}];}
          else if(/^\/repos\/(alice|bob)\/project$/.test(target.pathname))data={default_branch:'main',private:false};
          else if(target.pathname.endsWith('/commits/main'))data={sha:'abc123',commit:{tree:{sha:'tree123'}}};
          else if(target.pathname.includes('/git/trees/'))data={tree:[{type:'blob',mode:'100644',path:'README.md',size:30,sha:'blob123'}]};
          else if(target.pathname.endsWith('/commits'))data=[];
          else throw new Error('Unexpected GitHub path '+target.pathname);
          return new Response(JSON.stringify(data));
        }});
    };
    await launch([
      {update_id:10,message:message('/github alice',2)},{update_id:11,message:message('/github bob',3)},
      {update_id:12,message:message('/repo project',2)},{update_id:13,message:message('/repo project',3)}
    ]);
    assert.ok(menu);
    const first=await readState(new URL('data/state.json',root));
    const day=new Date().toISOString().slice(0,10);
    assert.deepEqual(first,{offset:14,selected:{'2':'alice/project','3':'bob/project'},githubAccounts:{'2':'alice','3':'bob'},usage:{'2':{day,questions:0,indexes:1},'3':{day,questions:0,indexes:1}}});
    const count=requests.filter(p=>p==='/repos/alice/project').length;
    await launch([{update_id:14,message:message('/github',2)},{update_id:15,message:message('/repos',3)},{update_id:16,message:message('/refresh',2)}]);
    assert.ok(sent.some(x=>x.id===2&&x.text.includes('GitHub для /repos: alice')));
    assert.ok(sent.some(x=>x.id===3&&x.text.includes('bob/project')));
    assert.equal(requests.filter(p=>p==='/repos/alice/project').length,count+1);
    const second=await readState(new URL('data/state.json',root));
    assert.deepEqual(second.githubAccounts,first.githubAccounts);assert.deepEqual(second.selected,first.selected);assert.equal(second.offset,17);
    assert.equal(second.usage['2'].indexes,2);
    const before=requests.filter(p=>p==='/repos/alice/project').length;
    await launch([{update_id:17,message:message('/repo project',2)},{update_id:18,message:message('/refresh',2)}]);
    assert.equal(requests.filter(p=>p==='/repos/alice/project').length,before);
    assert.equal((await readState(new URL('data/state.json',root))).usage['2'].indexes,2);
  }));

  await check('Daily quota survives restart and disconnect, resets at UTC midnight and exempts owners', async () => {
    let saved={},day='2026-11-19',writes=0;
    const options={config:{...config,publicAccess:true,publicDailyQuestions:2,publicDailyIndexes:1},
      saveUsage:async value=>{saved=structuredClone(value);writes++;},now:()=>new Date(day+'T23:59:59Z')};
    const first=new Bot(options);
    await first.spend('2','questions');await first.spend('2','questions');await first.spend('2','indexes');
    assert.deepEqual(saved['2'],{day,questions:2,indexes:1});
    const restored=new Bot({...options,usage:saved});
    await assert.rejects(restored.spend('2','questions'));
    await assert.rejects(restored.spend('2','indexes'));
    await restored.setAccount('2',null);
    await assert.rejects(restored.spend('2','questions'));
    await restored.spend('3','questions');assert.equal(saved['3'].questions,1);
    const before=writes;
    await restored.spend('1','questions');await restored.spend('1','indexes');assert.equal(writes,before);assert.equal(saved['1'],undefined);
    day='2026-11-20';
    await restored.spend('2','questions');assert.deepEqual(saved,{'2':{day,questions:1,indexes:0}});
    const original={day,questions:1,indexes:0};
    const isolated=new Bot({...options,usage:{'2':original}});
    await isolated.spend('2','questions');assert.equal(original.questions,1);
  });
  await check('Quota persistence fails closed before GitHub and AI without changing live usage', async () => {
    let indexed=0,asked=0;const replies=[];
    const bot=new Bot({config:{...config,publicAccess:true},
      publicGithub:{snapshot:async()=>{indexed++;return {...snapshot,source:'github',isPublic:true};}},
      assistant:{ask:async()=>{asked++;return 'answer';}},send:async(id,text)=>replies.push(text),
      saveUsage:async()=>{throw new Error('quota storage unavailable');}});
    bot.sessions.set('2',{snapshot:{...snapshot,source:'github',isPublic:true},history:[]});
    await bot.handle(message('/repo project',2));await bot.handle(message('Explain project',2));
    assert.equal(indexed,0);assert.equal(asked,0);assert.equal(bot.usage.size,0);
    assert.ok(replies.every(text=>text.includes('quota storage unavailable')));
  });
  await check('State validates quota entries and preserves corrupted quota files', async()=>inTemp(async root=>{
    const path=new URL('state.json',root),legacy={offset:1,selected:{}};
    await writeJson(path,legacy);assert.deepEqual(await readState(path),legacy);
    const entry={day:'2026-11-19',questions:2,indexes:1};
    await writeJson(path,{...legacy,usage:{'2':entry}});
    assert.deepEqual((await readState(path)).usage,{'2':entry});
    for(const usage of [null,[],{bad:entry},{'2':{...entry,questions:-1}},{'2':{...entry,questions:1.5}},
      {'2':{...entry,indexes:'1'}},{'2':{...entry,day:'2026-02-30'}},{'2':{...entry,day:'invalid'}}]){
      const text=JSON.stringify({...legacy,usage});await writeFile(path,text);
      await assert.rejects(readState(path));assert.equal(await readFile(path,'utf8'),text);
    }
  }));

  await check('Publication rejects secrets and private paths while allowing the documented dummy fixture', async()=>{
    for(const path of ['.env','data/state.json','PROGRESS.md','src/../.env','src/.git/config'])assert.equal(approvedPath(path),false);
    assert.equal(approvedPath('.env.example'),true);assert.equal(approvedPath('src/bot.mjs'),true);
    const file=(path,source)=>({path,bytes:Buffer.from(source,'utf8')});
    const key='xai-'+'p'.repeat(32);
    assert.throws(()=>auditFiles([file('src/main.mjs','const key="'+key+'";')]),error=>error.message.includes('credential')&&!error.message.includes(key));
    assert.throws(()=>auditFiles([file('README.md','private-value')],['private-value']));
    assert.throws(()=>auditFiles([file('PROGRESS.md','# Internal notes')]));
    auditFiles([file('test/run.mjs','ghp_'+'123456789012345678901234')]);
  });
  await check('Publication reads fresh UTF-8 source and excludes runtime files and internal notes',async()=>inTemp(async root=>{
    await mkdir(new URL('src/',root));await mkdir(new URL('data/',root));
    await writeFile(new URL('README.md',root),'# Safe source','utf8');
    await writeFile(new URL('src/main.mjs',root),'export const version=1;','utf8');
    await writeFile(new URL('.env',root),'TELEGRAM_BOT_TOKEN=private-local-value','utf8');
    await writeFile(new URL('PROGRESS.md',root),'private-local-value','utf8');
    await writeFile(new URL('data/state.json',root),'private-local-value','utf8');
    const first=await readPublication(root);
    assert.deepEqual(first.files.map(x=>x.path),['README.md','src/main.mjs']);
    await writeFile(new URL('src/main.mjs',root),'export const version=2;','utf8');
    const second=await readPublication(root);
    assert.notEqual(second.files.find(x=>x.path==='src/main.mjs').sha256,first.files.find(x=>x.path==='src/main.mjs').sha256);
    await writeFile(new URL('src/main.mjs',root),Buffer.from([0xff]));
    await assert.rejects(readPublication(root));
  }));
  return { passed };
}

export const result = await runTests();
console.log(`Passed: ${result.passed}`);
