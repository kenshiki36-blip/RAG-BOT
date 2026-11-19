import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact, safePath } from './github.mjs';

const excluded = new Set(['data', 'node_modules', 'vendor', 'dist', 'build', 'coverage', '.git', '.agents', '.codex', '.aws', '.ssh', '.venv', 'venv', '__pycache__', '.next']);

export class LocalProject {
  constructor(root, maxFiles = 100) {
    this.root = root instanceof URL ? fileURLToPath(root) : root;
    this.maxFiles = maxFiles;
    this.name = 'local/RAG-BOT';
  }
  async snapshot() {
    const root = await realpath(this.root);
    const entries = [], warnings = [];
    let visited = 0;
    const withinRoot = path => { const part = relative(root, path); return part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); };
    const walk = async directory => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (++visited > 10000) return;
        if (entry.isSymbolicLink() || excluded.has(entry.name.toLowerCase())) continue;
        const path = join(directory, entry.name);
        const actual = await realpath(path);
        if (!withinRoot(actual)) continue;
        if (entry.isDirectory()) await walk(actual);
        else if (entry.isFile()) {
          const name = relative(root, path).split(sep).join('/');
          if (!safePath(name)) continue;
          const info = await stat(actual);
          if (info.size <= 100000) entries.push({ path: name, actual });
        }
      }
    };
    await walk(root);
    if (visited > 10000) warnings.push('Локальное дерево ограничено первыми 10000 записями.');
    const priority = path => /(^|\/)(readme|package\.json|main\.|app\.|index\.)/i.test(path) ? 10 : 0;
    entries.sort((a, b) => priority(b.path) - priority(a.path) || a.path.localeCompare(b.path));
    const files = [];
    for (const entry of entries.slice(0, this.maxFiles)) {
      const bytes = await readFile(entry.actual);
      if (bytes.length > 100000 || bytes.includes(0)) continue;
      files.push({ path: entry.path, text: redact(bytes.toString('utf8').replace(/^\uFEFF/, '')), url: '' });
    }
    if (entries.length > this.maxFiles) warnings.push(`Лимит локального индекса: ${this.maxFiles} из ${entries.length} подходящих файлов.`);
    const digest = createHash('sha256');
    for (const file of files) digest.update(file.path).update('\0').update(file.text).update('\0');
    return { name: this.name, source: 'local', sha: `local-${digest.digest('hex')}`, branch: 'local',
      description: 'Локальные исходники этого Telegram-бота. Этот снимок прочитан с компьютера владельца и не опубликован на GitHub.',
      tree: entries.map(entry => entry.path), files, commits: [], warnings };
  }
}
