import { readFile, readdir, mkdir, writeFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname, sep } from 'node:path';
import { parseEnv } from '../src/config.mjs';
import { redact } from '../src/github.mjs';

const defaultRoot = fileURLToPath(new URL('../', import.meta.url));
const repository = 'kenshiki36-blip/RAG-BOT';
const remoteUrl = 'https://github.com/' + repository + '.git';
const rootFiles = new Set(['.gitignore', '.env.example', 'README.md', 'package.json',
  'start.cmd', 'restart.cmd', 'setup-gemini.cmd', 'setup-grok.cmd', 'setup-groq.cmd',
  'check-gemini.cmd', 'publish-github.cmd']);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const text = bytes => {
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return bytes.toString('utf8');
};
export function approvedPath(path) {
  if (typeof path !== 'string' || path.split('/').some(part => ['..', '.', 'data', 'node_modules', '.git', 'PROGRESS.md'].includes(part))) return false;
  return rootFiles.has(path) || /^(?:src|scripts|test)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.mjs$/.test(path);
}
export function auditFiles(files, secrets = []) {
  const paths = new Set();
  for (const file of files) {
    if (!approvedPath(file.path) || paths.has(file.path)) throw new Error('Unapproved or duplicate publication path: ' + file.path);
    paths.add(file.path);
    const source = text(file.bytes);
    if (secrets.some(value => value && source.includes(value))) throw new Error('Local private value detected in ' + file.path);
    const tokens = source.match(/\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{35}|AQ\.[A-Za-z0-9_-]{20,512}|gsk_[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9_-]{16,}|\d{6,}:[A-Za-z0-9_-]{25,})\b/g) || [];
    for (const token of tokens) {
      if (file.path === 'test/run.mjs' && token === 'ghp_' + '123456789012345678901234') continue;
      throw new Error('Potential credential detected in ' + file.path);
    }
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(source)) throw new Error('Private key detected in ' + file.path);
  }
}
export async function readPublication(base = defaultRoot) {
  const root = base instanceof URL ? fileURLToPath(base) : resolve(base);
  const files = [];
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isDirectory()) {
        if ((!prefix && ['src', 'scripts', 'test'].includes(entry.name))
          || (prefix && /^[A-Za-z0-9_-]+$/.test(entry.name) && entry.name !== 'node_modules')) await visit(resolve(directory, entry.name), path + '/');
      } else if (approvedPath(path)) {
        const source = resolve(root, path);
        const info = await lstat(source);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('Publication input is not a regular file: ' + path);
        const bytes = await readFile(source);
        files.push({ path, bytes, sha256: digest(bytes) });
      }
    }
  }
  await visit(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  let settings = {};
  try { settings = parseEnv(text(await readFile(resolve(root, '.env')))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const secrets = [...Object.entries(settings), ...Object.entries(process.env)]
    .filter(([name, value]) => /API_KEY|TOKEN|PASSWORD|SECRET/.test(name) && typeof value === 'string' && value.length >= 12)
    .map(([, value]) => value);
  secrets.push(...(settings.ALLOWED_TELEGRAM_IDS || '').split(',').map(x => x.trim()).filter(x => x.length >= 6));
  auditFiles(files, secrets);
  return { root, files, secrets };
}
export async function publish({ root = defaultRoot, check = false } = {}) {
  // Read current files on every run. Never reuse an old source archive or manifest.
  const source = await readPublication(root);
  console.log('Audited current UTF-8 source: ' + source.files.length + ' files; .env, data/ and PROGRESS.md excluded.');
  if (check) return { status: 'audited', files: source.files.length };
  for (const path of ['src/main.mjs', 'src/bot.mjs', 'test/run.mjs', 'package.json']) {
    if (!source.files.some(file => file.path === path)) throw new Error('Required publication input missing: ' + path);
  }
  const data = resolve(source.root, 'data');
  const publication = resolve(data, 'github-publication');
  const checkout = resolve(publication, 'checkout-' + Date.now());
  const resultPath = resolve(data, 'github-publication-result.json');
  const result = { repository, startedAt: new Date().toISOString(), status: 'preparing', files: source.files.length };
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const name of Object.keys(env)) if (/^(?:GIT_ASKPASS|SSH_ASKPASS|GCM_INTERACTIVE|VSCODE_GIT_)/.test(name)) delete env[name];
  const git = args => execFileSync('git', ['-c', 'safe.directory=' + checkout, ...args], {
    cwd: checkout, env, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024
  });
  async function unchanged() {
    for (const file of source.files) {
      if (digest(await readFile(resolve(source.root, file.path))) !== file.sha256) throw new Error('Source changed during publication; rerun: ' + file.path);
    }
  }
  try {
    await mkdir(publication, { recursive: true });
    execFileSync('git', ['clone', '--single-branch', '--no-tags', remoteUrl, checkout], {
      cwd: source.root, env, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024
    });
    const branch = git(['symbolic-ref', '--short', 'HEAD']).trim();
    if (branch !== 'main') throw new Error('Unexpected remote branch.');
    for (const line of git(['ls-files', '--stage', '-z']).split('\0').filter(Boolean)) {
      const match = line.match(/^(100644|100755) [a-f0-9]+ 0\t(.+)$/);
      if (!match || !approvedPath(match[2])) throw new Error('Remote contains an unapproved path or symlink; review before publishing.');
    }
    for (const file of source.files) {
      const destination = resolve(checkout, file.path);
      if (!destination.startsWith(checkout + sep)) throw new Error('Path outside checkout.');
      let cursor = checkout;
      for (const part of file.path.split('/')) {
        cursor = resolve(cursor, part);
        try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Remote path is a symlink.'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, file.bytes);
    }
    git(['add', '--', ...source.files.map(file => file.path)]);
    const stagedPaths = git(['ls-files', '-z']).split('\0').filter(Boolean);
    const staged = stagedPaths.map(path => ({ path, bytes: Buffer.from(git(['show', ':' + path]), 'utf8') }));
    auditFiles(staged, source.secrets);
    for (const file of source.files) {
      const actual = staged.find(value => value.path === file.path);
      if (!actual || text(actual.bytes).replace(/\r\n/g, '\n') !== text(file.bytes).replace(/\r\n/g, '\n')) throw new Error('Staged file does not match current source: ' + file.path);
    }
    const tests = execFileSync(process.execPath, ['test/run.mjs'], {
      cwd: checkout, env, windowsHide: true, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024
    });
    const testResult = tests.match(/Passed: \d+/);
    if (!testResult) throw new Error('Published source tests did not report completion.');
    console.log(testResult[0] + ' in the audited Git checkout.');
    await unchanged();
    if (git(['diff', '--cached', '--name-only']).trim()) {
      git(['-c', 'user.name=kenshiki36-blip', '-c', 'user.email=kenshiki36-blip@users.noreply.github.com',
        'commit', '-m', 'Add personal GitHub accounts and persistent public quotas',
        '-m', 'Preserve literal-aware secret redaction; publish audited current source without private runtime files.']);
    }
    result.branch = branch;
    result.commit = git(['rev-parse', 'HEAD']).trim();
    result.status = 'committed';
    await writeFile(resultPath, JSON.stringify(result, null, 2), 'utf8');
    await unchanged();
    git(['push', 'origin', 'HEAD:refs/heads/' + branch]);
    const remote = git(['ls-remote', 'origin', 'refs/heads/' + branch]).trim().split(/\s/)[0];
    if (remote !== result.commit) throw new Error('Remote HEAD does not match the published commit.');
    result.status = 'published';
    result.url = 'https://github.com/' + repository + '/commit/' + result.commit;
    console.log('Published: ' + result.url);
    return result;
  } catch (error) {
    result.status = result.status === 'committed' ? 'push_failed_or_unverified' : 'failed';
    throw new Error(redact(error.message));
  } finally {
    result.finishedAt = new Date().toISOString();
    await mkdir(data, { recursive: true });
    await writeFile(resultPath, JSON.stringify(result, null, 2), 'utf8');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await publish({ check: process.argv.includes('--check') }); }
  catch (error) { console.error(redact(error.message)); process.exitCode = 1; }
}
