export function chunks(snapshot) {
  return snapshot.files.flatMap(file => {
    const lines = file.text.split('\n'), result = [];
    for (let start = 0; start < lines.length; start += 60) {
      // Split giant generated lines too: never let a chunk consume the whole budget.
      const body = lines.slice(start, start + 80).map((line, i) => `${start + i + 1}: ${line.slice(0, 1500)}`).join('\n').slice(0, 9000);
      result.push({ path: file.path, start: start + 1, end: Math.min(start + 80, lines.length), body, url: file.url });
    }
    return result;
  });
}

const stopWords = new Set('как что где когда почему зачем это этот этой мне меня для или есть какие какой какая каком проект проекта проекте project repository устроен устроена работает пожалуйста покажи расскажи explain show the and how what where does this that about'.split(' '));

export function queryTerms(question) {
  const text = question.toLowerCase();
  const terms = (text.match(/[\p{L}\p{N}_./-]{2,}/gu) || []).filter(term => !stopWords.has(term));
  if (/запуск|запуст|установ|сборк|собра|развер|развёр|install|setup|deploy/.test(text)) terms.push('start', 'install', 'scripts', 'run', 'docker', 'requirements');
  if (/авториз|аутентиф|логин|токен|парол|auth|login/.test(text)) terms.push('auth', 'token', 'login', 'password', 'session');
  if (/точк.{0,12}вход|entry.?point/.test(text)) terms.push('main', 'index', 'app', 'scripts');
  if (/настрой|переменн|конфиг|config|environment/.test(text)) terms.push('config', 'env', 'settings');
  if (/тест|провер|test/.test(text)) terms.push('test', 'assert', 'spec');
  if (/зависим|dependenc/.test(text)) terms.push('dependencies', 'requirements', 'pyproject', 'package.json');
  return [...new Set(terms)];
}

export function retrieve(snapshot, question, history = [], { limit = 9, budget = 42000, requireMatch = false } = {}) {
  // History helps short follow-up questions without swamping a new search topic.
  const followUp = /^(а |и |это|этот|эта|подробнее|почему|and |why |it\b)/i.test(question.trim());
  const terms = queryTerms(`${question} ${followUp ? history.slice(-2).map(x => x.content).join(' ') : ''}`);
  const ranked = chunks(snapshot).map(chunk => {
    const body = chunk.body.toLowerCase(), path = chunk.path.toLowerCase();
    let score = /readme|package\.json|pyproject|requirements|dockerfile|compose/i.test(path) ? 2 : 0;
    if (/как.{0,25}(?:работает|устроен)|обзор|архитектур|overview|how.*work/i.test(question)
      && /(^|\/)(readme|package\.json|main\.|app\.|index\.)/i.test(path)) score += chunk.start === 1 ? 15 : 5;
    let matches = 0;
    for (const term of terms) {
      if (path.includes(term)) { score += 12; matches++; }
      if (body.includes(term)) { score += 3; matches++; }
    }
    // Russian questions about launch/auth still find common English code terms.
    if (/запуск|запуст|установ/i.test(question) && /start|install|scripts|main|run/.test(body)) score += 4;
    if (/авториз|токен/i.test(question) && /auth|token|login/.test(body)) score += 4;
    return { ...chunk, score, matches };
  }).filter(chunk => !requireMatch || chunk.matches > 0).sort((a, b) => b.score - a.score);
  const selected = [];
  for (const item of ranked) {
    if (selected.length >= limit) break;
    if (item.body.length > budget) continue;
    // Adjacent windows overlap by 20 lines. Avoid returning the same code twice.
    if (selected.some(previous => previous.path === item.path && previous.start <= item.end && item.start <= previous.end)) continue;
    selected.push(item); budget -= item.body.length;
  }
  return selected;
}
