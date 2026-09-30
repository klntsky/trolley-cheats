const body = document.querySelector('#rows');
const status = document.querySelector('#status');
const dialog = document.querySelector('#history-dialog');
const historyRows = document.querySelector('#history-rows');
const totals = document.querySelector('#totals');
let currentData = JSON.parse(document.querySelector('#initial-data').textContent);
document.querySelector('#close-history').addEventListener('click', () => dialog.close());
body.addEventListener('click', event => {
  const button = event.target.closest('button[data-history-name]');
  if (!button) return;
  const person = currentData.history.people.find(item => item.name === button.dataset.historyName);
  if (person) showHistory(person);
});

function cell(row, value, className) {
  const td = row.insertCell();
  td.textContent = value ?? '—';
  if (className) td.className = className;
  return td;
}
function time(value) { return value ? new Date(value).toLocaleString() : '—'; }
function score(value) {
  return value?.state === 'listed' ? `${value.score} ${value.metric === 'elo' ? 'Elo' : ''}`.trim()
    : value?.state === 'n/a' ? 'N/A'
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
          if (observation.prePlayLeaderboard) result.push({ observation, rating: observation.prePlayLeaderboard });
          if (observation.leaderboard || observation.completedAt || !result.length)
            result.push({ observation, rating: observation.leaderboard });
          return result;
        });
      samples.forEach(({ observation, rating }, index) => {
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
      });
    });
  dialog.showModal();
}

function render(data) {
    currentData = data;
    body.replaceChildren();
    totals.replaceChildren();
    const people = new Map(data.history.people.map(person => [person.name, person]));
    if (data.totals) {
      const list = document.createElement('dl');
      list.className = 'leaderboard-totals';
      for (const [label, value] of [['Players', data.totals.players], ['Rounds', data.totals.rounds]]) {
        const item = document.createElement('div');
        const term = document.createElement('dt');
        term.textContent = label;
        const count = document.createElement('dd');
        count.textContent = value;
        item.append(term, count);
        list.append(item);
      }
      totals.append(list);
    }
    function renderRow(entry, observed = false) {
      const row = body.insertRow();
      if (observed) row.className = 'observed-row';
      const person = people.get(entry.name);
      const latest = person?.versions.reduce((a, b) => !a || b.lastSeen > a.lastSeen ? b : a, null);
      cell(row, entry.rank);
      const name = document.createElement('th');
      name.scope = 'row';
      name.className = 'player';
      const who = document.createElement('span');
      who.className = 'who';
      if (entry.avatar) {
        const image = document.createElement('img');
        image.src = entry.avatar;
        image.alt = '';
        image.width = 28;
        image.height = 28;
        who.append(image);
      }
      if (entry.github) {
        const link = document.createElement('a');
        link.href = entry.github;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = entry.name;
        who.append(link);
      } else who.append(document.createTextNode(entry.name));
      name.append(who);
      row.append(name);
      cell(row, entry.score, 'elo');
      cell(row, entry.rounds ?? 'N/A');
      cell(row, latest?.text || 'Not observed', 'defense');
      const control = cell(row, '', 'history-col');
      if (person) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn';
        button.textContent = `History (${person.versions.length})`;
        button.dataset.historyName = entry.name;
        control.append(button);
      }
    }
    data.entries.forEach(entry => renderRow(entry));
    if (data.observedEntries?.length) {
      const divider = body.insertRow();
      divider.className = 'observed-divider';
      const label = document.createElement('th');
      label.colSpan = 6;
      label.textContent = 'NOT IN THE GAME LEADERBOARD - THE DATA BELOW MAY BE STALE';
      divider.append(label);
      data.observedEntries.forEach(entry => renderRow(entry, true));
    }
    status.textContent = data.error ? (data.fetchedAt ? 'Leaderboard refresh failed; showing previous results.'
      : 'The leaderboard is temporarily unavailable.') : '';
}

async function load() {
  try {
    const response = await fetch('/api/leaderboard', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Dashboard HTTP ${response.status}`);
    render(await response.json());
  } catch (error) { status.textContent = `Dashboard error: ${error.message}`; }
}
setInterval(load, 10_000);
