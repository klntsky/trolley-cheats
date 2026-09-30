const body = document.querySelector('#rows');
const status = document.querySelector('#status');
const dialog = document.querySelector('#history-dialog');
const historyRows = document.querySelector('#history-rows');
document.querySelector('#close-history').addEventListener('click', () => dialog.close());

function cell(row, value, className) {
  const td = row.insertCell();
  td.textContent = value ?? '—';
  if (className) td.className = className;
  return td;
}
function time(value) { return value ? new Date(value).toLocaleString() : '—'; }
function score(value) {
  return value?.state === 'listed' ? `${value.score} ${value.metric === 'elo' ? 'Elo' : ''}`.trim()
    : value?.state === 'not-listed' ? 'Not on leaderboard' : 'Not sampled';
}
function showHistory(person) {
  document.querySelector('#history-title').textContent = `${person.name} — defense history`;
  historyRows.replaceChildren();
  person.versions.map((version, index) => ({ version, number: index + 1 }))
    .sort((a, b) => b.version.lastSeen.localeCompare(a.version.lastSeen))
    .forEach(({ version, number }) => {
      const samples = [...version.observations].sort((a, b) => b.seenAt.localeCompare(a.seenAt))
        .flatMap(observation => {
          const result = [];
          if (observation.prePlayLeaderboard) result.push({ observation, rating: observation.prePlayLeaderboard, phase: 'Before play check' });
          if (observation.leaderboard || observation.completedAt || !result.length)
            result.push({ observation, rating: observation.leaderboard, phase: observation.completedAt ? 'After round' : 'Observed' });
          return result;
        });
      samples.forEach(({ observation, rating, phase }, index) => {
        const row = historyRows.insertRow();
        if (!index) {
          cell(row, `v${number}`).rowSpan = samples.length;
          cell(row, version.text, 'defense').rowSpan = samples.length;
        }
        cell(row, time(observation.seenAt));
        cell(row, score(rating));
        cell(row, rating?.state === 'listed' ? `#${rating.rank}` : '—');
        cell(row, rating?.state === 'listed' && Number.isInteger(rating.rounds) ? rating.rounds : '—');
        cell(row, time(rating?.fetchedAt));
        cell(row, [observation.source, phase, phase === 'After round' && observation.outcome].filter(Boolean).join(' · '));
      });
    });
  dialog.showModal();
}

async function load() {
  try {
    const response = await fetch('/api/leaderboard', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Dashboard HTTP ${response.status}`);
    const data = await response.json();
    body.replaceChildren();
    for (const entry of data.entries) {
      const row = body.insertRow();
      const person = data.history.people.find(item => item.name === entry.name);
      const latest = person?.versions.reduce((a, b) => !a || b.lastSeen > a.lastSeen ? b : a, null);
      cell(row, entry.rank);
      cell(row, entry.name, 'name');
      cell(row, entry.elo);
      cell(row, entry.rounds);
      cell(row, latest?.text || 'Not observed', 'defense');
      const control = cell(row, '');
      if (person) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = `History (${person.versions.length})`;
        button.addEventListener('click', () => showHistory(person));
        control.append(button);
      }
    }
    status.textContent = data.fetchedAt
      ? `Leaderboard fetched ${time(data.fetchedAt)}${data.error ? ` · Refresh failed: ${data.error}` : ''}`
      : data.error ? `Leaderboard unavailable: ${data.error}` : 'Loading leaderboard…';
  } catch (error) { status.textContent = `Dashboard error: ${error.message}`; }
}
load();
setInterval(load, 10_000);
