import { queryTerms, retrieve } from './retrieval.mjs';

export function recentCommits(snapshot) {
  if (!snapshot.commits.length) return 'В этом снимке нет коммитов.';
  return `Последние коммиты ${snapshot.name}:\n\n${snapshot.commits.map(commit =>
    `${commit.sha} · ${commit.date || 'дата неизвестна'}\n${commit.message}\n${commit.url}`
  ).join('\n\n')}`;
}

function excerpt(source, question) {
  const terms = queryTerms(question);
  const lines = source.body.split('\n');
  let best = 0, bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase();
    const score = terms.reduce((total, term) => total + Number(line.includes(term)), 0);
    if (score > bestScore) { best = i; bestScore = score; }
  }
  const start = Math.max(0, best - 3);
  const shown = lines.slice(start, start + 12);
  const first = source.start + start, last = first + shown.length - 1;
  return `${source.path}:${first}-${last}\n${shown.map(line => line.slice(0, 240)).join('\n')}${source.url ? `\n${source.url}#L${first}-L${last}` : ''}`;
}

export function searchRepository(snapshot, question, history = []) {
  if (!snapshot.files.length) return 'В индексе нет текстовых файлов. Репозиторий пуст или файлы исключены фильтрами. Проверь /tree.';
  const sources = retrieve(snapshot, question, history, { limit: 3, requireMatch: true });
  if (!sources.length) return `В проиндексированных файлах совпадений не найдено. Попробуй имя функции, путь или другой запрос: /search слово.\nПроверь /tree; обновить индекс — /refresh.\nСнимок: ${snapshot.sha?.slice(0, 8)}. Файлов в индексе: ${snapshot.files.length}.`;
  return `Найденные фрагменты ${snapshot.name}:\n\n${sources.map(source => excerpt(source, question)).join('\n\n')}\n\nСнимок: ${snapshot.sha?.slice(0, 8)}. Файлов в индексе: ${snapshot.files.length}.${snapshot.warnings.length ? `\n${snapshot.warnings.join('\n')}` : ''}\nПолный файл: /file путь`;
}

export function answerLocally(snapshot, question, history = []) {
  const commitsQuestion = /коммит|что (?:изменилось|менялось|нового)|последни.{0,15}измен|\bcommits?\b|recent changes/i.test(question);
  const overview = /как.{0,25}(?:работает|устроен)|что.{0,20}(?:за проект|делает)|обзор|архитектур|overview|how.*work/i.test(question);
  let answer;
  if (commitsQuestion) answer = recentCommits(snapshot);
  else if (overview && snapshot.source !== 'local' && snapshot.tree.length === 1 && /^readme(?:\.[^/]+)?$/i.test(snapshot.tree[0])) {
    answer = `В снимке ${snapshot.name} есть только README. По нему нельзя проверить устройство исходного кода.\n${snapshot.files[0]?.text || ''}\n\nДля локального кода этого бота используй /local. Для другого проекта выбери /repos → /repo имя.`;
  } else answer = searchRepository(snapshot, overview ? 'README.md package.json main index app' : question, history);
  return `Режим без ИИ: поиск по коду и данным GitHub.\n\n${answer}`;
}
