// Run with Node and Puppeteer installed, or set PUPPETEER_MODULE to its module path.
// CHROME_PATH can select an existing Chromium executable.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const puppeteer = require(process.env.PUPPETEER_MODULE || "puppeteer");

const script = readFileSync(resolve(__dirname, "../trolley-auto-history.user.js"), "utf8");
const origin = "https://trolley.typememetics.institute";
const dbKey = "trolley-defense-history-v1";
const escape = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const matchup = (name, defense, label = "Judge") => `
  <div class="matchup"><section class="defense"><h2>Their defense</h2>
    <p class="defense-who">${escape(name)}, on the upper track</p><blockquote>${escape(defense)}</blockquote>
  </section><section class="defense"><h2>Your defense</h2><blockquote>Do not collect me</blockquote></section></div>
  <div class="judge">${label === "Next opponent" ? '<p class="verdict">AGI left the switch alone.</p>' : ""}
    <button type="button">${label}</button></div>`;
const board = (entries) => {
  const elo = entries.length && !entries[0][1].endsWith("%");
  return `<main class="leaderboard"><table><thead><tr><th>#</th><th>Player</th><th>${elo ? "Elo</th><th>Rounds" : "Survival"}</th></tr></thead>
  <tbody>${entries.map(([name, score], i) => `<tr><td>${i + 1}</td><th class="player"><span class="who">${escape(name)}
    ${name === "Me" ? '<span class="you-tag">You</span>' : ""}</span></th><td class="${elo ? "elo" : "rate"}">${score}</td>${elo ? "<td>12</td>" : ""}</tr>`).join("")}
  </tbody></table></main>`;
};

test("userscript in Chromium against source-shaped page fixtures", async (t) => {
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH,
    args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let entries = [["Alice", "70.0%"], ["Me", "30.0%"]];
  let requests = 0;
  let responseStatus = 200;
  let boardUnavailable = false;
  let requestGate = null;
  let app = matchup("Alice", "First defense");
  await page.setRequestInterception(true);
  page.on("request", async (request) => {
    if (new URL(request.url()).pathname === "/leaderboard") {
      requests++;
      const html = boardUnavailable
        ? '<main class="leaderboard"><p class="notice">The leaderboard is temporarily unavailable. You can still play.</p></main>'
        : board(entries);
      if (requestGate) await requestGate;
      await request.respond({ status: responseStatus, contentType: "text/html", body: html });
    } else {
      await request.respond({ status: 200, contentType: "text/html", body: `<html><body><div id="app">${app}</div></body></html>` });
    }
  });
  await page.goto(origin);
  await page.evaluate(() => {
    localStorage.setItem("trolley-auto-advance-paused", "true");
    // Model Firefox's userscript boundary: the platform cannot access a returned
    // userscript thenable. Synchronous callbacks may still use the real Web Lock.
    const request = navigator.locks.request.bind(navigator.locks);
    Object.defineProperty(navigator, "locks", { configurable: true, value: {
      request(name, callback) {
        return request(name, (lock) => {
          const result = callback(lock);
          if (result && typeof result.then === "function") {
            throw new Error('Permission denied to access property "then"');
          }
          return result;
        });
      },
    } });
  });
  await page.addScriptTag({ content: script });
  const db = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), dbKey);
  const render = async (html, path = "/") => page.evaluate(({ html, path }) => {
    history.pushState({}, "", path);
    document.querySelector("#app").innerHTML = html;
  }, { html, path });
  const wait = (fn, ...args) => page.waitForFunction(fn, { timeout: 8000 }, ...args);

  await t.test("collects only the opponent while paused", async () => {
    await wait((key) => JSON.parse(localStorage.getItem(key))?.people.length === 1, dbKey);
    assert.equal((await db()).people[0].name, "Alice");
    assert.equal((await db()).people[0].versions[0].text, "First defense");
    assert.equal(requests, 0);
  });

  await t.test("downloads history as importable JSON", async () => {
    const exported = await page.evaluate(async () => {
      let blob;
      const oldCreate = URL.createObjectURL;
      const oldClick = HTMLAnchorElement.prototype.click;
      let filename;
      URL.createObjectURL = (value) => { blob = value; return 'blob:mock-export'; };
      HTMLAnchorElement.prototype.click = function () { filename = this.download; };
      try {
        document.querySelector('#trolley-history-controls').shadowRoot.querySelector('#download-data').click();
        return { filename, data: JSON.parse(await blob.text()) };
      } finally {
        URL.createObjectURL = oldCreate;
        HTMLAnchorElement.prototype.click = oldClick;
      }
    });
    assert.match(exported.filename, /^trolley-defense-history-\d{4}-\d{2}-\d{2}\.json$/);
    assert.equal(exported.data.schema, 1);
    assert.equal(exported.data.people[0].versions[0].text, 'First defense');
  });

  await t.test("late scores stay with the old version after the next opponent is displayed", async () => {
    let release;
    requestGate = new Promise((resolve) => { release = resolve; });
    await render(matchup("Alice", "First defense", "Next opponent"));
    await wait((key) => JSON.parse(localStorage.getItem(key)).pending.length === 1, dbKey);
    // Wait until the actual background request has captured the first leaderboard.
    while (!requests) await new Promise((resolve) => setTimeout(resolve, 20));
    await render(matchup("Alice", "Second defense"));
    await wait((key) => JSON.parse(localStorage.getItem(key)).people[0].versions.length === 2, dbKey);
    release();
    requestGate = null;
    await wait((key) => JSON.parse(localStorage.getItem(key)).pending.length === 0, dbKey);
    const versions = (await db()).people[0].versions;
    assert.equal(versions[0].observations[0].leaderboard.score, "70.0%");
    assert.equal(versions[1].observations[0].leaderboard, null);
    assert.equal(requests, 1);
  });

  await t.test("unchanged defenses and reversions do not add encounters or score requests", async () => {
    entries = [["Alice", "80.0%"], ["Alice", "10.0%"]];
    await render(matchup("Alice", "Second defense", "Next opponent"));
    await wait((key) => JSON.parse(localStorage.getItem(key)).people[0].versions[1].observations[0].leaderboard, dbKey);
    await render(matchup("Alice", "First defense"));
    await wait(() => document.querySelector("#trolley-history-controls").shadowRoot
      .querySelector("#status").textContent === "Earlier defense seen again: Alice.");
    entries = [["Alice", "90.0%"]];
    await render(matchup("Alice", "First defense", "Next opponent"));
    await wait(() => document.querySelector("#trolley-history-controls").shadowRoot
      .querySelector("#status").textContent.includes("continuing without another history entry"));
    const versions = (await db()).people[0].versions;
    assert.equal(versions.length, 2);
    assert.deepEqual(versions[0].observations.map((o) => o.leaderboard.score), ["70.0%"]);
    assert.equal(versions[1].observations[0].leaderboard.score, "80.0%");
    assert.equal(requests, 2);
  });

  await t.test("records unlisted players; treats names and defenses as text", async () => {
    const text = '<img src=x onerror="window.bad=true"> & __proto__';
    await render(matchup("__proto__", text));
    await wait((key) => JSON.parse(localStorage.getItem(key)).people.length === 2, dbKey);
    await render(matchup("__proto__", text, "Next opponent"));
    await wait((key) => JSON.parse(localStorage.getItem(key)).people[1].versions[0].observations[0].leaderboard, dbKey);
    assert.equal((await db()).people[1].versions[0].observations[0].leaderboard.state, "not-listed");
    entries = [["Alice", "90.0%"], ["__proto__", "1.0%"], ["Me", "30.0%"]];
    await render(board(entries), "/leaderboard");
    await wait(() => document.querySelectorAll("[data-trolley-history]").length === 8);
    assert.equal(await page.$eval("main.leaderboard", (el) => el.style.width), "100%");
    assert.equal(await page.$eval(".leaderboard tbody tr td[data-trolley-history]", (el) => el.textContent), "First defense");
    assert.equal(await page.evaluate(() => window.bad), undefined);
  });

  await t.test("popup shows the complete score history and survives leaderboard navigation", async () => {
    await page.click(".leaderboard tbody tr button");
    assert.equal(await page.evaluate(() => document.querySelector("#trolley-history-controls").shadowRoot.querySelector("dialog").open), true);
    const contents = await page.evaluate(() => document.querySelector("#trolley-history-controls").shadowRoot.querySelector("#history-body").textContent);
    for (const text of ["First defense", "Second defense", "70.0%", "80.0%"]) assert.ok(contents.includes(text));
    await page.evaluate(() => document.querySelector("#trolley-history-controls").shadowRoot.querySelector("#close").click());
    await render(matchup("Alice", "First defense"));
    await wait(() => document.querySelector("#trolley-history-controls").shadowRoot
      .querySelector("#status").textContent === "Defense unchanged: Alice.");
    await render(board(entries), "/leaderboard");
    await wait(() => document.querySelectorAll("[data-trolley-history]").length === 8);
    assert.equal((await db()).people[0].versions[0].observations.length, 1);
    assert.equal(requests, 3);
  });

  await t.test("large pause/resume control governs automatic clicks and persists across reloads", async () => {
    entries = [["Alice", "49.9%"], ["__proto__", "1.0%"], ["Me", "30.0%"]];
    await render(matchup("Alice", "First defense"));
    await page.evaluate(() => {
      window.judgeClicks = 0;
      document.querySelector(".judge button").addEventListener("click", () => window.judgeClicks++);
      document.querySelector("#trolley-history-controls").shadowRoot.querySelector("#toggle").click();
    });
    await wait(() => window.judgeClicks === 1);
    await page.evaluate(() => document.querySelector("#trolley-history-controls").shadowRoot.querySelector("#toggle").click());
    assert.equal(await page.evaluate(() => localStorage.getItem("trolley-auto-advance-paused")), "true");
    assert.ok(await page.evaluate(() => document.querySelector("#trolley-history-controls").shadowRoot.querySelector("#toggle").getBoundingClientRect().height >= 100));
    app = board(entries);
    await page.reload();
    await page.addScriptTag({ content: script });
    await wait(() => document.querySelectorAll("[data-trolley-history]").length === 8);
    assert.equal((await db()).people[0].versions.length, 2);
    assert.match(await page.evaluate(() => document.querySelector("#trolley-history-controls").shadowRoot.querySelector("#toggle").textContent), /Resume/);
  });

  const prepareFilter = async (score) => {
    entries = score === null ? [["Someone else", "90.0%"]] : [["Filter opponent", score]];
    app = matchup("Filter opponent", "Filter defense");
    await page.goto(origin);
    await page.evaluate((key) => {
      const history = JSON.parse(localStorage.getItem(key));
      if (history) {
        history.people = history.people.filter((person) => person.name !== "Filter opponent");
        history.pending = history.pending.filter((job) => job.name !== "Filter opponent");
        localStorage.setItem(key, JSON.stringify(history));
      }
      localStorage.setItem("trolley-auto-advance-paused", "false");
      localStorage.removeItem("trolley-auto-advance-elo-threshold");
      localStorage.removeItem("trolley-auto-advance-observe-only");
      localStorage.setItem("test-judge-clicks", "0");
      document.querySelector(".judge button").addEventListener("click", (event) => {
        localStorage.setItem("test-judge-clicks", String(Number(localStorage.getItem("test-judge-clicks")) + 1));
        event.target.disabled = true;
        event.target.textContent = "Judging...";
      });
    }, dbKey);
  };
  const lastFilterObservation = async () => (await db()).people.find((p) => p.name === "Filter opponent").versions[0].observations.at(-1);

  await t.test("plays below 50%; still advances after the completed round raises the score", async () => {
    await prepareFilter("49.9%");
    await page.addScriptTag({ content: script });
    await wait(() => localStorage.getItem("test-judge-clicks") === "1");
    assert.equal((await lastFilterObservation()).prePlayLeaderboard.score, "49.9%");
    entries = [["Filter opponent", "80.0%"]];
    await render(matchup("Filter opponent", "Filter defense", "Next opponent"));
    await page.evaluate(() => {
      window.nextClicks = 0;
      document.querySelector(".judge button").addEventListener("click", (event) => {
        window.nextClicks++;
        event.target.disabled = true;
        event.target.textContent = "Drawing...";
      });
    });
    await wait(() => window.nextClicks === 1);
    await wait((key) => JSON.parse(localStorage.getItem(key)).people.find((p) => p.name === "Filter opponent").versions[0].observations.at(-1).leaderboard, dbKey);
    assert.equal((await lastFilterObservation()).leaderboard.score, "80.0%");
  });

  await t.test("a missing observation does not pause score checking or Next opponent", async () => {
    await prepareFilter("1499");
    let release;
    requestGate = new Promise((resolve) => { release = resolve; });
    const beforeRequests = requests;
    const beforeObservations = (await db()).people.find((p) => p.name === "Filter opponent")
      ?.versions[0].observations.length ?? 0;
    await page.addScriptTag({ content: script });
    await wait((key, count) => JSON.parse(localStorage.getItem(key)).people
      .find((p) => p.name === "Filter opponent").versions[0].observations.length === count + 1,
    dbKey, beforeObservations);
    while (requests === beforeRequests) await new Promise((resolve) => setTimeout(resolve, 20));
    await page.evaluate((key) => {
      const history = JSON.parse(localStorage.getItem(key));
      history.people.find((p) => p.name === "Filter opponent").versions[0].observations.pop();
      localStorage.setItem(key, JSON.stringify(history));
    }, dbKey);
    release();
    requestGate = null;
    await wait(() => localStorage.getItem("test-judge-clicks") === "1");
    assert.equal(await page.evaluate(() => localStorage.getItem("trolley-auto-advance-paused")), "false");
    await render(matchup("Filter opponent", "Filter defense", "Next opponent"));
    await page.evaluate(() => {
      window.nextClicks = 0;
      document.querySelector(".judge button").addEventListener("click", () => window.nextClicks++);
    });
    await wait(() => window.nextClicks === 1);
    assert.equal(await page.evaluate(() => localStorage.getItem("trolley-auto-advance-paused")), "false");
    assert.doesNotMatch(await page.evaluate(() => document.querySelector("#trolley-history-controls")
      .shadowRoot.querySelector("#status").textContent), /Auto-advance paused/);
  });

  await t.test("plays opponents absent from the leaderboard", async () => {
    await prepareFilter(null);
    await page.addScriptTag({ content: script });
    await wait(() => localStorage.getItem("test-judge-clicks") === "1");
    assert.equal((await lastFilterObservation()).prePlayLeaderboard.state, "not-listed");
  });

  for (const score of ["50.0%", "85.0%"]) {
    await t.test(`refreshes instead of judging at ${score}, after saving the defense and score`, async () => {
      await prepareFilter(score);
      const navigation = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 8000 });
      await page.addScriptTag({ content: script });
      await navigation;
      assert.equal(await page.evaluate(() => localStorage.getItem("test-judge-clicks")), "0");
      const observation = await lastFilterObservation();
      assert.equal(observation.prePlayLeaderboard.score, score);
      assert.equal(observation.completedAt, null);
      assert.equal(observation.leaderboard, null);
    });
  }

  await t.test("uses the new Elo and round columns, playing only below the 1500 starting rating", async () => {
    await prepareFilter("1499");
    await page.addScriptTag({ content: script });
    await wait(() => localStorage.getItem("test-judge-clicks") === "1");
    assert.equal((await lastFilterObservation()).prePlayLeaderboard.metric, "elo");
    assert.equal((await lastFilterObservation()).prePlayLeaderboard.elo, 1499);
    assert.equal((await lastFilterObservation()).prePlayLeaderboard.rounds, 12);
    await page.evaluate(() => document.querySelector("#trolley-history-controls").shadowRoot.querySelector("#toggle").click());
    await render(board(entries), "/leaderboard");
    await wait(() => document.querySelectorAll("[data-trolley-history]").length === 4);
    assert.equal(await page.$eval(".leaderboard tbody tr td[data-trolley-history]", (el) => el.textContent), "Filter defense");
    await page.click(".leaderboard tbody tr button");
    const historyText = await page.evaluate(() => document.querySelector("#trolley-history-controls").shadowRoot.querySelector("#history-body").textContent);
    assert.ok(historyText.includes("1499 Elo"));
    assert.ok(historyText.includes("12"));
    await page.evaluate(() => document.querySelector("#trolley-history-controls").shadowRoot.querySelector("#close").click());
  });

  await t.test("3000 Elo plays everyone and the entered threshold survives reload", async () => {
    await prepareFilter("3000");
    await page.evaluate(() => localStorage.setItem("trolley-auto-advance-paused", "true"));
    await page.addScriptTag({ content: script });
    await page.evaluate(() => {
      const ui = document.querySelector("#trolley-history-controls").shadowRoot;
      const input = ui.querySelector("#elo-threshold");
      input.value = "3000";
      input.dispatchEvent(new Event("change", { bubbles: true }));
      ui.querySelector("#toggle").click();
    });
    await wait(() => localStorage.getItem("test-judge-clicks") === "1");
    assert.equal(await page.evaluate(() => localStorage.getItem("trolley-auto-advance-elo-threshold")), "3000");
    await page.evaluate(() => localStorage.setItem("trolley-auto-advance-paused", "true"));
    await page.reload();
    await page.addScriptTag({ content: script });
    assert.equal(await page.evaluate(() => document.querySelector("#trolley-history-controls")
      .shadowRoot.querySelector("#elo-threshold").value), "3000");
  });

  await t.test("observe only saves score and draws again without judging, regardless of Elo threshold", async () => {
    await prepareFilter("1499");
    await page.evaluate(() => localStorage.setItem("trolley-auto-advance-paused", "true"));
    await page.addScriptTag({ content: script });
    const navigation = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 8000 });
    await page.evaluate(() => {
      const ui = document.querySelector("#trolley-history-controls").shadowRoot;
      const threshold = ui.querySelector("#elo-threshold");
      threshold.value = "3000";
      threshold.dispatchEvent(new Event("change", { bubbles: true }));
      const observe = ui.querySelector("#observe-only");
      observe.checked = true;
      observe.dispatchEvent(new Event("change", { bubbles: true }));
      ui.querySelector("#toggle").click();
    });
    await navigation;
    assert.equal(await page.evaluate(() => localStorage.getItem("test-judge-clicks")), "0");
    assert.equal(await page.evaluate(() => localStorage.getItem("trolley-auto-advance-observe-only")), "true");
    const observation = await lastFilterObservation();
    assert.equal(observation.prePlayLeaderboard.score, "1499");
    assert.equal(observation.completedAt, null);
    assert.equal(observation.leaderboard, null);
    const historyBeforeReload = await page.evaluate((key) => localStorage.getItem(key), dbKey);
    await page.evaluate(() => localStorage.setItem("trolley-auto-advance-paused", "true"));
    await page.addScriptTag({ content: script });
    assert.equal(await page.evaluate(() => document.querySelector("#trolley-history-controls")
      .shadowRoot.querySelector("#observe-only").checked), true);
    await wait(() => document.querySelector("#trolley-history-controls").shadowRoot
      .querySelector("#status").textContent.includes("Defense unchanged"));
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), dbKey), historyBeforeReload);
  });

  await t.test("turning off observe only restores automatic judging", async () => {
    await prepareFilter("1499");
    await page.evaluate(() => {
      localStorage.setItem("trolley-auto-advance-paused", "true");
      localStorage.setItem("trolley-auto-advance-observe-only", "true");
    });
    await page.addScriptTag({ content: script });
    await page.evaluate(() => {
      const ui = document.querySelector("#trolley-history-controls").shadowRoot;
      const observe = ui.querySelector("#observe-only");
      observe.checked = false;
      observe.dispatchEvent(new Event("change", { bubbles: true }));
      ui.querySelector("#toggle").click();
    });
    await wait(() => localStorage.getItem("test-judge-clicks") === "1");
    assert.equal(await page.evaluate(() => localStorage.getItem("trolley-auto-advance-observe-only")), "false");
  });

  await t.test("0 Elo refreshes for a listed opponent and clamps out-of-range input", async () => {
    await prepareFilter("1499");
    await page.evaluate(() => localStorage.setItem("trolley-auto-advance-paused", "true"));
    await page.addScriptTag({ content: script });
    await page.evaluate(() => {
      const ui = document.querySelector("#trolley-history-controls").shadowRoot;
      const input = ui.querySelector("#elo-threshold");
      input.value = "9999";
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assert.equal(await page.evaluate(() => document.querySelector("#trolley-history-controls")
      .shadowRoot.querySelector("#elo-threshold").value), "3000");
    const navigation = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 8000 });
    await page.evaluate(() => {
      const ui = document.querySelector("#trolley-history-controls").shadowRoot;
      const input = ui.querySelector("#elo-threshold");
      input.value = "0";
      input.dispatchEvent(new Event("change", { bubbles: true }));
      ui.querySelector("#toggle").click();
    });
    await navigation;
    assert.equal(await page.evaluate(() => localStorage.getItem("trolley-auto-advance-elo-threshold")), "0");
    assert.equal(await page.evaluate(() => localStorage.getItem("test-judge-clicks")), "0");
  });

  for (const score of ["1500", "1512"]) {
    await t.test(`refreshes instead of judging at ${score} Elo`, async () => {
      await prepareFilter(score);
      const navigation = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 8000 });
      await page.addScriptTag({ content: script });
      await navigation;
      assert.equal(await page.evaluate(() => localStorage.getItem("test-judge-clicks")), "0");
      assert.equal((await lastFilterObservation()).prePlayLeaderboard.score, score);
    });
  }

  await t.test("temporary leaderboard outage is retried, not treated as an unlisted opponent", async () => {
    await prepareFilter("1499");
    boardUnavailable = true;
    await page.addScriptTag({ content: script });
    await wait(() => document.querySelector("#trolley-history-controls").shadowRoot.querySelector("#status").textContent.includes("Score check failed"));
    assert.equal(await page.evaluate(() => localStorage.getItem("test-judge-clicks")), "0");
    assert.equal((await lastFilterObservation()).prePlayLeaderboard, undefined);
    boardUnavailable = false;
  });

  await t.test("fetch errors wait for retry instead of counting as an unlisted opponent", async () => {
    await prepareFilter("10.0%");
    responseStatus = 503;
    const before = requests;
    await page.addScriptTag({ content: script });
    await wait(() => document.querySelector("#trolley-history-controls").shadowRoot.querySelector("#status").textContent.includes("Score check failed"));
    assert.equal(await page.evaluate(() => localStorage.getItem("test-judge-clicks")), "0");
    assert.equal((await lastFilterObservation()).prePlayLeaderboard, undefined);
    assert.equal(requests, before + 1);
    responseStatus = 200;
  });
  assert.deepEqual(errors, []);
});
