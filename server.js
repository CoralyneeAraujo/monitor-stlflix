// server.js — UI estática + API (targets/logs) + WS + scheduler
import express from "express";
import cors from "cors";
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

// ADDED: retenção configurável em horas (default 24)
const LOG_RETENTION_HOURS = Number(process.env.LOG_RETENTION_HOURS || 24);

// 🔑 Confia no proxy (Railway usa HTTPS por trás)
app.set("trust proxy", 1);

// 🔑 Middleware CORS + OPTIONS universal
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PATCH,DELETE,OPTIONS"
  );
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204); // responde preflight
  next();
});

app.use(cors());
app.use(express.json());

// --- servir UI ---
const PUBLIC_DIR = path.join(__dirname, "public");
const INDEX_HTML = path.join(PUBLIC_DIR, "index.html");
console.log("[static] PUBLIC_DIR:", PUBLIC_DIR);
console.log("[static] INDEX_HTML exists?", fs.existsSync(INDEX_HTML));
app.use(express.static(PUBLIC_DIR, { index: "index.html", fallthrough: true }));
app.get("/", (req, res) => {
  if (!fs.existsSync(INDEX_HTML))
    return res.status(500).send(`index.html não encontrado em: ${INDEX_HTML}`);
  res.sendFile(INDEX_HTML);
});

// --- resto do teu código (DB, schema, APIs, scheduler etc) ---
// (mantém igual ao último que você me mandou)

