// ==UserScript==
// @name         Trolley auto-advance and defense history
// @namespace    trolley-local
// @version      2.5.0
// @description  Auto-play or observe opponents, remember their defenses, and show observed leaderboard scores.
// @match        https://trolley.typememetics.institute/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  "use strict";
  if (document.getElementById("trolley-history-controls")) return;

  const DB_KEY = "trolley-defense-history-v1";
  const PAUSE_KEY = "trolley-auto-advance-paused";
  const ELO_THRESHOLD_KEY = "trolley-auto-advance-elo-threshold";
  const OBSERVE_KEY = "trolley-auto-advance-observe-only";
  const LOCK = "trolley-defense-history-v1";
  const ELO_START = 1500;
  const ELO_MAX = 3000;
  function readEloThreshold(value) {
    const number = Number(value);
    return value !== null && value !== "" && Number.isInteger(number) && number >= 0 && number <= ELO_MAX
      ? number : ELO_START;
  }
  let eloThreshold = readEloThreshold(localStorage.getItem(ELO_THRESHOLD_KEY));
  let paused = localStorage.getItem(PAUSE_KEY) === "true";
  let observeOnly = localStorage.getItem(OBSERVE_KEY) === "true";
  let storageFailed = false;
  let lastClick = 0;
  let encounter = null;
  let processing = false;
  let cachedRaw;
  let cachedDB;
  let renderedDB;
  let renderedTable;

  const host = document.createElement("div");
  host.id = "trolley-history-controls";
  const ui = host.attachShadow({ mode: "open" });
  ui.innerHTML = `
    <style>
      :host { all: initial; font: 14px/1.4 system-ui, sans-serif; color: #17202a; }
      .controls { position: fixed; bottom: 18px; right: 18px; z-index: 2147483647;
        width: min(340px, calc(100vw - 36px)); }
      button { font: inherit; cursor: pointer; }
      #toggle { width: 100%; min-height: 110px; padding: 20px; border: 4px solid white;
        border-radius: 18px; color: white; font: bold 27px/1.2 system-ui, sans-serif;
        box-shadow: 0 6px 24px #0009; }
      #status { background: #fff; color: #17202a; padding: 8px 12px; border-radius: 8px;
        margin-top: 6px; overflow-wrap: anywhere; box-shadow: 0 2px 10px #0003; }
      .threshold { display: flex; align-items: center; justify-content: space-between; gap: 12px;
        background: #fff; padding: 10px 12px; border-radius: 8px; margin-top: 6px;
        box-shadow: 0 2px 10px #0003; }
      .threshold label { font-weight: 600; }
      #elo-threshold { box-sizing: border-box; width: 95px; padding: 6px; border: 1px solid #64748b;
        border-radius: 5px; color: #17202a; background: white; font: 16px system-ui, sans-serif; }
      .threshold-help { background: #fff; padding: 0 12px 8px; border-radius: 0 0 8px 8px;
        font-size: 12px; box-shadow: 0 2px 10px #0003; }
      .observe { display: flex; align-items: center; gap: 10px; margin-top: 6px;
        padding: 10px 12px; background: #fff; border-radius: 8px; font-weight: 600;
        cursor: pointer; box-shadow: 0 2px 10px #0003; }
      #observe-only { width: 22px; height: 22px; margin: 0; accent-color: #16803a; cursor: pointer; }
      #observe-help { display: block; padding: 0 12px 8px; background: #fff;
        border-radius: 0 0 8px 8px; font-size: 12px; box-shadow: 0 2px 10px #0003; }
      #download-data { display: block; width: 100%; margin-top: 6px; padding: 10px 12px;
        border: 1px solid #64748b; border-radius: 8px; background: #fff;
        color: #17202a; font-weight: 600; box-shadow: 0 2px 10px #0003; }
      dialog { box-sizing: border-box; width: 96vw; max-height: 88vh;
        padding: 22px; border: 2px solid #334155; border-radius: 14px; overflow: auto;
        background: white; color: #17202a; font: 14px/1.4 system-ui, sans-serif; }
      dialog::backdrop { background: #0009; }
      h2 { margin: 0; font-size: 24px; overflow-wrap: anywhere; }
      .heading { display: flex; justify-content: space-between; align-items: start; gap: 20px; }
      #close { padding: 8px 16px; }
      .scroll { overflow-x: auto; }
      table { width: 100%; border-collapse: collapse; }
      th, td { padding: 10px; border: 1px solid #cbd5e1; text-align: left; vertical-align: top; }
      th { background: #e2e8f0; }
      .defense { white-space: pre-wrap; overflow-wrap: anywhere; min-width: 220px; }
      .time { min-width: 130px; }
    </style>
    <div class="controls">
      <button id="toggle" type="button"></button>
      <div class="threshold"><label for="elo-threshold">Play below Elo</label>
        <input id="elo-threshold" type="number" min="0" max="3000" step="1" inputmode="numeric"></div>
      <div class="threshold-help">0–3000 · 3000 plays everyone</div>
      <label class="observe"><input id="observe-only" type="checkbox"><span>Observe only</span></label>
      <small id="observe-help">Save defense and score, then draw another without judging. Ignores Elo threshold.</small>
      <button id="download-data" type="button">Download data</button>
      <div id="status" role="status">Watching for opponents’ defenses.</div>
    </div>
    <dialog aria-labelledby="history-title">
      <div class="heading"><h2 id="history-title"></h2><button id="close" type="button">Close</button></div>
      <p>Unique defenses and their score observations. The current leaderboard shows Elo;
        older observations may show survival percentages. Neither is a score calculated for
        this defense alone. Checks before play and after rounds are labeled.
        Times record observations, not when a defense was edited. Auto-advance waits while this is open.</p>
      <div class="scroll"><table>
        <thead><tr><th>Version</th><th>Observed defense</th><th>Defense seen</th><th>Leaderboard score</th>
          <th>Rank</th><th>Rounds</th><th>Score fetched</th><th>Context</th></tr></thead>
        <tbody id="history-body"></tbody>
      </table></div>
    </dialog>`;
  document.body.append(host);
  const toggle = ui.querySelector("#toggle");
  const thresholdInput = ui.querySelector("#elo-threshold");
  const observeInput = ui.querySelector("#observe-only");
  const status = ui.querySelector("#status");
  const dialog = ui.querySelector("dialog");
  const say = (message) => { if (status.textContent !== message) status.textContent = message; };

  function updateToggle() {
    toggle.textContent = paused ? "▶ Resume auto-advance" : "⏸ Pause auto-advance";
    toggle.style.background = paused ? "#16803a" : "#b42318";
  }

  function fail(error) {
    storageFailed = true;
    paused = true;
    updateToggle();
    say(`History could not be saved: ${error.message}. Auto-advance paused; existing history kept.`);
    console.error("[Trolley history]", error);
  }

  toggle.addEventListener("click", () => {
    try {
      localStorage.setItem(PAUSE_KEY, String(!paused));
      paused = !paused;
      storageFailed = false;
      updateToggle();
      if (!paused) say("Auto-advance resumed.");
    } catch (error) { fail(error); }
  });
  thresholdInput.value = String(eloThreshold);
  thresholdInput.addEventListener("change", () => {
    const value = Number(thresholdInput.value);
    if (!thresholdInput.value || !Number.isFinite(value)) {
      thresholdInput.value = String(eloThreshold);
      return;
    }
    const next = Math.max(0, Math.min(ELO_MAX, Math.trunc(value)));
    try {
      localStorage.setItem(ELO_THRESHOLD_KEY, String(next));
      eloThreshold = next;
      thresholdInput.value = String(next);
      say(`Auto-advance threshold: ${next} Elo${next === ELO_MAX ? " (all opponents)" : ""}.`);
    } catch (error) { fail(error); }
  });
  observeInput.checked = observeOnly;
  observeInput.addEventListener("change", () => {
    try {
      localStorage.setItem(OBSERVE_KEY, String(observeInput.checked));
      observeOnly = observeInput.checked;
      say(observeOnly ? "Observe only: recording opponents without judging." : "Auto-play enabled.");
    } catch (error) { observeInput.checked = observeOnly; fail(error); }
  });
  ui.querySelector("#close").addEventListener("click", () => dialog.close());
  updateToggle();

  // Each displayed name has one record; exact defense text is the version key.
  // Short transactions read the latest data, so tabs do not overwrite each other's observations.
  function readDB() {
    const raw = localStorage.getItem(DB_KEY);
    if (cachedDB && raw === cachedRaw) return cachedDB;
    const db = raw === null ? { schema: 1, people: [], pending: [] } : JSON.parse(raw);
    if (db.schema !== 1 || !Array.isArray(db.people) || !Array.isArray(db.pending)) {
      throw new Error("Unrecognized history format");
    }
    cachedRaw = raw;
    cachedDB = db;
    return db;
  }

  ui.querySelector("#download-data").addEventListener("click", () => {
    try {
      const json = JSON.stringify(readDB(), null, 2);
      const url = URL.createObjectURL(new Blob([`${json}\n`], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `trolley-defense-history-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      say("History downloaded. Import it with pnpm run import -- <file>.");
    } catch (error) { say(`Download failed: ${error.message}`); }
  });

  function withLock(name, action) {
    // Firefox userscript compartments cannot always expose a script Promise to
    // the page's Web Locks implementation. This callback MUST return undefined.
    // Only synchronous storage transactions run inside it; fetch uses a lease.
    return new Promise((resolve, reject) => {
      const run = () => {
        try { resolve(action()); } catch (error) { reject(error); }
      };
      try {
        if (navigator.locks) navigator.locks.request(name, run).catch(reject);
        else run();
      } catch (error) { reject(error); }
    });
  }

  function transaction(change) {
    return withLock(LOCK, () => {
      const db = structuredClone(readDB());
      const result = change(db);
      if (result === false) return false;
      const raw = JSON.stringify(db);
      localStorage.setItem(DB_KEY, raw);
      cachedRaw = raw;
      cachedDB = db;
      return result;
    });
  }

  function findObservation(db, snapshot) {
    const player = db.people.find((p) => p.name === snapshot.name);
    const version = player?.versions.find((v) => v.text === snapshot.text);
    return version?.observations.find((o) => o.id === snapshot.id);
  }

  function saveDefense(snapshot) {
    return transaction((db) => {
      let player = db.people.find((p) => p.name === snapshot.name);
      const existing = player?.versions.find((v) => v.text === snapshot.text);
      if (existing) {
        const latest = player.versions.reduce((a, b) => a.lastSeen > b.lastSeen ? a : b);
        if (latest === existing) return false;
        existing.lastSeen = snapshot.seenAt;
        return "reverted";
      }
      if (!player) db.people.push(player = { name: snapshot.name, versions: [] });
      const version = { text: snapshot.text, firstSeen: snapshot.seenAt,
        lastSeen: snapshot.seenAt, observations: [] };
      player.versions.push(version);
      version.observations.push({
        id: snapshot.id, seenAt: snapshot.seenAt, source: snapshot.source,
        path: snapshot.path, completedAt: null, outcome: null, leaderboard: null,
      });
      return "new";
    });
  }

  function readOpponent() {
    const section = [...document.querySelectorAll(".matchup .defense")]
      .find((node) => node.querySelector("h2")?.textContent.trim() === "Their defense");
    const quote = section?.querySelector("blockquote");
    const who = section?.querySelector(".defense-who")?.textContent;
    if (!quote || !who) return null;
    const name = who.replace(/, on the upper track\s*$/, "").trim();
    return name ? { name, text: quote.textContent } : null;
  }

  function beginEncounter(opponent, judge, ready) {
    const snapshot = {
      ...opponent, id: crypto.randomUUID(), seenAt: new Date().toISOString(),
      path: location.pathname, source: location.pathname.startsWith("/round/") ? "Round replay" : "Matchup",
    };
    const current = {
      snapshot, readyNode: ready ? judge : null, playbackNode: ready ? null : judge,
      completed: false, queued: false, saved: saveDefense(snapshot),
      scoreCheck: null, checkingScore: false, retryScoreAt: 0, refreshAt: 0, refreshing: false,
    };
    current.saved.then((state) => say(state === "new" ? `Defense recorded: ${opponent.name}.`
      : state === "reverted" ? `Earlier defense seen again: ${opponent.name}.`
        : `Defense unchanged: ${opponent.name}.`)).catch(fail);
    return current;
  }

  function scoreLabel(score) {
    return score.metric === "elo" ? `${score.score} Elo` : score.score;
  }

  function shouldPlay(score) {
    if (eloThreshold === ELO_MAX) return true;
    if (score.state === "not-listed") return true;
    if (score.metric === "elo") return score.elo < eloThreshold;
    return score.survivalPercent < 50;
  }

  async function checkOpponentScore(current) {
    if (current.checkingScore || current.scoreCheck || Date.now() < current.retryScoreAt) return;
    current.checkingScore = true;
    say(`Checking ${current.snapshot.name} on the leaderboard…`);
    try {
      const state = await current.saved;
      let score;
      try {
        score = await fetchScore(current.snapshot.name);
      } catch (error) {
        current.retryScoreAt = Date.now() + 30000;
        say(`Score check failed; waiting to retry. ${error.message}`);
        return;
      }
      if (state === "new") await transaction((db) => {
        const observation = findObservation(db, current.snapshot);
        if (observation) observation.prePlayLeaderboard = score;
      });
      // The tick checks pause, navigation, and button state again before acting.
      current.scoreCheck = score;
      if (encounter === current) {
        const scoreText = score.state === "not-listed" ? "not listed" : scoreLabel(score);
        const action = observeOnly ? "observed; drawing another opponent"
          : shouldPlay(score) ? "will play" : "drawing another opponent";
        say(`${current.snapshot.name}: ${scoreText} — ${action}.`);
      }
    } catch (error) { fail(error); }
    finally { current.checkingScore = false; }
  }

  function completeEncounter(current, judge) {
    if (current.completed) return;
    current.completed = true;
    const outcome = judge.querySelector(".verdict, .defense-error")?.textContent.trim() || "Round ended";
    const completedAt = new Date().toISOString();
    let recorded = false;
    current.saved.then(async (state) => {
      if (state === "new") await transaction((db) => {
        const observation = findObservation(db, current.snapshot);
        if (!observation) return;
        recorded = true;
        observation.completedAt = completedAt;
        observation.outcome = outcome;
        db.pending.push({ ...current.snapshot, completedAt, retryAt: 0 });
      });
      return state;
    }).then((state) => {
      current.queued = true;
      if (recorded) void processQueue();
      else if (state === "new") say("Defense observation is missing; continuing without its history.");
      else say(`${state === "reverted" ? "Earlier defense" : "Defense unchanged"}: ${current.snapshot.name}; continuing without another history entry.`);
    }).catch(fail);
  }

  function inspectGame(advance = true) {
    const opponent = readOpponent();
    const judge = document.querySelector(".judge");
    const button = judge?.querySelector("button[type='button']");
    if (!opponent || !judge || !button) {
      if (!document.querySelector(".matchup")) encounter = null;
      return;
    }
    const label = button.textContent.trim();
    const ready = label === "Judge" || label === "Judging...";
    if (!encounter || encounter.snapshot.name !== opponent.name || encounter.snapshot.text !== opponent.text ||
        encounter.snapshot.path !== location.pathname || (ready && encounter.readyNode !== judge) ||
        (!ready && encounter.playbackNode && encounter.playbackNode !== judge)) {
      encounter = beginEncounter(opponent, judge, ready);
    }
    if (!ready) encounter.playbackNode = judge;
    if (label === "Next opponent" || label === "Drawing...") completeEncounter(encounter, judge);

    if (!advance || paused || storageFailed || dialog.open || Date.now() - lastClick < 1500) return;
    if (label !== "Judge" && label !== "Next opponent") return;
    if (label === "Next opponent" && !encounter.queued) return;
    if (button.disabled || !button.getClientRects().length || getComputedStyle(button).visibility !== "visible") return;
    if (label === "Judge") {
      if (!encounter.scoreCheck) { void checkOpponentScore(encounter); return; }
      const score = encounter.scoreCheck;
      // Missing from the leaderboard is eligible, as requested. Fetch failures
      // are distinct: they leave scoreCheck unset and wait for a successful retry.
      if (observeOnly || !shouldPlay(score)) {
        if (!encounter.refreshAt) encounter.refreshAt = Date.now() + 1500;
        if (Date.now() >= encounter.refreshAt && !encounter.refreshing) {
          encounter.refreshing = true;
          location.reload();
        }
        return;
      }
    }
    lastClick = Date.now();
    button.click();
  }

  function leaderboardRows(root) {
    return [...root.querySelectorAll(".leaderboard tbody tr")].flatMap((row) => {
      const who = row.querySelector(".who");
      const eloText = row.querySelector(".elo")?.textContent.trim();
      const rate = row.querySelector(".rate")?.textContent.trim();
      const isElo = /^\d+$/.test(eloText || "");
      if (!who || (!isElo && !/^\d+(?:\.\d+)?%$/.test(rate || ""))) return [];
      const nameNode = who.cloneNode(true);
      nameNode.querySelectorAll("img, .you-tag").forEach((node) => node.remove());
      const roundsText = row.querySelector(".elo")?.nextElementSibling?.textContent.trim();
      return [{ row, name: nameNode.textContent.trim(), score: isElo ? eloText : rate,
        metric: isElo ? "elo" : "survival", elo: isElo ? Number(eloText) : null,
        survivalPercent: isElo ? null : Number(rate.slice(0, -1)),
        rounds: isElo && /^\d+$/.test(roundsText || "") ? Number(roundsText) : null,
        rank: Number(row.cells[0].textContent.trim()) }];
    });
  }

  async function fetchScore(name) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let html;
    try {
      const response = await fetch(new URL("/leaderboard", location.origin), {
        credentials: "same-origin", cache: "no-store", headers: { Accept: "text/html" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Leaderboard HTTP ${response.status}`);
      html = await response.text();
    } finally { clearTimeout(timeout); }
    const page = new DOMParser().parseFromString(html, "text/html");
    if (!page.querySelector("main.leaderboard")) throw new Error("Leaderboard unavailable; check sign-in");
    if (page.querySelector(".leaderboard .notice")?.textContent.includes("temporarily unavailable")) {
      throw new Error("Leaderboard temporarily unavailable");
    }
    const rows = leaderboardRows(page);
    if (page.querySelector(".leaderboard tbody tr") && !rows.length) {
      throw new Error("Leaderboard layout changed");
    }
    // Displayed names are the identity. For duplicate names, use the first row.
    const entry = rows.find((row) => row.name === name);
    return entry
      ? { state: "listed", fetchedAt: new Date().toISOString(), score: entry.score,
        metric: entry.metric, elo: entry.elo, survivalPercent: entry.survivalPercent,
        rounds: entry.rounds, rank: entry.rank }
      : { state: "not-listed", fetchedAt: new Date().toISOString() };
  }

  // A persisted job holds the defense that was observed for THAT encounter, even if
  // a later opponent/version is already on screen when the background request completes.
  async function processQueue() {
    if (processing || storageFailed) return;
    processing = true;
    try {
      const available = (job) => job.retryAt <= Date.now() && (!job.leaseUntil || job.leaseUntil <= Date.now());
      if (!readDB().pending.some(available)) return;
      let job;
      await transaction((db) => {
        const pending = db.pending.find(available);
        if (!pending) return;
        pending.leaseUntil = Date.now() + 30000;
        pending.claim = crypto.randomUUID();
        job = structuredClone(pending);
      });
      if (!job) return;
      let result;
      try {
        result = await fetchScore(job.name);
      } catch (error) {
        await transaction((db) => {
          const pending = db.pending.find((item) => item.id === job.id);
          if (pending?.claim === job.claim) {
            pending.retryAt = Date.now() + 30000;
            pending.leaseUntil = 0;
            pending.error = error.message;
          }
        });
        say(`Score fetch for ${job.name} failed; retrying in 30 seconds. ${error.message}`);
        return;
      }
      let applied = false;
      let recorded = false;
      await transaction((db) => {
        if (!db.pending.some((item) => item.id === job.id && item.claim === job.claim)) return;
        applied = true;
        const observation = findObservation(db, job);
        if (observation) {
          observation.leaderboard = result;
          recorded = true;
        }
        db.pending = db.pending.filter((item) => item.id !== job.id);
      });
      if (!applied) return;
      say(!recorded ? `${job.name}: defense history is missing; skipped its score.`
        : result.state === "listed" ? `${job.name}: recorded ${scoreLabel(result)} (#${result.rank}).`
        : `${job.name}: not on the leaderboard; defense saved.`);
    } catch (error) { fail(error); }
    finally { processing = false; }
  }

  function cell(row, text, className = "") {
    const td = document.createElement("td");
    td.textContent = text;
    td.className = className;
    row.append(td);
    return td;
  }

  function time(value) { return value ? new Date(value).toLocaleString() : "—"; }

  function showHistory(name) {
    const db = readDB();
    const player = db.people.find((item) => item.name === name);
    if (!player) return;
    ui.querySelector("#history-title").textContent = `${name} — defense history`;
    const body = ui.querySelector("#history-body");
    body.replaceChildren();
    player.versions.map((version, index) => ({ version, number: index + 1 }))
      .sort((a, b) => b.version.lastSeen.localeCompare(a.version.lastSeen))
      .forEach(({ version, number }) => {
        const observations = [...version.observations].sort((a, b) => b.seenAt.localeCompare(a.seenAt));
        const samples = observations.flatMap((observation) => {
          const result = [];
          if (observation.prePlayLeaderboard) result.push({ observation, score: observation.prePlayLeaderboard, phase: "Before play check" });
          if (observation.leaderboard || observation.completedAt || !result.length) {
            result.push({ observation, score: observation.leaderboard, phase: observation.completedAt ? "After round" : "Observed" });
          }
          return result;
        });
        samples.forEach(({ observation, score, phase }, index) => {
          const row = document.createElement("tr");
          if (!index) {
            cell(row, `v${number}`).rowSpan = samples.length;
            cell(row, version.text, "defense").rowSpan = samples.length;
          }
          const pending = db.pending.find((job) => job.id === observation.id);
          cell(row, time(observation.seenAt), "time");
          cell(row, score?.state === "listed" ? scoreLabel(score) : score?.state === "not-listed"
            ? "Not on leaderboard" : pending?.error ? `Retry pending: ${pending.error}`
              : observation.completedAt ? "Fetch pending" : "Not sampled");
          cell(row, score?.state === "listed" ? `#${score.rank}` : "—");
          cell(row, score?.state === "listed" && Number.isInteger(score.rounds) ? String(score.rounds) : "—");
          cell(row, time(score?.fetchedAt), "time");
          cell(row, [observation.source, phase, phase === "After round" && observation.outcome].filter(Boolean).join(" · "));
          body.append(row);
        });
      });
    if (!dialog.open) dialog.showModal();
  }

  function enhanceLeaderboard() {
    const table = document.querySelector(".leaderboard table");
    if (!table) { renderedTable = null; return; }
    // The site's 760px leaderboard container is too narrow after adding history columns.
    const board = table.closest("main.leaderboard");
    if (board) {
      board.style.width = "100%";
      board.style.maxWidth = "none";
    }
    const db = readDB();
    if (renderedTable === table && renderedDB === db && table.querySelector("[data-trolley-history]")) return;
    renderedTable = table;
    renderedDB = db;
    table.querySelectorAll("[data-trolley-history]").forEach((node) => node.remove());
    const header = table.querySelector("thead tr");
    if (!header) return;
    for (const label of ["Last observed defense", "Defense history"]) {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = label;
      th.dataset.trolleyHistory = "";
      header.append(th);
    }
    for (const entry of leaderboardRows(document)) {
      const player = db.people.find((item) => item.name === entry.name);
      const version = player?.versions.reduce((latest, candidate) =>
        !latest || candidate.lastSeen > latest.lastSeen ? candidate : latest, null);
      const defense = cell(entry.row, version ? version.text : "Not observed");
      defense.dataset.trolleyHistory = "";
      defense.style.cssText = "white-space:pre-wrap;text-align:left;min-width:260px;max-width:440px;overflow-wrap:anywhere";
      if (version) defense.title = `Last seen: ${time(version.lastSeen)}`;
      const history = cell(entry.row, "");
      history.dataset.trolleyHistory = "";
      if (player) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = `History (${player.versions.length})`;
        button.style.cssText = "padding:8px 12px;cursor:pointer;font:inherit";
        button.addEventListener("click", () => { try { showHistory(player.name); } catch (error) { fail(error); } });
        history.append(button);
      }
    }
  }

  // Capture a manual Next click before React replaces the matchup.
  document.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest(".judge button")) {
      try { if (!storageFailed) inspectGame(false); } catch (error) { fail(error); }
    }
  }, true);
  window.addEventListener("storage", (event) => {
    if (event.key === PAUSE_KEY) { paused = event.newValue === "true"; updateToggle(); }
    if (event.key === ELO_THRESHOLD_KEY) {
      eloThreshold = readEloThreshold(event.newValue);
      thresholdInput.value = String(eloThreshold);
    }
    if (event.key === OBSERVE_KEY) {
      observeOnly = event.newValue === "true";
      observeInput.checked = observeOnly;
    }
  });

  function tick() {
    if (storageFailed) return;
    try {
      inspectGame();
      enhanceLeaderboard();
      void processQueue();
    } catch (error) { fail(error); }
  }
  setInterval(tick, 500);
  tick();
})();
