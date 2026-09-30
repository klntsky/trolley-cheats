export async function readOpponent(page) {
  return page.evaluate(() => {
    const section = [...document.querySelectorAll('.matchup .defense')]
      .find(node => node.querySelector('h2')?.textContent.trim() === 'Their defense');
    const who = section?.querySelector('.defense-who')?.textContent;
    const text = section?.querySelector('blockquote')?.textContent;
    const name = who?.replace(/, on the upper track\s*$/, '').trim();
    return name && text ? { name, text } : null;
  });
}

export async function readLeaderboard(page) {
  return page.evaluate(() => {
    if (!document.querySelector('main.leaderboard')) throw new Error('Leaderboard page unavailable');
    if (document.querySelector('.leaderboard .notice')?.textContent.includes('temporarily unavailable'))
      throw new Error('Leaderboard temporarily unavailable');
    const rows = [...document.querySelectorAll('.leaderboard tbody tr')];
    const entries = rows.map(row => {
      const who = row.querySelector('.who')?.cloneNode(true);
      const image = row.querySelector('.who img')?.getAttribute('src');
      const avatar = image && (image.startsWith('https://avatars.githubusercontent.com/')
        || image.startsWith('data:image/svg+xml,')) ? image : null;
      const href = row.querySelector('.who a')?.getAttribute('href');
      let github = null;
      if (href) {
        try {
          const url = new URL(href, location.origin);
          if (url.protocol === 'https:' && url.hostname === 'github.com'
            && /^\/[A-Za-z0-9-]+\/?$/.test(url.pathname)) github = url.href;
        } catch { /* A malformed profile link stays plain text. */ }
      }
      who?.querySelectorAll('img, .you-tag').forEach(node => node.remove());
      const score = row.querySelector('.elo')?.textContent.trim();
      const rounds = row.querySelector('.elo')?.nextElementSibling?.textContent.trim();
      if (!who || !/^\d+$/.test(score || '')) return null;
      return { name: who.textContent.trim(), avatar, github, score, elo: Number(score),
        rounds: /^\d+$/.test(rounds || '') ? Number(rounds) : null,
        rank: Number(row.cells[0].textContent.trim()) };
    }).filter(Boolean);
    if (rows.length && !entries.length) throw new Error('Leaderboard layout changed');
    return entries;
  });
}

export async function readLeaderboardTotals(page) {
  return page.evaluate(() => {
    const totals = document.querySelector('.leaderboard-totals');
    if (!totals) return null;
    const values = new Map([...totals.querySelectorAll('div')].map(item => [
      item.querySelector('dt')?.textContent.trim(), item.querySelector('dd')?.textContent.trim(),
    ]));
    return values.has('Players') && values.has('Rounds')
      ? { players: values.get('Players'), rounds: values.get('Rounds') } : null;
  });
}

export function scoreFor(entries, name) {
  const fetchedAt = new Date().toISOString();
  const row = entries.find(item => item.name === name);
  return row ? { state: 'listed', fetchedAt, score: row.score,
    metric: 'elo', elo: row.elo, survivalPercent: null,
    rounds: row.rounds, rank: row.rank }
    : { state: 'not-listed', fetchedAt };
}
