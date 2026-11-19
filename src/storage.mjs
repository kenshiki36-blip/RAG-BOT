import { createHash, randomUUID } from 'node:crypto';
import { parseAccount } from './github.mjs';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';

export async function writeJson(path, value) {
  const temp = new URL(`.${randomUUID()}.tmp`, path);
  try {
    await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export async function readState(path) {
  try {
    const state = JSON.parse(await readFile(path, 'utf8'));
    if (!Number.isSafeInteger(state.offset) || state.offset < 0 || !state.selected || typeof state.selected !== 'object' || Array.isArray(state.selected)
      || Object.entries(state.selected).some(([id, name]) => !/^\d+$/.test(id) || typeof name !== 'string')) throw new Error('invalid');
    if (state.githubAccounts !== undefined) {
      const accounts = state.githubAccounts;
      if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts)
        || Object.entries(accounts).some(([id, login]) => !/^\d+$/.test(id) || typeof login !== 'string' || parseAccount(login) !== login)) throw new Error('invalid');
    }
    if (state.usage !== undefined) {
      if (!state.usage || typeof state.usage !== 'object' || Array.isArray(state.usage)) throw new Error('invalid');
      for (const [id, entry] of Object.entries(state.usage)) {
        if (!/^\d+$/.test(id) || !entry || typeof entry !== 'object' || Array.isArray(entry)
          || typeof entry.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.day)
          || !Number.isFinite(Date.parse(entry.day + 'T00:00:00Z')) || new Date(entry.day + 'T00:00:00Z').toISOString().slice(0, 10) !== entry.day
          || !Number.isSafeInteger(entry.questions) || entry.questions < 0
          || !Number.isSafeInteger(entry.indexes) || entry.indexes < 0) throw new Error('invalid');
      }
    }
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return { offset: 0, selected: {} };
    throw new Error('Не удалось прочитать data/state.json. Проверь или переименуй файл; исходный файл сохранён.');
  }
}

export class SnapshotStore {
  constructor(directory, maxFiles = 500) { this.directory = directory; this.maxFiles = maxFiles; }
  path(name) { return new URL(`${createHash('sha256').update(name.toLowerCase()).digest('hex')}.json`, this.directory); }
  async save(name, session) {
    await mkdir(this.directory, { recursive: true });
    await writeJson(this.path(name), { version: 1, indexedAt: session.indexedAt, snapshot: session.snapshot });
  }
  async load(name) {
    try {
      const value = JSON.parse(await readFile(this.path(name), 'utf8'));
      if (!value || typeof value !== 'object') return null;
      const snapshot = value.snapshot;
      const strings = array => Array.isArray(array) && array.every(item => typeof item === 'string');
      if (value.version !== 1 || typeof value.indexedAt !== 'string' || !Number.isFinite(Date.parse(value.indexedAt)) || typeof snapshot?.name !== 'string' || snapshot.name.toLowerCase() !== name.toLowerCase()
        || !(snapshot.sha === null || typeof snapshot.sha === 'string') || !strings(snapshot.tree) || !strings(snapshot.warnings)
        || !Array.isArray(snapshot.commits) || snapshot.commits.some(item => !item || typeof item.sha !== 'string' || typeof item.message !== 'string' || typeof item.url !== 'string')
        || !Array.isArray(snapshot.files) || snapshot.files.length > this.maxFiles
        || snapshot.files.some(item => !item || typeof item.path !== 'string' || typeof item.text !== 'string' || typeof item.url !== 'string')) return null;
      return { snapshot, indexedAt: value.indexedAt, history: [] };
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
  }
}
