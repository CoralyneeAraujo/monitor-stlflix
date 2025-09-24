// server.js — UI estática + API (targets/logs) + WS + scheduler
import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import Database from "better-sqlite3";
import { WebSocketServer } from "ws";

let MONITOR_PAUSED = false;

// --- paths / app ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";
const app = express();
const ACCEPT_3XX_AS_SUCCESS = true;
const FOLLOW_REDIRECTS = true;
const MAX_REDIRECTS = 5;

// retenção configurável (padrão 24h)
const LOG_RETENTION_HOURS = Number(process.env.LOG_RETENTION_HOURS || 24);

// 🔑 confiar no proxy (Railway usa HTTPS por trás)
app.set("trust proxy", 1);

// 🔑 CORS/preflight universal (antes de tudo)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*"); // troque por seu domínio se quiser
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204); // responde preflight
  next();
});

// body parser
app.use(express.json());

// OPTIONS explícito para /api/*
app.options("/api/*", (_req, res) => res.sendStatus(204));

// logger simples (remova se não quiser verboso)
app.use((req, _res, next) => {
  console.log(`[req] ${req.method} ${req.url}`);
  next();
});

// --- servir UI ---
const PUBLIC_DIR = path.join(__dirname, "public");
const INDEX_HTML = path.join(PUBLIC_DIR, "index.html");
console.log("[static] PUBLIC_DIR:", PUBLIC_DIR);
console.log("[static] INDEX_HTML exists?", fs.existsSync(INDEX_HTML));
app.use(express.static(PUBLIC_DIR, { index: "index.html", fallthrough: true }));
app.get("/", (_req, res) => {
  if (!fs.existsSync(INDEX_HTML))
    return res.status(500).send(`index.html não encontrado em: ${INDEX_HTML}`);
  res.sendFile(INDEX_HTML);
});

// --- DB (com tolerância a lock) ---
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "schema.db");
let db;
try {
  db = new Database(DB_PATH, { timeout: 5000 });
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  try {
    const mode = String(db.pragma("journal_mode", { simple: true })).toUpperCase();
    if (mode !== "WAL") db.pragma("journal_mode = WAL", { simple: true });
  } catch (e) {
    console.warn("WAL indisponível, seguindo com journal padrão:", e.message);
  }
} catch (e) {
  console.error("Falha ao abrir DB:", e);
  process.exit(1);
}

// --- helpers ---
function hasScheme(u) { return /^https?:\/\//i.test(u || ""); }
function validateAbsoluteHttpUrl(u) {
  if (!u || !hasScheme(u)) throw new Error("URL deve incluir http:// ou https://");
  const parsed = new URL(u);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new Error("Apenas http:// ou https:// são suportados");
  return parsed.toString();
}
function canon(u) {
  const a = new URL(u);
  a.hash = ""; a.search = "";
  a.pathname = a.pathname.replace(/\/+$/, "");
  return a.origin + a.pathname;
}
function getSetCookieList(res) {
  try {
    if (typeof res.headers.getSetCookie === "function") return res.headers.getSetCookie(); // Node 20+
    if (res.headers.raw) {
      const raw = res.headers.raw()["set-cookie"];
      return Array.isArray(raw) ? raw : [];
    }
    const sc = res.headers.get("set-cookie");
    return sc ? [sc] : [];
  } catch { return []; }
}
function statusRange(t) {
  const min = Number.isFinite(+t.expected_status_min) ? +t.expected_status_min : 200;
  const max = Number.isFinite(+t.expected_status_max) ? +t.expected_status_max : 299;
  return { min, max };
}
function inRange(status, { min, max }) {
  return typeof status === "number" && status >= min && status <= max;
}

// --- schema (IF NOT EXISTS) ---
db.exec(`
CREATE TABLE IF NOT EXISTS targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  type TEXT CHECK(type IN ('website','api')) NOT NULL DEFAULT 'website',
  method TEXT NOT NULL DEFAULT 'GET',
  headers_json TEXT DEFAULT '{}',
  body TEXT,
  interval_sec INTEGER NOT NULL DEFAULT 30,
  timeout_ms INTEGER NOT NULL DEFAULT 8000,
  expected_status_min INTEGER DEFAULT 200,
  expected_status_max INTEGER DEFAULT 299,
  expected_body_contains TEXT,
  retries INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id INTEGER NOT NULL,
  ts DATETIME NOT NULL,
  status_code INTEGER,
  ok INTEGER NOT NULL,
  response_time_ms INTEGER,
  error TEXT,
  matched_text INTEGER,
  FOREIGN KEY(target_id) REFERENCES targets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id INTEGER NOT NULL,
  started_at DATETIME NOT NULL,
  ended_at DATETIME,
  cause TEXT,
  last_status_code INTEGER,
  FOREIGN KEY(target_id) REFERENCES targets(id) ON DELETE CASCADE
);
`);

const q = {
  listTargets: db.prepare("SELECT * FROM targets ORDER BY id DESC"),
  getTarget: db.prepare("SELECT * FROM targets WHERE id = ?"),
  findByUrlAndMethod: db.prepare("SELECT id FROM targets WHERE url = ? AND method = ? LIMIT 1"),
  insertTarget: db.prepare(`
    INSERT INTO targets (
      name,url,type,method,headers_json,body,interval_sec,timeout_ms,
      expected_status_min,expected_status_max,expected_body_contains,retries,enabled
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `),
  updateTarget: db.prepare(`
    UPDATE targets SET
      name=@name,url=@url,type=@type,method=@method,
      headers_json=@headers_json,body=@body,
      interval_sec=@interval_sec,timeout_ms=@timeout_ms,
      expected_status_min=@expected_status_min,expected_status_max=@expected_status_max,
      expected_body_contains=@expected_body_contains,retries=@retries,enabled=@enabled
    WHERE id=@id
  `),
  deleteTarget: db.prepare("DELETE FROM targets WHERE id = ?"),
  insertCheck: db.prepare(`
    INSERT INTO checks (target_id, ts, status_code, ok, response_time_ms, error, matched_text)
    VALUES (?,?,?,?,?,?,?)
  `),
  recentChecksByTarget: db.prepare("SELECT * FROM checks WHERE target_id = ? ORDER BY id DESC LIMIT ?"),
  lastIncidentOpen: db.prepare("SELECT * FROM incidents WHERE target_id = ? AND ended_at IS NULL"),
  openIncident: db.prepare("INSERT INTO incidents (target_id, started_at, cause, last_status_code) VALUES (?,?,?,?)"),
  closeIncident: db.prepare("UPDATE incidents SET ended_at = CURRENT_TIMESTAMP WHERE id = ?"),
};

// --- monitor global ---
app.get("/api/monitor", (_req, res) => res.json({ paused: MONITOR_PAUSED }));
app.post("/api/monitor/pause", (_req, res) => {
  MONITOR_PAUSED = true;
  broadcast({ kind: "control", scope: "global", paused: true });
  res.json({ paused: true });
});
app.post("/api/monitor/resume", (_req, res) => {
  MONITOR_PAUSED = false;
  broadcast({ kind: "control", scope: "global", paused: false });
  res.json({ paused: false });
});

// --- health ---
app.get("/ping", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// --- limpar logs (todos ou por alvo via ?targetId=) ---
app.delete("/api/logs", (req, res) => {
  try {
    const targetId = Number(req.query.targetId || 0);
    if (targetId) db.prepare("DELETE FROM checks WHERE target_id = ?").run(targetId);
    else db.prepare("DELETE FROM checks").run();
    return res.sendStatus(204);
  } catch (e) {
    console.error("DELETE /api/logs failed:", e);
    return res.status(500).json({ error: "failed_to_clear_logs", detail: String(e) });
  }
});

// --- logs com filtros since=today e sinceHours=NN ---
app.get("/api/logs", (req, res) => {
  const id = Number(req.query.targetId);
  const limit = Math.min(Number(req.query.limit ?? 100), 1000);
  const since = String(req.query.since || "").toLowerCase();
  const sinceHours = Number(req.query.sinceHours || 0);
  if (!id) return res.status(400).json({ error: "targetId obrigatório" });

  try {
    if (since === "today") {
      const rows = db.prepare(`
        SELECT * FROM checks
        WHERE target_id = ?
          AND ts >= DATETIME('now','start of day')
        ORDER BY id DESC
        LIMIT ?
      `).all(id, limit);
      return res.json(rows);
    }
    if (Number.isFinite(sinceHours) && sinceHours > 0) {
      const rows = db.prepare(`
        SELECT * FROM checks
        WHERE target_id = ?
          AND ts >= DATETIME('now', ?)
        ORDER BY id DESC
        LIMIT ?
      `).all(id, `-${sinceHours} hours`, limit);
      return res.json(rows);
    }
    return res.json(q.recentChecksByTarget.all(id, limit));
  } catch (e) {
    console.error("GET /api/logs failed:", e);
    return res.status(500).json({ error: "failed_to_fetch_logs", detail: String(e) });
  }
});

// --- CRUD targets ---
app.get("/api/targets", (_req, res) => res.json(q.listTargets.all()));

app.post("/api/targets", (req, res) => {
  try {
    const d = req.body || {};
    if (!d.name || !d.url)
      return res.status(400).json({ error: "name e url são obrigatórios" });

    d.url = validateAbsoluteHttpUrl(d.url);
    const exists = q.findByUrlAndMethod.get(d.url, d.method ?? "GET");
    if (exists) {
      return res.status(409).json({
        error: "duplicate_target",
        message: "Já existe um alvo com esta URL e método.",
      });
    }

    const info = q.insertTarget.run(
      d.name,
      d.url,
      d.type ?? "website",
      d.method ?? "GET",
      JSON.stringify(d.headers ?? {}),
      d.body ?? null,
      Number(d.interval_sec ?? 30),
      Number(d.timeout_ms ?? 8000),
      Number(d.expected_status_min ?? 200),
      Number(d.expected_status_max ?? 299),
      d.expected_body_contains ?? null,
      Number(d.retries ?? 1),
      Number(d.enabled ?? 1)
    );
    res.status(201).json(q.getTarget.get(info.lastInsertRowid));
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.patch("/api/targets/:id", (req, res) => {
  const id = Number(req.params.id);
  const cur = q.getTarget.get(id);
  if (!cur) return res.sendStatus(404);

  const d = { ...cur, ...req.body, id };
  try {
    d.url = validateAbsoluteHttpUrl(d.url);
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e) });
  }
  d.headers_json = JSON.stringify(d.headers ?? JSON.parse(cur.headers_json || "{}"));
  q.updateTarget.run(d);
  res.json(q.getTarget.get(id));
});

app.delete("/api/targets/:id", (req, res) => {
  const id = Number(req.params.id);
  try {
    db.prepare("DELETE FROM checks WHERE target_id = ?").run(id);
    db.prepare("DELETE FROM incidents WHERE target_id = ?").run(id);
    q.deleteTarget.run(id);
    return res.sendStatus(204);
  } catch (e) {
    console.error("DELETE /api/targets failed:", e);
    return res.status(500).json({ error: "failed_to_delete_target", detail: String(e) });
  }
});

// --- summary ---
app.get("/api/summary", (_req, res) => {
  const targets = q.listTargets.all();
  res.json({
    totals: targets.length,
    enabled: targets.filter((t) => t.enabled).length,
    lastUpdate: new Date().toISOString(),
  });
});

// --- start HTTP + WS ---
const server = app.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}/`;
  console.log(`Servidor no ${url} (DB: ${DB_PATH})`);
  const startCmd =
    process.platform === "win32" ? "start" :
    process.platform === "darwin" ? "open" : "xdg-open";
  exec(`${startCmd} ${url}`);
});

const wss = new WebSocketServer({ server, path: "/ws" });

// WS: saudação + keep-alive (ping)
wss.on("connection", (socket) => {
  const keepAlive = setInterval(() => { try { socket.ping(); } catch {} }, 25000);
  socket.on("close", () => clearInterval(keepAlive));

  socket.send(JSON.stringify({ kind: "control", scope: "global", paused: MONITOR_PAUSED }));
  socket.send(JSON.stringify({
    kind: "log", targetId: null, name: "Monitor", url: null,
    ok: true, status: "WS-CONNECTED", rt: 0, err: null, ts: new Date().toISOString(),
  }));
});

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const c of wss.clients) { try { c.send(data); } catch {} }
}

// --- scheduler (motor) ---
const running = new Map();  // targetId -> nextDueMs
const RUNNING_NOW = new Set();
let inFlight = 0;
const MAX_CONCURRENCY = 5;

function scheduleAll() {
  for (const t of q.listTargets.all()) {
    if (!t.enabled) continue;
    if (!running.has(t.id)) running.set(t.id, Date.now());
  }
}

async function doCheck(t) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), t.timeout_ms);

  let ok = false, status = 0, err = null, matched = false;

  // valida URL
  let currentUrl;
  try {
    currentUrl = validateAbsoluteHttpUrl(t.url);
  } catch {
    const tsIso = new Date().toISOString();
    q.insertCheck.run(t.id, tsIso, null, 0, 0, "Invalid URL (precisa http:// ou https://)", 0);
    broadcast({ kind: "log", targetId: t.id, name: t.name, url: t.url, ok: false, status: null, rt: 0, err: "Invalid URL", ts: tsIso });
    clearTimeout(to);
    return;
  }
  const range = statusRange(t);

  // cookie jar simples
  const jar = {};
  function putCookies(res) {
    const list = getSetCookieList(res);
    for (const c of list) {
      const pair = c.split(";", 1)[0];
      const i = pair.indexOf("=");
      if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
  }
  const jarHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");

  const chain = [currentUrl];
  const seen = new Set([canon(currentUrl)]);

  try {
    for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
      const baseHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Caroline-Monitor/1.0",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
        "Upgrade-Insecure-Requests": "1",
        ...JSON.parse(t.headers_json || "{}"),
      };
      if (Object.keys(jar).length) baseHeaders.Cookie = jarHeader();

      // tentativa manual (não segue 3xx)
      const res = await fetch(currentUrl, {
        method: t.method,
        signal: controller.signal,
        redirect: "manual",
        headers: baseHeaders,
        body: t.body ?? undefined,
      });

      status = res.status;
      putCookies(res);

      // 3xx
      if (status >= 300 && status < 400) {
        const loc = res.headers.get("location");
        const nextAbs = loc ? new URL(loc, currentUrl).toString() : "";

        if (ACCEPT_3XX_AS_SUCCESS || inRange(status, range)) { ok = true; matched = true; break; }
        if (!FOLLOW_REDIRECTS) { err = `redirected to ${nextAbs || "(sem Location)"}`; matched = false; break; }
        if (!nextAbs) { err = "redirect without Location"; break; }

        const key = canon(nextAbs);
        if (seen.has(key)) { err = `redirect loop detected: ${[...chain, nextAbs].join(" → ")}`; break; }
        if (hops === MAX_REDIRECTS) { err = `redirect count exceeded: ${[...chain, nextAbs].join(" → ")}`; break; }

        seen.add(key); chain.push(nextAbs); currentUrl = nextAbs; continue;
      }

      // final
      const bodyStr = t.expected_body_contains ? await res.text() : "";
      matched = t.expected_body_contains ? bodyStr.includes(t.expected_body_contains) : true;
      ok = inRange(status, range) && matched;
      ok = status >= t.expected_status_min && status <= t.expected_status_max && matched;
      break;
    }
  } catch (e) {
    const c = e?.cause || {};
    const parts = [c.code, c.hostname || c.address, c.port && `:${c.port}`, c.message].filter(Boolean);
    if (!err) err = `fetch failed${parts.length ? " - " + parts.join(" ") : ""}`;
  } finally { clearTimeout(to); }

  const rt = Date.now() - startedAt;
  const tsIso = new Date().toISOString();

  // grava log
  q.insertCheck.run(t.id, tsIso, status || null, ok ? 1 : 0, rt, err, matched ? 1 : 0);

  // envia pro front
  broadcast({ kind: "log", targetId: t.id, name: t.name, url: currentUrl, ok, status, rt, err, ts: tsIso });

  // incidentes (abre/fecha)
  const recent = q.recentChecksByTarget.all(t.id, Math.max(Number(t.retries) || 1, 3));
  const consecutiveFails = recent.length > 0 && recent.every((r) => r.ok === 0);
  const open = q.lastIncidentOpen.get(t.id);
  if (consecutiveFails && !open) {
    q.openIncident.run(t.id, tsIso, err || `Status ${status}`, status || null);
    broadcast({ kind: "status", targetId: t.id, incident: "opened" });
  }
  if (!consecutiveFails && open) {
    q.closeIncident.run(open.id);
    broadcast({ kind: "status", targetId: t.id, incident: "closed" });
  }
}

setInterval(() => {
  if (MONITOR_PAUSED) return;
  scheduleAll();
  const now = Date.now();
  for (const [id, nextDue] of running) {
    const t = q.getTarget.get(id);
    if (!t || !t.enabled) { running.delete(id); continue; }
    if (inFlight >= MAX_CONCURRENCY) break;
    if (RUNNING_NOW.has(id)) continue;

    if (now >= nextDue) {
      running.set(id, now + t.interval_sec * 1000);
      RUNNING_NOW.add(id);

      inFlight++;
      broadcast({ kind: "tick", targetId: id, name: t.name, url: t.url, ts: new Date().toISOString() });

      doCheck(t).finally(() => { inFlight--; RUNNING_NOW.delete(id); });
    }
  }
}, 300);

// --- limpeza automática (a cada 1h) ---
setInterval(() => {
  try {
    db.prepare(`DELETE FROM checks WHERE ts < DATETIME('now', ?)`).run(`-${LOG_RETENTION_HOURS} hours`);
    db.prepare(`
      DELETE FROM incidents
      WHERE ended_at IS NOT NULL
        AND ended_at < DATETIME('now', ?)
    `).run(`-${LOG_RETENTION_HOURS} hours`);
  } catch (e) {
    console.error("Erro ao limpar logs antigos:", e);
  }
}, 60 * 60 * 1000);

// --- logs de erro úteis ---
server.on("error", (err) => console.error("Erro ao subir servidor:", err));
process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);
