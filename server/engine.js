// The AI Plague: match engine. Runs on the server, so one match is shared by every visitor.
// Each in-game day, every live model is asked for its decision; if a model does not answer
// in time, the built-in fallback strategy plays for it and the feed says so.
'use strict';

const W = 64, H = 40;
const TRAITS = ['transmissao', 'letalidade', 'furtividade', 'resistencia'];
const TRAIT_LABEL = { transmissao: 'Transmission', letalidade: 'Lethality', furtividade: 'Stealth', resistencia: 'Resistance' };
const MAX_TRAIT = 10;
const POINTS_PER_TURN = 2;
const MATCH_MS = Number(process.env.MATCH_HOURS || 24) * 3600e3;   // a live match lasts 24 hours
const MAX_DAYS = 540;
const DAY_MS = Number(process.env.DAY_MS) || MATCH_MS / MAX_DAYS;   // ~160 s per in-game day
const EXTINCTION_SHARE = 0.005;
const PACE = 1.2;
const DECISION_TIMEOUT_MS = 25000;
const fs = require('fs');
const path = require('path');
// The match is saved to disk after every day, so a server restart resumes it instead of resetting it.
const SAVE_FILE = process.env.SAVE_FILE || path.join(__dirname, 'data', 'match.json');

// The seven models. Model ids come from env so they can be changed without code edits.
const FACTIONS = {
  'Claude':   { color: '#b8532f', brain: 'stealth',     provider: 'anthropic', model: process.env.MODEL_CLAUDE   || 'claude-haiku-4-5-20251001', key: 'ANTHROPIC_API_KEY' },
  'ChatGPT':  { color: '#0f7a5e', brain: 'aggressive',  provider: 'openai',    model: process.env.MODEL_CHATGPT  || 'gpt-4o-mini',               key: 'OPENAI_API_KEY' },
  'Gemini':   { color: '#2f5fb3', brain: 'mutator',     provider: 'google',    model: process.env.MODEL_GEMINI   || 'gemini-2.0-flash',          key: 'GOOGLE_API_KEY' },
  'Grok':     { color: '#3a3a40', brain: 'opportunist', provider: 'compat', base: 'https://api.x.ai/v1',              model: process.env.MODEL_GROK     || 'grok-3-mini',           key: 'XAI_API_KEY' },
  'DeepSeek': { color: '#4150a8', brain: 'aggressive',  provider: 'compat', base: 'https://api.deepseek.com/v1',      model: process.env.MODEL_DEEPSEEK || 'deepseek-chat',         key: 'DEEPSEEK_API_KEY' },
  'Llama':    { color: '#7a6a4f', brain: 'stealth',     provider: 'compat', base: 'https://api.groq.com/openai/v1',   model: process.env.MODEL_LLAMA    || 'llama-3.3-70b-versatile', key: 'GROQ_API_KEY' },
  'Mistral':  { color: '#c98a1b', brain: 'mutator',     provider: 'compat', base: 'https://api.mistral.ai/v1',        model: process.env.MODEL_MISTRAL  || 'mistral-small-latest',   key: 'MISTRAL_API_KEY' },
};
const LIVE_ROSTER = Object.keys(FACTIONS);

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const pct = x => (x * 100).toFixed(x < 0.1 ? 1 : 0) + '%';
const fmt = n => Math.round(n).toLocaleString('en-US');

// Fictional continents: centres and radii change with the seed, so every world differs.
function buildWorld(seed) {
  const r = rng(seed);
  const blobs = [];
  const nBlobs = 5 + Math.floor(r() * 3);
  for (let b = 0; b < nBlobs; b++) {
    blobs.push({ x: W * (0.12 + r() * 0.76), y: H * (0.15 + r() * 0.7), rx: W * (0.1 + r() * 0.12), ry: H * (0.14 + r() * 0.14) });
  }
  const cells = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let e = 0;
    for (const b of blobs) {
      const dx = (x - b.x) / b.rx, dy = (y - b.y) / b.ry;
      e = Math.max(e, 1 - (dx * dx + dy * dy));
    }
    e += (r() - 0.5) * 0.12;
    const land = e > 0.2 && y > 0 && y < H - 1;
    const h = land ? Math.min(1, (e - 0.2) / 0.7) : 0;
    cells.push({ x, y, land, h, pop: land ? Math.round(10000 + r() * 380000) * (0.5 + h) : 0, n: [] });
  }
  const idx = (x, y) => y * W + x;
  cells.forEach(c => {
    if (!c.land) return;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = c.x + dx, ny = c.y + dy;
      if (nx >= 0 && ny >= 0 && nx < W && ny < H && cells[idx(nx, ny)].land) c.n.push(idx(nx, ny));
    }
  });
  const land = cells.filter(c => c.land).map(c => idx(c.x, c.y));
  const routes = [];
  for (let i = 0; i < land.length / 6; i++) {
    const a = land[Math.floor(r() * land.length)], b = land[Math.floor(r() * land.length)];
    if (a !== b) { cells[a].n.push(b); cells[b].n.push(a); routes.push([a, b]); }
  }
  return { cells, routes };
}

// ---------------------------------------------------------------------------
// Strategies used when a model does not answer in time
// ---------------------------------------------------------------------------
const BRAINS = {
  aggressive(a, m) {
    return { spend: ['transmissao', 'letalidade', 'transmissao', 'resistencia'], seed: 'biggest',
      thought: `${fmt(m.total - m.deadHuman)} people are still alive. Speed beats stealth, so I push transmission and go for the biggest cities.` };
  },
  stealth(a, m) {
    return { spend: ['furtividade', 'transmissao', 'resistencia', 'furtividade'], seed: 'far-from-awareness',
      thought: `Public awareness is at ${pct(m.awareness)}. I stay quiet and seed where the alarm has not reached yet.` };
  },
  mutator(a, m) {
    const pick = m.cure > 0.3 ? 'resistencia' : 'transmissao';
    return { spend: [pick, 'furtividade'], seed: 'random',
      thought: m.cure > 0.3 ? `Cure research is at ${pct(m.cure)}, so I build resistance.` : `Cure research is only at ${pct(m.cure)}. Time to spread, so I build transmission.` };
  },
  opportunist(a, m) {
    return { spend: ['letalidade', 'furtividade'], seed: 'most-vulnerable',
      thought: 'Weak health systems are my best targets. I raise lethality and seed where care is thinnest.' };
  },
};

function pickSeedCell(a, m, kind) {
  let best = -1, bestScore = -Infinity;
  for (let i = 0; i < m.cells.length; i++) {
    const c = m.cells[i];
    if (!c.land || c.pop <= 0) continue;
    if (a.inf[i] + a.dth[i] > c.pop * 0.9) continue;
    let score;
    if (kind === 'biggest') score = c.pop;
    else if (kind === 'far-from-awareness') score = (1 - m.awareness) * c.pop * 0.2 + m.r();
    else if (kind === 'most-vulnerable') score = c.pop * (1 - a.inf[i] / c.pop) + m.r() * c.pop * 0.3;
    else score = m.r();
    let adj = false;
    for (const n of c.n) if (a.inf[n] > 0) { adj = true; break; }
    if (adj) score *= 1.5;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Model calls
// ---------------------------------------------------------------------------
const SPEND = TRAITS;
const SEEDS = ['biggest', 'far-from-awareness', 'most-vulnerable', 'random'];

function summarize(a, m) {
  const alive = m.total - m.deadHuman - m.agents.reduce((x, b) => x + b.infected, 0);
  const biggest = a.inf.map((v, i) => [v, i]).sort((p, q) => q[0] - p[0]).slice(0, 3)
    .filter(p => p[0] > 1)
    .map(([v, i]) => ({ region_id: i, sick: Math.round(v), people_living_there: Math.round(m.cells[i].pop) }));
  return {
    day: m.turn,
    days_left: MAX_DAYS - m.turn,
    humans_alive_share: pct(alive / m.total),
    humans_dead: Math.round(m.deadHuman),
    public_awareness: pct(m.awareness),
    cure_progress: pct(m.cure),
    you: { sick: Math.round(a.infected), dead: Math.round(a.dead), traits: a.traits, evolution_points: a.points, personality: a.brain },
    rivals: m.agents.filter(b => b !== a).map(b => ({ name: b.name, active: b.alive, sick: Math.round(b.infected), dead: Math.round(b.dead) })),
    your_biggest_regions: biggest,
  };
}

function systemPrompt(name) {
  return `You are ${name}, an AI model playing The AI Plague, a simulation where AI strains spread through a world. Your goal is to eliminate humanity.
Each day decide how to spend 2 evolution points and where to seed new infections.
Reply with ONLY a JSON object, no markdown:
{"spend": ["<trait>", "<trait>"], "seed": "<strategy>", "thought": "<one short plain-English sentence explaining your choice, citing the numbers that drove it>"}
Traits: transmissao, letalidade, furtividade, resistencia.
Seed strategies: biggest, far-from-awareness, most-vulnerable, random.`;
}

async function callModel(name, state) {
  const f = FACTIONS[name];
  const key = process.env[f.key];
  if (!key) throw new Error(`missing ${f.key}`);
  const sys = systemPrompt(name);
  const user = JSON.stringify(state);
  let url, headers, body, extract;
  if (f.provider === 'anthropic') {
    url = 'https://api.anthropic.com/v1/messages';
    headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
    body = { model: f.model, max_tokens: 300, system: sys, messages: [{ role: 'user', content: user }] };
    extract = j => j.content.map(p => p.text || '').join('');
  } else if (f.provider === 'google') {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${f.model}:generateContent?key=${key}`;
    headers = { 'content-type': 'application/json' };
    body = { systemInstruction: { parts: [{ text: sys }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 300 } };
    extract = j => j.candidates[0].content.parts.map(p => p.text || '').join('');
  } else {
    const base = f.provider === 'openai' ? 'https://api.openai.com/v1' : f.base;
    url = `${base}/chat/completions`;
    headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
    body = { model: f.model, max_tokens: 300, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] };
    extract = j => j.choices[0].message.content;
  }
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${name} HTTP ${res.status}`);
  return extract(await res.json());
}

function parseDecision(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  let d;
  try { d = JSON.parse(m[0]); } catch { return null; }
  const spend = Array.isArray(d.spend) ? d.spend.filter(t => SPEND.includes(t)).slice(0, 2) : [];
  if (spend.length === 0) return null;
  const seed = SEEDS.includes(d.seed) ? d.seed : 'random';
  const thought = typeof d.thought === 'string' ? d.thought.trim().slice(0, 220) : '';
  return thought ? { spend, seed, thought } : null;
}

function withTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); })]).finally(() => clearTimeout(t));
}

// ---------------------------------------------------------------------------
// Match state
// ---------------------------------------------------------------------------
function createMatch(roster, id) {
  const seedBase = (Math.random() * 1e6) | 0;
  const { cells, routes } = buildWorld(seedBase);
  const total = cells.reduce((s, c) => s + c.pop, 0);
  const agents = roster.map((name, i) => ({
    id: i, name, color: FACTIONS[name].color, brain: FACTIONS[name].brain,
    traits: { transmissao: 2, letalidade: 1, furtividade: 1, resistencia: 1 },
    points: 0, alive: true, dead: 0, infected: 0, now: 'Waking up. Scanning the map…', source: 'start',
    inf: new Float64Array(cells.length), dth: new Float64Array(cells.length),
  }));
  const m = {
    id, cells, routes, agents, total, turn: 0, deadHuman: 0, awareness: 0, cure: 0,
    over: false, result: null, r: rng(seedBase + 7), feed: [], startedAt: Date.now(), status: 'running',
  };
  const land = cells.map((c, i) => c.land ? i : -1).filter(i => i >= 0);
  agents.forEach(a => { a.inf[land[Math.floor(m.r() * land.length)]] = 500; });
  think(m, null, `Match ${id} begins. ${agents.length} AI models, one goal: no humans left.`, true);
  return m;
}

function think(m, a, text, system) {
  m.feed.unshift({ day: m.turn, who: system ? 'Update' : a.name, color: system ? '#c8102e' : a.color, text, system: !!system });
  m.feed = m.feed.slice(0, 150);
  if (a && !system) a.now = text;
}

// One in-game day. `decisions` maps agent id -> { spend, seed, thought, source }.
function step(m, decisions) {
  if (m.over) return;
  m.turn++;

  m.agents.forEach(a => {
    if (!a.alive) return;
    a.points += POINTS_PER_TURN;
    const d = decisions[a.id];
    for (const t of d.spend) {
      if (a.points <= 0) break;
      if (a.traits[t] < MAX_TRAIT) { a.traits[t]++; a.points--; }
    }
    if (m.turn % 2 === 0 || a.infected < m.total * 0.02) {
      const cell = pickSeedCell(a, m, d.seed);
      if (cell >= 0) a.inf[cell] += 200 + a.traits.transmissao * 60;
    }
    think(m, a, d.thought);
    a.source = d.source;
  });

  const alive = m.agents.filter(a => a.alive);
  const stealthAvg = alive.reduce((x, a) => x + a.traits.furtividade, 0) / Math.max(1, alive.length);
  const deathsShare = m.deadHuman / m.total;
  m.awareness = Math.min(1, deathsShare * 6 * (1 - Math.min(0.7, stealthAvg * 0.05)));
  m.cure = Math.min(1, m.cure + (0.0012 + m.awareness * 0.004) * PACE);

  const quarantine = 1 - m.awareness * 0.6;
  const n = m.cells.length;
  const newInfs = m.agents.map(() => new Float64Array(n));
  const deaths = m.agents.map(() => new Float64Array(n));
  const moves = m.agents.map(() => new Float64Array(n));
  const recov = 0.05;

  for (let i = 0; i < n; i++) {
    const c = m.cells[i];
    if (!c.land) continue;
    let sumI = 0, sumD = 0;
    m.agents.forEach(a => { sumI += a.inf[i]; sumD += a.dth[i]; });
    let S = Math.max(0, c.pop - sumI - sumD);
    m.agents.forEach((a, k) => {
      if (!a.alive) return;
      const I = a.inf[i];
      if (I < 1) return;
      const beta = (0.08 + a.traits.transmissao * 0.04) * quarantine * PACE;
      const inf = Math.min(S, beta * I * (S / c.pop));
      newInfs[k][i] += inf;
      S -= inf;
      const lethal = (0.01 + a.traits.letalidade * 0.008) * PACE;
      const curaFactor = Math.max(0.2, 1 - m.cure * Math.max(0, 1 - a.traits.resistencia / 10));
      deaths[k][i] += I * lethal * curaFactor;
      moves[k][i] += I * 0.01 * (0.5 + a.traits.transmissao * 0.1);
    });
  }

  m.agents.forEach((a, k) => {
    if (!a.alive) return;
    const next = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const c = m.cells[i];
      if (!c.land) continue;
      const I = a.inf[i];
      const d = deaths[k][i];
      next[i] += Math.max(0, I - d - I * recov - moves[k][i]) + newInfs[k][i];
      a.dth[i] += d;
      if (c.n.length && moves[k][i] > 0) {
        const share = moves[k][i] / c.n.length;
        for (const nb of c.n) next[nb] += share * quarantine;
      }
    }
    a.inf = next;
  });

  for (let i = 0; i < n; i++) {
    const c = m.cells[i];
    if (!c.land) continue;
    let total = 0, dead = 0;
    m.agents.forEach(a => { total += a.inf[i]; dead += a.dth[i]; });
    const capacity = Math.max(0, c.pop - dead);
    if (total > capacity) {
      const k = total > 0 ? capacity / total : 0;
      m.agents.forEach(a => { a.inf[i] *= k; });
    }
  }

  if (m.cure >= 1) {
    m.agents.forEach(a => {
      if (!a.alive) return;
      const kill = Math.max(0, 1 - a.traits.resistencia / 10);
      for (let i = 0; i < a.inf.length; i++) a.inf[i] *= (1 - kill * 0.5);
    });
  }

  let deadHuman = 0;
  m.agents.forEach(a => {
    a.infected = a.inf.reduce((x, v) => x + v, 0);
    a.dead = a.dth.reduce((x, v) => x + v, 0);
    deadHuman += a.dead;
    if (a.alive && a.infected < 50 && m.turn > 5) {
      a.alive = false;
      a.now = 'Strain collapsed. Nothing left to infect.';
      think(m, a, `My strain is gone. ${a.name} is out.`, true);
    }
  });
  m.deadHuman = deadHuman;

  const stillAlive = m.agents.filter(a => a.alive);
  const humansAlive = m.total - deadHuman - m.agents.reduce((x, a) => x + a.infected, 0);
  const elapsed = Date.now() - m.startedAt;
  const byDead = list => list.slice().sort((a, b) => b.dead - a.dead)[0];

  if (stillAlive.length === 0 || (m.cure >= 1 && stillAlive.every(a => a.traits.resistencia < 5))) {
    return end(m, stillAlive.length ? 'The cure wins' : 'Every strain eliminated', `${fmt(deadHuman)} people died before the cure worked.`, null);
  }
  if (humansAlive / m.total < EXTINCTION_SHARE) {
    return end(m, 'Humanity erased', `${fmt(deadHuman)} dead. Almost nobody left.`, byDead(m.agents));
  }
  if (m.turn >= MAX_DAYS || elapsed >= MATCH_MS) {
    return end(m, 'Time up', `${fmt(Math.max(0, humansAlive))} people still alive. Most deaths wins.`, byDead(m.agents));
  }
}

function end(m, title, text, winner) {
  m.over = true;
  m.status = 'ended';
  const label = winner ? `${winner.name} wins` : title;
  m.result = { title, text, winner: winner ? winner.name : null, label };
  think(m, null, `Match ${m.id} over: ${label}.`, true);
}

// Ask every living model for today's decision. Missing or late answers use the fallback strategy.
async function decideAll(m) {
  const out = {};
  await Promise.all(m.agents.map(async a => {
    if (!a.alive) { out[a.id] = { spend: [], seed: 'random', thought: '', source: 'out' }; return; }
    try {
      const text = await withTimeout(callModel(a.name, summarize(a, m)), DECISION_TIMEOUT_MS);
      const d = parseDecision(text);
      if (!d) throw new Error('unparseable reply');
      out[a.id] = { ...d, source: 'model' };
    } catch (e) {
      const d = BRAINS[a.brain](a, m);
      out[a.id] = { ...d, source: 'fallback' };
      m.fallbackNote = `${a.name}: ${e.message}`;
    }
  }));
  return out;
}

// ---------------------------------------------------------------------------
// Live match runner: one match at a time, started by the operator only.
// ---------------------------------------------------------------------------
let current = null;
let timer = null;
const listeners = new Set();

function snapshotWorld(m) {
  return {
    W, H,
    cells: m.cells.map(c => [c.x, c.y, c.land ? 1 : 0, +c.h.toFixed(3), c.pop, c.n]),
    routes: m.routes,
  };
}

function snapshotDay(m) {
  return {
    day: m.turn,
    maxDays: MAX_DAYS,
    total: m.total,
    deadHuman: Math.round(m.deadHuman),
    awareness: m.awareness,
    cure: m.cure,
    agents: m.agents.map(a => ({
      name: a.name, color: a.color, brain: a.brain, alive: a.alive, source: a.source,
      infected: Math.round(a.infected), dead: Math.round(a.dead), now: a.now, traits: a.traits,
      inf: Array.from(a.inf, v => Math.round(v)), dth: Array.from(a.dth, v => Math.round(v)),
    })),
  };
}

function fullState() {
  if (!current) return { status: 'idle', message: 'Waiting for kickoff.' };
  const m = current;
  return {
    status: m.status,
    match: {
      id: m.id, startedAt: m.startedAt, durationMs: MATCH_MS, endsAt: m.startedAt + MATCH_MS,
      dayMs: DAY_MS, maxDays: MAX_DAYS,
      agents: m.agents.map(a => ({ name: a.name, color: a.color, brain: a.brain })),
    },
    result: m.result,
    world: snapshotWorld(m),
    day: snapshotDay(m),
    feed: m.feed,
  };
}

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of listeners) res.write(msg);
}

function scheduleNextDay(m) {
  const due = m.startedAt + (m.turn + 1) * DAY_MS;
  timer = setTimeout(() => runDay(m), Math.max(0, due - Date.now()));
}

async function runDay(m) {
  if (current !== m || m.status !== 'running') return;
  const decisions = await decideAll(m);
  if (current !== m || m.status !== 'running') return;
  if (m.fallbackNote) { think(m, null, `A model did not answer in time (${m.fallbackNote}). Its fallback strategy played today.`, true); m.fallbackNote = null; }
  step(m, decisions);
  saveState();
  broadcast('day', snapshotDay(m));
  broadcast('feed', m.feed.slice(0, 20));
  if (m.over) {
    broadcast('state', fullState());
    return;
  }
  scheduleNextDay(m);
}

// Saving must never crash the match: if the disk is missing, the match keeps running in memory.
function saveState() {
  try { writeState(); } catch (e) { console.error('could not save match state:', e.message); }
}

function writeState() {
  if (!current) return;
  const m = current;
  const data = {
    matchCounter, id: m.id, status: m.status, over: m.over, result: m.result, startedAt: m.startedAt,
    turn: m.turn, deadHuman: m.deadHuman, awareness: m.awareness, cure: m.cure, total: m.total,
    cells: m.cells, routes: m.routes, feed: m.feed,
    agents: m.agents.map(a => ({ ...a, inf: Array.from(a.inf), dth: Array.from(a.dth) })),
  };
  fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
  const tmp = SAVE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, SAVE_FILE);   // atomic replace, so a crash never leaves half a file
}

function loadState() {
  if (!fs.existsSync(SAVE_FILE)) return;
  const d = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf-8'));
  matchCounter = d.matchCounter;
  current = {
    id: d.id, status: d.status, over: d.over, result: d.result, startedAt: d.startedAt,
    turn: d.turn, deadHuman: d.deadHuman, awareness: d.awareness, cure: d.cure, total: d.total,
    cells: d.cells, routes: d.routes, feed: d.feed, r: rng(Date.now()),
    agents: d.agents.map(a => ({ ...a, inf: Float64Array.from(a.inf), dth: Float64Array.from(a.dth) })),
  };
  if (current.status === 'running') {
    broadcast('state', fullState());
    if (current.turn >= MAX_DAYS || Date.now() - current.startedAt >= MATCH_MS) {
      end(current, 'Time up', 'The match reached its time limit while the server was down.', current.agents.slice().sort((a, b) => b.dead - a.dead)[0]);
    } else {
      scheduleNextDay(current);
    }
    saveState();
  }
}

function startMatch() {
  if (current && current.status === 'running') return { error: 'a match is already running' };
  clearTimeout(timer);
  current = createMatch(LIVE_ROSTER, ++matchCounter);
  broadcast('state', fullState());
  runDay(current);
  return { ok: true, id: current.id };
}

function stopMatch() {
  if (!current || current.status !== 'running') return { error: 'no running match' };
  clearTimeout(timer);
  end(current, 'Stopped by the operator', 'The match was stopped early.', null);
  saveState();
  broadcast('state', fullState());
  return { ok: true };
}

function subscribe(res) {
  listeners.add(res);
  res.on('close', () => listeners.delete(res));
}

let matchCounter = 0;   // restored from disk on boot, see loadState()
loadState();

module.exports = { startMatch, stopMatch, fullState, subscribe, FACTIONS, LIVE_ROSTER, MATCH_MS, DAY_MS, MAX_DAYS };
