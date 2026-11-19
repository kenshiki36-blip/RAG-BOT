import { jsonRequest, textRequest } from './http.mjs';

const excludedDirs = /(^|\/)(node_modules|vendor|dist|build|coverage|\.git|\.venv|venv|__pycache__|\.next)(\/|$)/i;
const textExtension = /\.(md|txt|py|js|mjs|cjs|jsx|ts|tsx|json|yml|yaml|toml|ini|cfg|html|css|scss|sql|sh|ps1|bat|cmd|go|rs|java|kt|c|h|cpp|cs|php|rb|vue|svelte|ipynb)$/i;

export function safePath(path) {
  if (excludedDirs.test(path)) return false;
  const name = path.split('/').at(-1).toLowerCase();
  if (/^\.env(?:\.|$)/.test(name)) return false;
  if (/(secret|credential|private.key|id_rsa|id_ed25519)/i.test(name)) return false;
  if (/\.(pem|key|p12|pfx|sqlite|db)$/i.test(name)) return false;
  if (/^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|uv\.lock)$/.test(name)) return false;
  return textExtension.test(name) || /^(dockerfile|makefile|procfile|license|gemfile)$/i.test(name);
}

export function redact(text) {
  return text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[PRIVATE KEY REMOVED]')
    .replace(/\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,})\b/g, '[TOKEN REMOVED]')
    .replace(/\bAIza[A-Za-z0-9_-]{35}\b/g, '[GOOGLE API KEY REMOVED]')
    .replace(/\bAQ\.[A-Za-z0-9_-]{20,512}\b/g, '[GOOGLE AUTH KEY REMOVED]')
    .replace(/\b(?:gsk_[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9_-]{16,})\b/g, '[AI KEY REMOVED]')
    .replace(/\bAQ[A-Za-z0-9_-]{50}\b/g, '[MALFORMED GOOGLE AUTH KEY REMOVED]')
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{25,}\b/g, '[TELEGRAM TOKEN REMOVED]')
    // Hide literal values only. Comparisons (===, =>) and code references such as
    // req.body.password, process.env.KEY or getpass() stay readable for code answers.
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret|bot[_-]?token)\s*["']?\s*[:=](?![=>])[ \t]*)([^\r\n]*)/gi, (match, prefix, value) => {
      if (!value) return match;
      const quote = value[0];
      if (quote === '"' || quote === "'" || quote === '`') {
        const end = value.indexOf(quote, 1);
        if (end === 1) return match;
        return `${prefix}${quote}[REDACTED]${end > 0 ? value.slice(end) : ''}`;
      }
      // .env style (UPPER_CASE=value): always a literal, never code.
      const envStyle = /^[A-Z0-9_-]+["']?=$/.test(prefix.trim());
      return !envStyle && looksLikeCode(value) ? match : `${prefix}[REDACTED]`;
    });
}

function looksLikeCode(value) {
  if (/^(?:[[{(<$@!]|(?:new|await|function|lambda|async|typeof)\b)/.test(value)) return true;
  // Short identifier chains and calls: req.body.password, os.environ["X"], hash(x). Long segments may be tokens.
  if (/^[A-Za-z_$][\w$]{0,30}(?:(?:\?\.|\.)[A-Za-z_$][\w$]{0,30})*\s*[([]/.test(value)) return true;
  if (/^[A-Za-z_$][\w$]{0,30}(?:(?:\?\.|\.)[A-Za-z_$][\w$]{0,30})+(?![\w$.-])/.test(value)) return true;
  // Keywords, types and a variable followed by code punctuation: `password: string;`, `password = input;`.
  if (/^(?:null|undefined|None|nil|true|false|True|False|string|number|boolean|any|str|int|bytes|Optional\b.*)\s*[;,)]?\s*$/.test(value)) return true;
  return /^[A-Za-z_$][\w$]{0,30}\s*[;,)]/.test(value);
}

export function parseAccount(value) {
  const invalid = () => new Error('Укажи логин GitHub или ссылку https://github.com/логин.');
  if (typeof value !== 'string') throw invalid();
  let login = value.trim();
  if (/^https:\/\//i.test(login)) {
    let url;
    try { url = new URL(login); } catch { throw invalid(); }
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.port || url.username || url.password) throw invalid();
    login = url.pathname.replace(/^\//, '').replace(/\/$/, '');
  }
  login = login.replace(/^@/, '');
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login)) throw invalid();
  return login;
}

export function parseRepo(value, owner) {
  let text = value.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, '').replace(/\.git$/, '');
  if (!text.includes('/')) text = `${owner}/${text}`;
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(text) || text.split('/')[1] === '..') throw new Error('Укажи имя, owner/repo или ссылку https://github.com/owner/repo');
  return text;
}

export class GitHub {
  constructor({ owner, githubToken, maxFiles }, fetcher = fetch) {
    this.owner = owner; this.token = githubToken; this.maxFiles = maxFiles; this.fetcher = fetcher;
  }
  get(path) {
    return jsonRequest(`https://api.github.com${path}`, { service: 'GitHub', headers: {
      Accept: 'application/vnd.github+json', 'User-Agent': 'RepoTelegramBot',
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
    } }, this.fetcher);
  }
  anonymous(owner = this.owner) {
    return new GitHub({ owner, githubToken: '', maxFiles: this.maxFiles }, this.fetcher);
  }
  async profile(value) {
    const owner = parseAccount(value);
    const profile = await this.anonymous(owner).get(`/users/${owner}`);
    if (typeof profile?.login !== 'string' || parseAccount(profile.login).toLowerCase() !== owner.toLowerCase()
      || !['User', 'Organization'].includes(profile.type)) throw new Error('GitHub вернул некорректный профиль.');
    return { login: profile.login, type: profile.type };
  }
  async repos(value = this.owner) {
    const owner = parseAccount(value);
    if (owner.toLowerCase() !== this.owner.toLowerCase()) return this.anonymous(owner).repos();
    const output = [];
    // Authenticated listing includes private repos; filter to the configured owner.
    const endpoint = this.token ? '/user/repos?affiliation=owner,collaborator,organization_member&sort=updated' : `/users/${this.owner}/repos?sort=updated`;
    for (let page = 1; page <= 100; page++) {
      const items = await this.get(`${endpoint}&per_page=100&page=${page}`);
      output.push(...items.filter(item => item.owner.login.toLowerCase() === this.owner.toLowerCase()));
      if (items.length < 100) return output;
    }
    throw new Error('Слишком много репозиториев для списка. Выбери проект через /repo owner/name.');
  }
  async snapshot(name) {
    name = parseRepo(name, this.owner);
    if (this.token && name.split('/')[0].toLowerCase() !== this.owner.toLowerCase()) return this.anonymous().snapshot(name);
    const meta = await this.get(`/repos/${name}`);
    let commit;
    try { commit = await this.get(`/repos/${name}/commits/${encodeURIComponent(meta.default_branch)}`); }
    catch (error) {
      if (error.status === 409) return { name, source: 'github', isPublic: meta.private === false, sha: null, tree: [], files: [], commits: [], warnings: ['Репозиторий пуст.'] };
      throw error;
    }
    const sha = commit.sha;
    const tree = await this.get(`/repos/${name}/git/trees/${commit.commit.tree.sha}?recursive=1`);
    if (tree.truncated) throw new Error('GitHub вернул неполное дерево: репозиторий слишком большой. Выбери меньший проект.');
    const entries = tree.tree.filter(x => x.type === 'blob' && x.mode !== '120000');
    const candidates = entries.filter(x => safePath(x.path) && x.size <= 100000).sort((a, b) => priority(b.path) - priority(a.path) || a.path.localeCompare(b.path));
    const chosen = candidates.slice(0, this.maxFiles);
    const files = [], warnings = [];
    // Sequential downloads keep API traffic predictable and expose rate-limit failures.
    for (const entry of chosen) {
      let text;
      if (meta.private === false) {
        // Public raw files do not consume the small anonymous REST API quota.
        // Pin to the commit and never forward credentials to the raw host.
        const url = `https://raw.githubusercontent.com/${name}/${sha}/${entry.path.split('/').map(encodeURIComponent).join('/')}`;
        text = await textRequest(url, { service: 'GitHub', maxBytes: 100000 }, this.fetcher);
      } else {
        const blob = await this.get(`/repos/${name}/git/blobs/${entry.sha}`);
        if (blob.encoding !== 'base64') continue;
        text = Buffer.from(blob.content.replace(/\s/g, ''), 'base64').toString('utf8');
      }
      if (text.includes('\0')) continue;
      files.push({ path: entry.path, text: redact(text), url: `https://github.com/${name}/blob/${sha}/${entry.path.split('/').map(encodeURIComponent).join('/')}` });
    }
    const commits = await this.get(`/repos/${name}/commits?sha=${sha}&per_page=5`);
    if (candidates.length > chosen.length) warnings.push(`Лимит индекса: ${chosen.length} из ${candidates.length} подходящих файлов.`);
    if (entries.length === 1 && /^readme(?:\.[^/]+)?$/i.test(entries[0].path)) warnings.push('В этом снимке GitHub есть только README. Файлы исходного кода не опубликованы.');
    return { name, sha, source: 'github', isPublic: meta.private === false, branch: meta.default_branch, description: redact(meta.description || ''),
      tree: entries.map(x => x.path), files, warnings,
      commits: commits.map(x => ({ sha: x.sha.slice(0, 8), message: redact(x.commit.message.slice(0, 1000)), date: x.commit.author?.date, url: x.html_url })) };
  }
}

function priority(path) {
  return /(^|\/)(readme|package\.json|pyproject\.toml|requirements|dockerfile|compose|main\.|app\.|index\.)/i.test(path) ? 10 : 0;
}
