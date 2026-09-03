import "dotenv/config";
import express from "express";
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Client, Databases, Account, ID, Query } from "node-appwrite";
import { criarCobrancaPicPay, consultarStatusPicPay, registrarPendente, buscarPendente, removerPendente } from "./picpay.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const CACHE_TTL = 5 * 60 * 1000;
const DATA_DIR = join(__dirname, "..", "data");
const PARTIDAS_FILE = join(DATA_DIR, "partidas.json");

let cache = { data: null, timestamp: 0 };
// Live match details cache (matchId → { data, ts })
const liveCache = new Map();
const GE_LIVE_TTL_MS = parseInt(process.env.GE_LIVE_TTL_MS) || 30000; // 30 s default

const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN || "";
const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGIN || "https://pitaco2026.ctqs.com.br")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const AW_PROFILES_COLLECTION = "user_profiles";
const AW_ADMIN_ROLES_COLLECTION = "admin_roles";

function extractBearer(req) {
  const header = req.get("authorization") || "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return (req.get("x-admin-key") || "").trim();
}

async function isAppwriteAdminUserId(userId) {
  if (!awDatabases || !userId) return false;
  try {
    const roles = await awDatabases.listDocuments(AW_DB_ID, AW_ADMIN_ROLES_COLLECTION, [
      Query.equal("userId", userId),
      Query.limit(1),
    ]);
    return roles.documents.length > 0;
  } catch (err) {
    // Coleção ausente: fallback legado (só até seed-roles)
    console.warn("[auth] admin_roles indisponível, fallback profile.role:", err.message);
    try {
      const profiles = await awDatabases.listDocuments(AW_DB_ID, AW_PROFILES_COLLECTION, [
        Query.equal("userId", userId),
        Query.limit(1),
      ]);
      return profiles.documents[0]?.role === "admin";
    } catch {
      return false;
    }
  }
}

async function resolveAdminAuth(req) {
  const token = extractBearer(req);
  if (!token) return { ok: false, status: 401, error: "Unauthorized" };

  if (ADMIN_API_TOKEN && token === ADMIN_API_TOKEN) {
    return { ok: true, mode: "machine" };
  }

  if (!AW_PROJECT || !AW_API_KEY) {
    return { ok: false, status: 503, error: "Appwrite not configured" };
  }

  try {
    const userClient = new Client()
      .setEndpoint(AW_ENDPOINT)
      .setProject(AW_PROJECT)
      .setJWT(token);
    const user = await new Account(userClient).get();
    const admin = await isAppwriteAdminUserId(user.$id);
    if (!admin) return { ok: false, status: 403, error: "Forbidden" };
    return { ok: true, mode: "user", userId: user.$id, user };
  } catch {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
}

async function requireAdmin(req, res, next) {
  if (!ADMIN_API_TOKEN && !AW_SYNC_ENABLED) {
    console.error("[auth] ADMIN_API_TOKEN/Appwrite não configurados — bloqueando rota admin");
    return res.status(503).json({ error: "Admin auth not configured" });
  }
  const auth = await resolveAdminAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ error: auth.error || "Unauthorized" });
  req.adminAuth = auth;
  next();
}

async function requireAppwriteUser(req, res, next) {
  const token = extractBearer(req);
  if (!token || !AW_PROJECT) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (ADMIN_API_TOKEN && token === ADMIN_API_TOKEN) {
    return res.status(400).json({ error: "Use a user JWT for /me routes" });
  }
  try {
    const userClient = new Client()
      .setEndpoint(AW_ENDPOINT)
      .setProject(AW_PROJECT)
      .setJWT(token);
    const user = await new Account(userClient).get();
    req.appwriteUser = user;
    next();
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

function resolveCorsOrigin(req) {
  const origin = req.get("origin");
  if (!origin) return FRONTEND_ORIGINS[0] || "*";
  if (FRONTEND_ORIGINS.includes(origin)) return origin;
  if (process.env.NODE_ENV !== "production" && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    return origin;
  }
  return null;
}

// Evita launches concorrentes de Chromium (poll + /ge-classificacao + live)
let scrapeLock = Promise.resolve();
function withScrapeLock(fn) {
  const run = scrapeLock.then(fn, fn);
  scrapeLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function chromiumLaunchOptions() {
  const envArgs = (process.env.PLAYWRIGHT_CHROMIUM_ARGS || "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  const args = envArgs.length
    ? envArgs
    : ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"];
  return {
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args,
  };
}

// ── Appwrite config (optional — sync enabled when all vars are set) ──

const AW_ENDPOINT = process.env.APPWRITE_ENDPOINT || "https://appwrite.letsgo.ctqs.com.br/v1";
const AW_PROJECT = process.env.APPWRITE_PROJECT || "";
const AW_API_KEY = process.env.APPWRITE_API_KEY || "";
const AW_DB_ID = process.env.APPWRITE_DATABASE_ID || "pitaco2026";
const AW_COLLECTION_ID = process.env.APPWRITE_COLLECTION_ID || "partidas";
const AW_SYNC_ENABLED = !!(AW_PROJECT && AW_API_KEY);

let awDatabases = null;
if (AW_SYNC_ENABLED) {
  const awClient = new Client()
    .setEndpoint(AW_ENDPOINT)
    .setProject(AW_PROJECT)
    .setKey(AW_API_KEY);
  awDatabases = new Databases(awClient);
  console.log("[appwrite] sync enabled — endpoint:", AW_ENDPOINT);
}

// Team name alignment between GE and Appwrite
const GE_TO_APPWRITE_TEAM = {
  "República Tcheca": "Tchéquia",
  "Bósnia": "Bósnia e Herzegovina",
  "RD Congo": "República Democrática do Congo",
};

function mapNome(nome) {
  return GE_TO_APPWRITE_TEAM[nome] || nome;
}

const GROUP_TEAMS = {
  A: ["México", "Coreia do Sul", "Tchéquia", "África do Sul"],
  B: ["Canadá", "Bósnia e Herzegovina", "Catar", "Suíça"],
  C: ["Brasil", "Marrocos", "Haiti", "Escócia"],
  D: ["Estados Unidos", "Paraguai", "Austrália", "Turquia"],
  E: ["Alemanha", "Curaçao", "Costa do Marfim", "Equador"],
  F: ["Holanda", "Japão", "Suécia", "Tunísia"],
  G: ["Bélgica", "Egito", "Irã", "Nova Zelândia"],
  H: ["Espanha", "Cabo Verde", "Arábia Saudita", "Uruguai"],
  I: ["França", "Senegal", "Iraque", "Noruega"],
  J: ["Argentina", "Argélia", "Áustria", "Jordânia"],
  K: ["Portugal", "República Democrática do Congo", "Uzbequistão", "Colômbia"],
  L: ["Inglaterra", "Croácia", "Gana", "Panamá"],
};

const PHASES = [
  "Fase de grupos",
  "Segunda fase",
  "Oitavas de final",
  "Quartas de final",
  "Semifinal",
  "Disputa do 3º lugar",
  "Final",
];

const KNOCKOUT_PHASES = PHASES.slice(1); // all except group stage

function findGroup(team1, team2) {
  for (const [group, teams] of Object.entries(GROUP_TEAMS)) {
    if (teams.includes(team1) && teams.includes(team2)) return group;
  }
  return "";
}

function parseGeDate(raw) {
  if (!raw) return null;
  const value = String(raw).trim();

  // If the source already provides an explicit timezone, trust it.
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(value)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  // Date-only values are interpreted as midnight in Brazil time.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00-03:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  // Naive date-time values from the scrape are already in Brazil time.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?$/.test(value)) {
    const parsed = new Date(`${value}-03:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function isDateOnlyValue(raw) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(raw || "").trim());
}

function hasExplicitMatchTime(raw) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(raw || "").trim());
}

function formatDateOnlyPtBr(raw) {
  if (!isDateOnlyValue(raw)) return null;
  const [, month, day] = String(raw).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/) || [];
  return month && day ? `${day}/${month}` : null;
}

function combineIsoDateAndTime(dateValue, timeValue) {
  const dateMatch = String(dateValue || "").trim().match(/^(\d{4}-\d{2}-\d{2})/);
  const timeMatch = String(timeValue || "").trim().match(/^(\d{2}):(\d{2})$/);
  if (!dateMatch || !timeMatch) return null;
  return `${dateMatch[1]}T${timeMatch[1]}:${timeMatch[2]}:00-03:00`;
}

function buildIsoDateFromCardLabel(label, year = new Date().getFullYear()) {
  const match = String(label || "").trim().match(/^(\d{2})\/(\d{2})$/);
  if (!match) return null;
  const [, day, month] = match;
  return `${year}-${month}-${day}`;
}

function resolveKnockoutMatchDate(startDate, dataTexts = [], horaTexts = []) {
  if (hasExplicitMatchTime(startDate)) return startDate;

  const visibleHour = horaTexts.find((value) => /^\d{2}:\d{2}$/.test(String(value || "").trim()));
  if (isDateOnlyValue(startDate) && visibleHour) {
    return combineIsoDateAndTime(startDate, visibleHour);
  }

  const visibleDate = dataTexts.find((value) => /^\d{2}\/\d{2}$/.test(String(value || "").trim()));
  if (visibleDate && visibleHour) {
    const isoDate = buildIsoDateFromCardLabel(visibleDate);
    return combineIsoDateAndTime(isoDate, visibleHour);
  }

  if (isDateOnlyValue(startDate)) return startDate;
  if (visibleDate) return buildIsoDateFromCardLabel(visibleDate);
  return startDate || null;
}

function formatBrazilDateTime(raw, fallbackLabel, fallbackHour) {
  const dateOnlyLabel = formatDateOnlyPtBr(raw);
  if (dateOnlyLabel) return dateOnlyLabel;

  const normalized = parseGeDate(raw);
  if (normalized) {
    const date = new Date(normalized);
    return date.toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      timeZone: "America/Bahia",
    }) + " " + date.toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "America/Bahia",
    });
  }
  if (fallbackHour) return `${fallbackLabel || ""} ${fallbackHour}`.trim();
  return "—";
}

function buildMatchKey(fase, time1, time2) {
  const [a, b] = [time1, time2].sort((x, y) => x.localeCompare(y));
  return `${fase || "grupos"}|${a}|${b}`;
}

function matchScore(doc) {
  if (doc.placar1 != null && doc.placar2 != null) return 2;
  if (doc.placar1 != null || doc.placar2 != null) return 1;
  return 0;
}

function getUpdatedAt(doc) {
  const value = doc.$updatedAt || doc.$createdAt;
  const time = value ? new Date(value).getTime() : 0;
  return Number.isNaN(time) ? 0 : time;
}

// ── Appwrite sync ──────────────────────────────────────────────────

async function syncToAppwrite(jogos) {
  if (!AW_SYNC_ENABLED) {
    console.log("[appwrite] sync skipped — missing APPWRITE_PROJECT or APPWRITE_API_KEY");
    return { atualizadas: 0, criadas: 0, erros: [] };
  }

  const result = { atualizadas: 0, criadas: 0, erros: [] };
  let existing = [];

  try {
    let offset = 0;
    const limit = 100;
    while (true) {
      const res = await awDatabases.listDocuments(AW_DB_ID, AW_COLLECTION_ID, [
        Query.limit(limit),
        Query.offset(offset),
      ]);
      existing = existing.concat(res.documents);
      if (res.documents.length < limit) break;
      offset += limit;
    }
  } catch (err) {
    result.erros.push(`Erro ao buscar documentos existentes: ${err.message}`);
    return result;
  }

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const rateLimitedUpdate = async (docId, data, attempt = 1) => {
    try {
      await awDatabases.updateDocument(AW_DB_ID, AW_COLLECTION_ID, docId, data);
    } catch (err) {
      if (err.code === 429 && attempt <= 5) {
        const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        await delay(backoff);
        return rateLimitedUpdate(docId, data, attempt + 1);
      }
      throw err;
    }
  };

  const rateLimitedCreate = async (data, attempt = 1) => {
    try {
      await awDatabases.createDocument(AW_DB_ID, AW_COLLECTION_ID, ID.unique(), data);
    } catch (err) {
      if (err.code === 429 && attempt <= 5) {
        const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        await delay(backoff);
        return rateLimitedCreate(data, attempt + 1);
      }
      throw err;
    }
  };

  const rateLimitedDelete = async (docId, attempt = 1) => {
    try {
      await awDatabases.deleteDocument(AW_DB_ID, AW_COLLECTION_ID, docId);
    } catch (err) {
      if (err.code === 429 && attempt <= 5) {
        const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        await delay(backoff);
        return rateLimitedDelete(docId, attempt + 1);
      }
      throw err;
    }
  };

  const invalidScheduledKeys = new Set();
  for (const jogo of jogos) {
    if (!jogo.time1 || !jogo.time2) continue;
    const nomeTime1 = mapNome(jogo.time1);
    const nomeTime2 = mapNome(jogo.time2);
    const fase = jogo.fase || "grupos";
    if (!parseGeDate(jogo.data)) {
      invalidScheduledKeys.add(buildMatchKey(fase, nomeTime1, nomeTime2));
    }
  }

  const idsToDelete = new Set();

  for (const doc of existing) {
    const key = buildMatchKey(doc.fase || "grupos", doc.time1, doc.time2);
    if (doc.status === "agendado" && invalidScheduledKeys.has(key)) {
      idsToDelete.add(doc.$id);
    }
  }

  const groups = new Map();
  for (const doc of existing) {
    const key = buildMatchKey(doc.fase || "grupos", doc.time1, doc.time2);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(doc);
  }

  for (const docs of groups.values()) {
    const remaining = docs.filter((doc) => !idsToDelete.has(doc.$id));
    if (remaining.length <= 1) continue;
    remaining
      .sort((a, b) => {
        const scoreDiff = matchScore(b) - matchScore(a);
        if (scoreDiff !== 0) return scoreDiff;
        return getUpdatedAt(b) - getUpdatedAt(a);
      })
      .slice(1)
      .forEach((doc) => idsToDelete.add(doc.$id));
  }

  for (const docId of idsToDelete) {
    try {
      await rateLimitedDelete(docId);
    } catch (err) {
      result.erros.push(`Erro ao deletar partida inválida/duplicada ${docId}: ${err.message}`);
    }
  }

  if (idsToDelete.size > 0) {
    existing = existing.filter((doc) => !idsToDelete.has(doc.$id));
  }

  for (const jogo of jogos) {
    if (!jogo.time1 || !jogo.time2) {
      console.log(`[appwrite] pulando partida sem times: ${jogo.fase || '?'}`);
      continue;
    }
    const nomeTime1 = mapNome(jogo.time1);
    const nomeTime2 = mapNome(jogo.time2);
    const placar1 = jogo.placar1;
    const placar2 = jogo.placar2;
    const status = jogo.status;
    const dataUtc = parseGeDate(jogo.data);
    if (!dataUtc) {
      console.log(`[appwrite] pulando partida sem data definida: ${nomeTime1} vs ${nomeTime2} (${jogo.fase || "grupos"})`);
      continue;
    }
    const grupoRaw = jogo.grupo || "";
    const grupo = grupoRaw.startsWith("Grupo ") ? grupoRaw.replace("Grupo ", "") : findGroup(nomeTime1, nomeTime2);

    const fase = jogo.fase || "grupos";
    const penaltis1 = jogo.penaltis1 ?? null;
    const penaltis2 = jogo.penaltis2 ?? null;

    const match = existing.find((p) => {
      if (p.fase !== fase) return false;
      return buildMatchKey(p.fase, p.time1, p.time2) === buildMatchKey(fase, nomeTime1, nomeTime2);
    });

    if (match) {
      if (
        match.placar1 === placar1 &&
        match.placar2 === placar2 &&
        match.status === status &&
        match.data === dataUtc &&
        (match.penaltis1 ?? null) === penaltis1 &&
        (match.penaltis2 ?? null) === penaltis2
      ) continue;
      try {
        await rateLimitedUpdate(match.$id, { placar1, placar2, status, data: dataUtc, penaltis1, penaltis2 });
        result.atualizadas++;
        console.log(`[appwrite] atualizada: ${nomeTime1} vs ${nomeTime2} → ${placar1}x${placar2} (${status})`);
      } catch (err) {
        result.erros.push(`Erro ao atualizar ${nomeTime1} vs ${nomeTime2}: ${err.message}`);
      }
    } else {
      try {
        await rateLimitedCreate({
          time1: nomeTime1,
          time2: nomeTime2,
          grupo,
          fase,
          data: dataUtc,
          placar1,
          placar2,
          penaltis1,
          penaltis2,
          status,
        });
        result.criadas++;
        console.log(`[appwrite] criada: ${nomeTime1} vs ${nomeTime2} (${fase})`);
      } catch (err) {
        result.erros.push(`Erro ao criar ${nomeTime1} vs ${nomeTime2}: ${err.message}`);
      }
    }
  }

  return result;
}

// ── CORS & Cache headers ─────────────────────────────────────────

app.use((req, res, next) => {
  const allowed = resolveCorsOrigin(req);
  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", allowed);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Key");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  if (req.method === "OPTIONS") {
    if (!allowed && req.get("origin")) return res.sendStatus(403);
    return res.sendStatus(204);
  }
  next();
});

// ── Data persistence ──────────────────────────────────────────────

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

function loadPartidas() {
  try {
    if (existsSync(PARTIDAS_FILE)) {
      return JSON.parse(readFileSync(PARTIDAS_FILE, "utf-8"));
    }
  } catch (e) {
    console.error("Error loading partidas:", e.message);
  }
  return [];
}

function savePartidas(partidas) {
  try {
    writeFileSync(PARTIDAS_FILE, JSON.stringify(partidas, null, 2));
  } catch (e) {
    console.error("Error saving partidas:", e.message);
  }
}

function isPlaceholderTeam(name) {
  return /^Venc\./.test(String(name || "")) || /^Perd\./.test(String(name || ""));
}

function hasCompleteScore(match) {
  return match?.placar1 != null && match?.placar2 != null;
}

function formatBahiaYmd(value) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bahia",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function buildTournamentStats(partidas, updatedAt = null) {
  const safePartidas = Array.isArray(partidas) ? partidas : [];
  const scoredMatches = safePartidas.filter(hasCompleteScore);

  const overview = {
    jogosTotal: safePartidas.length,
    jogosFinalizados: safePartidas.filter((p) => p.status === "finalizado").length,
    jogosAoVivo: safePartidas.filter((p) => p.status === "ao-vivo").length,
    jogosAgendados: safePartidas.filter((p) => p.status === "agendado").length,
    golsTotal: scoredMatches.reduce((sum, p) => sum + Number(p.placar1 || 0) + Number(p.placar2 || 0), 0),
    mediaGolsPorJogo: scoredMatches.length
      ? Number(
          (
            scoredMatches.reduce((sum, p) => sum + Number(p.placar1 || 0) + Number(p.placar2 || 0), 0) /
            scoredMatches.length
          ).toFixed(2)
        )
      : 0,
  };

  const phaseMap = new Map();
  for (const p of safePartidas) {
    const fase = p.fase || "Fase de grupos";
    if (!phaseMap.has(fase)) {
      phaseMap.set(fase, { fase, jogos: 0, gols: 0, jogosComPlacar: 0, mediaGols: 0 });
    }
    const entry = phaseMap.get(fase);
    entry.jogos += 1;
    if (hasCompleteScore(p)) {
      entry.gols += Number(p.placar1 || 0) + Number(p.placar2 || 0);
      entry.jogosComPlacar += 1;
    }
  }
  const phaseOrder = new Map(PHASES.map((fase, index) => [fase, index]));
  const byPhase = Array.from(phaseMap.values())
    .map((entry) => ({
      ...entry,
      mediaGols: entry.jogosComPlacar ? Number((entry.gols / entry.jogosComPlacar).toFixed(2)) : 0,
    }))
    .sort((a, b) => (phaseOrder.get(a.fase) ?? 999) - (phaseOrder.get(b.fase) ?? 999));

  const teamMap = new Map();
  for (const p of scoredMatches) {
    if (isPlaceholderTeam(p.time1) || isPlaceholderTeam(p.time2)) continue;
    const pairs = [
      { name: p.time1, goalsFor: Number(p.placar1 || 0), goalsAgainst: Number(p.placar2 || 0) },
      { name: p.time2, goalsFor: Number(p.placar2 || 0), goalsAgainst: Number(p.placar1 || 0) },
    ];
    for (const team of pairs) {
      if (!teamMap.has(team.name)) {
        teamMap.set(team.name, {
          selecao: team.name,
          jogos: 0,
          vitorias: 0,
          empates: 0,
          derrotas: 0,
          golsPro: 0,
          golsContra: 0,
          saldo: 0,
          pontos: 0,
          aproveitamento: 0,
        });
      }
      const entry = teamMap.get(team.name);
      entry.jogos += 1;
      entry.golsPro += team.goalsFor;
      entry.golsContra += team.goalsAgainst;
      if (team.goalsFor > team.goalsAgainst) entry.vitorias += 1;
      else if (team.goalsFor === team.goalsAgainst) entry.empates += 1;
      else entry.derrotas += 1;
    }
  }
  const byTeam = Array.from(teamMap.values())
    .map((team) => {
      team.saldo = team.golsPro - team.golsContra;
      team.pontos = team.vitorias * 3 + team.empates;
      team.aproveitamento = team.jogos ? Number(((team.pontos / (team.jogos * 3)) * 100).toFixed(1)) : 0;
      return team;
    })
    .sort((a, b) =>
      b.golsPro - a.golsPro ||
      a.golsContra - b.golsContra ||
      b.saldo - a.saldo ||
      b.vitorias - a.vitorias ||
      a.selecao.localeCompare(b.selecao)
    );

  const byDayMap = new Map();
  for (const p of scoredMatches) {
    if (!p.data) continue;
    const key = formatBahiaYmd(p.data);
    if (!byDayMap.has(key)) {
      byDayMap.set(key, { data: key, jogos: 0, gols: 0 });
    }
    const entry = byDayMap.get(key);
    entry.jogos += 1;
    entry.gols += Number(p.placar1 || 0) + Number(p.placar2 || 0);
  }
  const byDay = Array.from(byDayMap.values())
    .sort((a, b) => a.data.localeCompare(b.data))
    .map((entry) => ({
      ...entry,
      mediaGols: entry.jogos ? Number((entry.gols / entry.jogos).toFixed(2)) : 0,
    }));

  const scorelineMap = new Map();
  for (const p of scoredMatches) {
    const placar = `${p.placar1}-${p.placar2}`;
    scorelineMap.set(placar, (scorelineMap.get(placar) || 0) + 1);
  }
  const scorelineFrequency = Array.from(scorelineMap.entries())
    .map(([placar, total]) => ({ placar, total }))
    .sort((a, b) => b.total - a.total || a.placar.localeCompare(b.placar))
    .slice(0, 10);

  return {
    updatedAt,
    overview,
    byPhase,
    byTeam,
    byDay,
    scorelineFrequency,
  };
}

// ── Match merging ─────────────────────────────────────────────────

function mergePartidas(existing, scraped) {
  const map = new Map(
    existing
      .filter((p) => p?.id && p?.time1 && p?.time2)
      .map((p) => [p.id, p])
  );

  for (const np of scraped) {
    const old = map.get(np.id);
    if (old) {
      if (np.placar1 !== null) {
        old.placar1 = np.placar1;
        old.placar2 = np.placar2;
      }
      old.status = np.status;
      old.rodada = np.rodada;
      old.data = np.data;
      old.startDate = np.startDate ?? old.startDate;
      old.local = np.local;
      if (Object.prototype.hasOwnProperty.call(np, "dataLabel")) old.dataLabel = np.dataLabel ?? null;
      if (Object.prototype.hasOwnProperty.call(np, "hora")) old.hora = np.hora ?? null;
      if (Object.prototype.hasOwnProperty.call(np, "href")) old.href = np.href ?? null;
    } else {
      map.set(np.id, np);
    }
  }

  return Array.from(map.values()).sort((a, b) => {
    if (!a.data) return 1;
    if (!b.data) return -1;
    return new Date(a.data) - new Date(b.data);
  });
}

// ── Scraping ──────────────────────────────────────────────────────

async function scrape() {
  return withScrapeLock(async () => {
  const browser = await chromium.launch(chromiumLaunchOptions());

  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    const detailStartDateCache = new Map();
    await page.goto("https://ge.globo.com/futebol/copa-do-mundo/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(5000);

    async function fetchCanonicalStartDate(href) {
      if (!href) return null;
      if (detailStartDateCache.has(href)) return detailStartDateCache.get(href);

      const detailPage = await context.newPage();
      let startDate = null;

      try {
        await detailPage.goto(href, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
        await detailPage.waitForTimeout(2000);

        startDate = await detailPage.evaluate(() => {
          const metaStartDate = document
            .querySelector('meta[itemprop="startDate"]')
            ?.getAttribute("content");
          if (metaStartDate) return metaStartDate;

          function findStartDate(value) {
            if (!value) return null;
            if (typeof value === "string") return null;
            if (Array.isArray(value)) {
              for (const item of value) {
                const found = findStartDate(item);
                if (found) return found;
              }
              return null;
            }
            if (typeof value === "object") {
              if (typeof value.startDate === "string" && value.startDate.trim()) {
                return value.startDate.trim();
              }
              for (const nested of Object.values(value)) {
                const found = findStartDate(nested);
                if (found) return found;
              }
            }
            return null;
          }

          const jsonLdScripts = Array.from(
            document.querySelectorAll('script[type="application/ld+json"]')
          )
            .map((el) => el.textContent)
            .filter(Boolean);

          for (const scriptText of jsonLdScripts) {
            try {
              const found = findStartDate(JSON.parse(scriptText));
              if (found) return found;
            } catch {
              // Ignore malformed JSON-LD blocks and keep searching.
            }
          }

          const regex = /"startDate"\s*:\s*"([^"]+)"/;
          for (const script of Array.from(document.scripts)) {
            const text = script.textContent || "";
            const match = text.match(regex);
            if (match?.[1]) return match[1];
          }

          return null;
        });
      } catch (err) {
        console.warn(`[scrape] falha ao buscar detalhe da partida ${href}: ${err.message}`);
      } finally {
        await detailPage.close();
      }

      detailStartDateCache.set(href, startDate);
      return startDate;
    }

    const artilharia = await page.evaluate(() => {
      const items = document.querySelectorAll(".ranking-item-wrapper");
      return Array.from(items)
        .slice(0, 5)
        .map((item) => {
          const pos = item
            .querySelector(".ranking-item")
            ?.textContent?.trim();
          const nome = item
            .querySelector(".jogador-nome")
            ?.textContent?.trim();
          const posicao = item
            .querySelector(".jogador-posicao")
            ?.textContent?.trim();
          const gols = item
            .querySelector(".jogador-gols")
            ?.textContent?.trim();
          const selecao = item
            .querySelector(".jogador-escudo img")
            ?.getAttribute("alt");
          return {
            pos: pos ? parseInt(pos) : null,
            nome,
            posicao,
            gols: gols ? parseInt(gols) : 0,
            selecao,
          };
        });
    });

    // ── Navigate all rounds per group to capture historical matches ──
    const allJogosMap = new Map(); // key → jogo object

    async function extractCurrentJogos(grupoNames) {
      return await page.evaluate((grupoNames) => {
        const sections = document.querySelectorAll(".tabela__lista-jogos");
        const jogos = [];

        sections.forEach((section, sectionIdx) => {
          const rodada = section
            .querySelector(".lista-jogos__navegacao--rodada")
            ?.textContent?.trim();
          const grupo = grupoNames[sectionIdx] || null;
          const placarItems = section.querySelectorAll(".placar");

          placarItems.forEach((placar) => {
            const mandanteSigla = placar
              .querySelector(".placar__equipes--mandante .equipes__sigla")
              ?.textContent?.trim();
            const mandanteNome = placar
              .querySelector(".placar__equipes--mandante .equipes__nome")
              ?.textContent?.trim();
            const visitanteSigla = placar
              .querySelector(".placar__equipes--visitante .equipes__sigla")
              ?.textContent?.trim();
            const visitanteNome = placar
              .querySelector(".placar__equipes--visitante .equipes__nome")
              ?.textContent?.trim();
            const golsM = placar
              .querySelector(".placar-box__valor--mandante")
              ?.textContent?.trim();
            const golsV = placar
              .querySelector(".placar-box__valor--visitante")
              ?.textContent?.trim();

            const key = `${mandanteSigla}-${visitanteSigla}`;

            const startDate = placar
              .querySelector('meta[itemprop="startDate"]')
              ?.getAttribute("content");

            const link = placar.closest("a[href]");
            const local = link
              ?.querySelector(".jogo__informacoes--local")
              ?.textContent?.trim();
            const dataLabel = link
              ?.querySelector(".jogo__informacoes--data")
              ?.textContent?.trim();
            const hora = link
              ?.querySelector(".jogo__informacoes--hora")
              ?.textContent?.trim();

            const broadcast = link
              ?.querySelector(".jogo__transmissao--broadcast")
              ?.textContent?.trim()
              ?.toLowerCase();
            let status = "agendado";
            if (broadcast?.includes("tempo real") || broadcast?.includes("ao vivo")) {
              status = "ao-vivo";
            } else if (broadcast?.includes("saiba como foi")) {
              if (startDate) {
                const matchTime = new Date(startDate).getTime();
                if (isNaN(matchTime)) {
                  status = "finalizado";
                } else {
                  const elapsed = (Date.now() - matchTime) / 60000;
                  status = elapsed > 105 ? "finalizado" : "ao-vivo";
                }
              } else {
                status = "finalizado";
              }
            }

            jogos.push({
              id: key,
              time1: mandanteNome,
              time2: visitanteNome,
              sigla1: mandanteSigla,
              sigla2: visitanteSigla,
              placar1: golsM ? parseInt(golsM) : null,
              placar2: golsV ? parseInt(golsV) : null,
              status,
              fase: "grupos",
              grupo,
              data: startDate || null,
              rodada: rodada || null,
              local: local || null,
              dataLabel: dataLabel || null,
              hora: hora || null,
              href: link?.href || null,
            });
          });
        });

        return jogos;
      }, grupoNames);
    }

    // ── Phase navigation helpers ──
    async function navigateToFirstPhase() {
      let clicked = true;
      let maxAttempts = 10;
      while (clicked && maxAttempts > 0) {
        clicked = await page.evaluate(() => {
          const arrows = document.querySelectorAll(
            "nav.navegacao-fase .navegacao-fase__seta-esquerda"
          );
          let didClick = false;
          arrows.forEach((arrow) => {
            if (arrow && arrow.classList.contains("navegacao-fase__setas-ativa")) {
              arrow.click();
              didClick = true;
            }
          });
          return didClick;
        });
        if (clicked) {
          await page.waitForTimeout(1000);
          maxAttempts--;
        }
      }
    }

    async function clickNextPhase() {
      return await page.evaluate(() => {
        const arrows = document.querySelectorAll(
          "nav.navegacao-fase .navegacao-fase__seta-direita"
        );
        let didClick = false;
        arrows.forEach((arrow) => {
          if (arrow && arrow.classList.contains("navegacao-fase__setas-ativa")) {
            arrow.click();
            didClick = true;
          }
        });
        return didClick;
      });
    }

    // ── Knockout match extraction ──
    async function extractKnockoutJogos(fase) {
      return await page.evaluate((fase) => {
        const sections = document.querySelectorAll(".classificacao__mata-mata section.tabela__mata-mata");
        const jogos = [];

        sections.forEach((section) => {
          const matches = section.querySelectorAll("div.jogo");
          matches.forEach((jogo) => {
            const placar = jogo.querySelector(".placar");
            if (!placar) return;

            const mandanteNome = placar.querySelector(".placar__equipes--mandante .equipes__nome")?.textContent?.trim();
            const visitanteNome = placar.querySelector(".placar__equipes--visitante .equipes__nome")?.textContent?.trim();
            const mandanteSigla = placar.querySelector(".placar__equipes--mandante .equipes__sigla")?.textContent?.trim();
            const visitanteSigla = placar.querySelector(".placar__equipes--visitante .equipes__sigla")?.textContent?.trim();

            if (!mandanteNome || !visitanteNome || !mandanteSigla || !visitanteSigla) return;

const golsM = placar.querySelector(".placar-box__valor--mandante")?.textContent?.trim();
            const golsV = placar.querySelector(".placar-box__valor--visitante")?.textContent?.trim();

            const startDate = jogo.querySelector('meta[itemprop="startDate"]')?.getAttribute("content");
            
            const link = jogo.querySelector(".jogo__transmissao--link, a.placar-jogo-link");
            const anchor = link?.tagName === "A" ? link : link?.querySelector("a");
            const dataTexts = Array.from(link?.querySelectorAll(".jogo__informacoes--data") || [])
              .map((el) => el.textContent?.trim())
              .filter(Boolean);
            const horaTexts = Array.from(link?.querySelectorAll(".jogo__informacoes--hora") || [])
              .map((el) => el.textContent?.trim())
              .filter(Boolean);
            const local = link?.querySelector(".jogo__informacoes--local, .placar-jogo-informacoes-local")?.textContent?.trim();
            const dataLabel = dataTexts[0] || null;
            const hora = horaTexts[0] || null;

            const broadcast = link?.querySelector(".jogo__transmissao--broadcast, .placar-jogo-tag-transmissao .tabela-tag-transmissao")?.textContent?.trim()?.toLowerCase();
            let status = "agendado";
            if (broadcast?.includes("tempo real") || broadcast?.includes("ao vivo")) {
              status = "ao-vivo";
            } else if (broadcast?.includes("saiba como foi")) {
              if (startDate) {
                const matchTime = new Date(startDate).getTime();
                if (isNaN(matchTime)) {
                  status = "finalizado";
                } else {
                  const elapsed = (Date.now() - matchTime) / 60000;
                  status = elapsed > 105 ? "finalizado" : "ao-vivo";
                }
              } else {
                status = "finalizado";
              }
            }

            const key = `${fase}-${mandanteSigla}-${visitanteSigla}`;

            jogos.push({
              id: key,
              time1: mandanteNome,
              time2: visitanteNome,
              sigla1: mandanteSigla,
              sigla2: visitanteSigla,
              placar1: golsM ? parseInt(golsM) : null,
              placar2: golsV ? parseInt(golsV) : null,
              status,
              fase,
              grupo: "",
              rodada: fase,
              local: local || null,
              dataLabel,
              hora,
              href: anchor?.href || null,
              startDate: startDate || null,
              dataTexts,
              horaTexts,
            });
          });
        });

        return jogos;
      }, fase);
    }

    // Helper: click all "previous" arrows to go back to round 1
    async function navigateToFirstRound() {
      let clicked = true;
      let maxAttempts = 10; // safety limit
      while (clicked && maxAttempts > 0) {
        clicked = await page.evaluate(() => {
          const arrows = document.querySelectorAll(
            ".lista-jogos__navegacao--seta-esquerda"
          );
          let didClick = false;
          arrows.forEach((arrow) => {
            if (arrow && arrow.classList.contains("lista-jogos__navegacao--setas-ativa")) {
              arrow.click();
              didClick = true;
            }
          });
          return didClick;
        });
        if (clicked) {
          await page.waitForTimeout(1000); // wait for content to load
          maxAttempts--;
        }
      }
    }

    // Helper: click all "next" arrows once
    async function clickNextRounds() {
      return await page.evaluate(() => {
        const arrows = document.querySelectorAll(
          ".lista-jogos__navegacao--seta-direita"
        );
        let didClick = false;
        arrows.forEach((arrow) => {
          if (arrow && arrow.classList.contains("lista-jogos__navegacao--setas-ativa")) {
            arrow.click();
            didClick = true;
          }
        });
        return didClick;
      });
    }

    // Step 1: Navigate to Fase de grupos first (page defaults to Segunda fase)
    console.log("[scrape] navegando para fase de grupos...");
    await navigateToFirstPhase();
    await page.waitForTimeout(2000);

    // Extract grupos (classification tables, only visible in Fase de grupos view)
    const grupos = await page.evaluate(() => {
      const articles = document.querySelectorAll("article.tabela__futebol");
      return Array.from(articles).map((article) => {
        const grupo =
          article
            .querySelector(".classificacao__header--titulo")
            ?.textContent?.trim() || "";

        const tableTeams = article.querySelector("table.tabela__equipes");
        const statsTable = article.querySelector("table.tabela__pontos");

        const teamRows = tableTeams
          ? tableTeams.querySelectorAll("tr.classificacao__tabela--linha")
          : [];
        const statRows = statsTable ? statsTable.querySelectorAll("tr") : [];

        const times = Array.from(teamRows)
          .map((row, idx) => {
            const pos = row
              .querySelector(".classificacao__equipes--posicao")
              ?.textContent?.trim();
            const nome = row
              .querySelector(".classificacao__equipes--nome")
              ?.textContent?.trim();
            const sigla = row
              .querySelector(".classificacao__equipes--sigla")
              ?.textContent?.trim();

            const statRow = statRows[idx + 1];
            let stats = null;
            let pts = 0;
            if (statRow) {
              const cells = statRow.querySelectorAll("td");
              stats = {
                jogos: cells[1]?.textContent?.trim(),
                vitorias: cells[2]?.textContent?.trim(),
                empates: cells[3]?.textContent?.trim(),
                derrotas: cells[4]?.textContent?.trim(),
                golsPro: cells[5]?.textContent?.trim(),
                golsContra: cells[6]?.textContent?.trim(),
                saldoGols: cells[7]?.textContent?.trim(),
                aproveitamento: cells[8]?.textContent?.trim(),
              };
              pts = parseInt(cells[0]?.textContent?.trim() || "0");
            }

            return { pos: pos ? parseInt(pos) : null, nome, sigla, pts, stats };
          })
          .filter((t) => t.nome);

        return { grupo, times };
      });
    });

    // Extract group names in order for section→group mapping
    const grupoNames = grupos.map((g) => g.grupo);

    // Step 2: Go back to round 1 within group stage
    console.log("[scrape] navegando para rodada 1...");
    await navigateToFirstRound();

    // Step 3: Collect matches from round 1
    const round1Jogos = await extractCurrentJogos(grupoNames);
    for (const j of round1Jogos) {
      allJogosMap.set(j.id, j);
    }
    console.log(`[scrape] rodada 1: ${round1Jogos.length} partidas`);

    // Step 4: Navigate forward and collect each round
    let hasMore = true;
    let roundCount = 1;
    while (hasMore && roundCount < 10) { // max 10 rounds
      hasMore = await clickNextRounds();
      if (hasMore) {
        await page.waitForTimeout(800);
        const roundJogos = await extractCurrentJogos(grupoNames);
        let newCount = 0;
        for (const j of roundJogos) {
          if (!allJogosMap.has(j.id)) {
            newCount++;
          }
          allJogosMap.set(j.id, j); // update or add
        }
        roundCount++;
        console.log(`[scrape] rodada ${roundCount}: ${roundJogos.length} partidas (${newCount} novas)`);
      }
    }

    // Step 5: Navigate knockout phases (click right from Fase de grupos)
    console.log("[scrape] navegando para fases eliminatórias...");
    await page.waitForTimeout(1000);

    for (let phaseIdx = 1; phaseIdx < PHASES.length; phaseIdx++) {
      const hasNext = await clickNextPhase();
      if (!hasNext) {
        console.log(`[scrape] ${PHASES[phaseIdx]}: navegação não disponível, parando`);
        break;
      }
      await page.waitForTimeout(1500);
      const knockoutJogosRaw = await extractKnockoutJogos(PHASES[phaseIdx]);
      const knockoutJogos = [];
      for (const jogo of knockoutJogosRaw) {
        let matchDate = resolveKnockoutMatchDate(jogo.startDate, jogo.dataTexts, jogo.horaTexts);

        if (!hasExplicitMatchTime(matchDate) && jogo.href) {
          const canonicalStartDate = await fetchCanonicalStartDate(jogo.href);
          if (hasExplicitMatchTime(canonicalStartDate)) {
            matchDate = canonicalStartDate;
          } else if (!matchDate) {
            matchDate = canonicalStartDate || null;
          }
        }

        knockoutJogos.push({
          id: jogo.id,
          time1: jogo.time1,
          time2: jogo.time2,
          sigla1: jogo.sigla1,
          sigla2: jogo.sigla2,
          placar1: jogo.placar1,
          placar2: jogo.placar2,
          status: jogo.status,
          fase: jogo.fase,
          grupo: jogo.grupo,
          data: matchDate || null,
          rodada: jogo.rodada,
          local: jogo.local,
          dataLabel: jogo.dataLabel,
          hora: jogo.hora,
          href: jogo.href || null,
        });
      }
      for (const j of knockoutJogos) {
        allJogosMap.set(j.id, j);
      }
      console.log(`[scrape] ${PHASES[phaseIdx]}: ${knockoutJogos.length} partidas`);
    }

    const jogosRaw = Array.from(allJogosMap.values());
    console.log(`[scrape] total: ${jogosRaw.length} partidas únicas`);

    return { grupos, artilharia, jogosRaw };
  } finally {
    await browser.close();
  }
  });
}

// ── HTML template ─────────────────────────────────────────────────

function renderAlbumHtml() {
  const countries = [
    { id: "brasil", name: "BRASIL", active: true },
    { id: "argentina", name: "ARGENTINA", active: false },
    { id: "franca", name: "FRANÇA", active: false },
    { id: "alemanha", name: "ALEMANHA", active: false },
    { id: "espanha", name: "ESPANHA", active: false },
  ];

  const stickers = [
    { id: 1, collected: true, name: "Vinícius Jr.", rating: 94, rarity: "LENDÁRIA", image: "https://upload.wikimedia.org/wikipedia/commons/thumb/0/0e/Vinicius_Jr._2022.jpg/440px-Vinicius_Jr._2022.jpg" },
    { id: 7, collected: false, number: "07" },
    { id: 2, collected: true, name: "Neymar Jr.", rating: 92, rarity: "LENDÁRIA", image: "https://upload.wikimedia.org/wikipedia/commons/thumb/7/7d/Neymar_%28cropped%29.jpg/440px-Neymar_%28cropped%29.jpg" },
    { id: 10, collected: false, number: "10" },
    { id: 3, collected: false, number: "13" },
    { id: 4, collected: false, number: "18" },
    { id: 5, collected: true, name: "Marquinhos", rating: 89, rarity: "OURO", image: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a2/Marquinhos_2018.jpg/440px-Marquinhos_2018.jpg" },
    { id: 6, collected: false, number: "01" },
    { id: 8, collected: false, number: "04" },
    { id: 9, collected: false, number: "05" },
    { id: 11, collected: false, number: "08" },
    { id: 12, collected: false, number: "11" },
  ];

  const generateStickers = () => {
    return stickers.map(s => {
      if (s.collected) {
        const borderColor = s.rarity === "LENDÁRIA" ? "#FFD700" : "#4CAF50";
        return `
        <div class="sticker-card collected" style="border-color: ${borderColor};">
          <div class="sticker-image" style="background-image: url('${s.image}'); background-size: cover; background-position: center;"></div>
          <div class="sticker-info">
            <div class="sticker-rating">${s.rating}</div>
            <div class="sticker-name">${s.name}</div>
            <div class="sticker-rarity">${s.rarity}</div>
          </div>
        </div>`;
      } else {
        return `
        <div class="sticker-card empty">
          <div class="sticker-number">${s.number}</div>
        </div>`;
      }
    }).join("");
  };

  const generateTabs = () => {
    return countries.map(c => `
      <div class="country-tab ${c.active ? 'active' : ''}" data-country="${c.id}">
        <div class="country-flag"></div>
        <span>${c.name}</span>
      </div>
    `).join("");
  };

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Álbum de Figurinhas - Pitaco 2026</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
    background: #f5f5f5;
    color: #333;
    overflow-x: hidden;
    -webkit-tap-highlight-color: transparent;
  }
  
  /* Header */
  .header {
    background: #1b5e20;
    color: white;
    padding: 12px 16px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    position: sticky;
    top: 0;
    z-index: 100;
  }
  .header-left {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .menu-icon {
    width: 24px;
    height: 24px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 4px;
    cursor: pointer;
  }
  .menu-icon span {
    display: block;
    height: 2px;
    background: white;
    border-radius: 2px;
  }
  .menu-icon span:nth-child(1) { width: 20px; }
  .menu-icon span:nth-child(2) { width: 16px; }
  .menu-icon span:nth-child(3) { width: 20px; }
  .header-title {
    font-size: 18px;
    font-weight: 700;
    line-height: 1.2;
  }
  .header-right {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .coins {
    display: flex;
    align-items: center;
    gap: 4px;
    background: rgba(255,255,255,0.15);
    padding: 4px 10px;
    border-radius: 20px;
    font-size: 13px;
    font-weight: 600;
  }
  .coins::before {
    content: "🪙";
    font-size: 14px;
  }
  .logout-btn {
    background: transparent;
    border: 1px solid rgba(255,255,255,0.3);
    color: white;
    padding: 4px 10px;
    border-radius: 20px;
    font-size: 12px;
    cursor: pointer;
  }

  /* Collection Section */
  .collection-section {
    background: white;
    padding: 16px;
    border-bottom: 1px solid #e0e0e0;
  }
  .collection-title {
    font-size: 20px;
    font-weight: 700;
    color: #1a1a2e;
    margin-bottom: 8px;
  }
  .collection-subtitle {
    font-size: 14px;
    color: #666;
    margin-bottom: 12px;
  }
  .progress-container {
    width: 100%;
    height: 8px;
    background: #f0f0f0;
    border-radius: 4px;
    overflow: hidden;
    margin-bottom: 8px;
  }
  .progress-bar {
    height: 100%;
    background: #FFD700;
    width: 46%;
    border-radius: 4px;
    transition: width 0.3s ease;
  }
  .progress-text {
    font-size: 12px;
    color: #999;
    text-align: right;
  }

  /* Country Tabs */
  .country-tabs {
    display: flex;
    overflow-x: auto;
    padding: 12px 16px;
    gap: 12px;
    background: white;
    border-bottom: 1px solid #e0e0e0;
    scrollbar-width: none;
    -ms-overflow-style: none;
  }
  .country-tabs::-webkit-scrollbar {
    display: none;
  }
  .country-tab {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    min-width: 60px;
    cursor: pointer;
    opacity: 0.6;
    transition: opacity 0.2s;
  }
  .country-tab.active {
    opacity: 1;
  }
  .country-flag {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: #e0e0e0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
    position: relative;
  }
  .country-tab.active .country-flag {
    background: #2e7d32;
    box-shadow: 0 2px 8px rgba(46, 125.7, 50, 0.3);
  }
  .country-tab span {
    font-size: 10px;
    font-weight: 600;
    color: #666;
    letter-spacing: 0.5px;
  }
  .country-tab.active span {
    color: #2e7d32;
  }

  /* Sticker Grid */
  .sticker-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    padding: 16px;
    max-width: 600px;
    margin: 0 auto;
  }
  .sticker-card {
    aspect-ratio: 3/4;
    border-radius: 12px;
    overflow: hidden;
    position: relative;
    border: 2px dashed #ccc;
    background: white;
  }
  .sticker-card.collected {
    border: 3px solid;
    box-shadow: 0 4px 12px rgba(0,0zerotransparent) 0%, rgba(0,0,0,0.1) 100%);
  }
  .sticker-card.empty {
    display: flex;
    align-items: center;
    justify-content: center;
    background: #fafafa;
  }
  .sticker-card.empty::before {
    content: "";
    position: absolute;
    top: 8px;
    left: 8px;
    right: 8px;
    bottom: 8px;
    border: 2px dashed #ddd;
    border-radius: 8px;
  }
  .sticker-image {
    width: 100%;
    height: 60%;
    background-color: #f0f0f0;
  }
  .sticker-info {
    padding: 8px;
    text-align: center;
  }
  .sticker-rating {
    font-size: 24px;
    font-weight: 700;
    color: #1a1a2e;
  }
  .sticker-name {
    font-size: 11px;
    font-weight: 600;
    color: #333;
    margin-top: 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sticker-rarity {
    font-size: 9px;
    color: #999;
    margin-top: 2px;
    letter-spacing: 0.5px;
  }
  .sticker-number {
    font-size: 32px;
    font-weight: 700;
    color: #ddd;
  }

  /* Promo Banner */
  .promo-section {
    padding: 16px;
  }
  .promo-card {
    background: white;
    border-radius: 16px;
    padding: 20px;
    text-align: center;
    box-shadow: 0 2px 8px rgba(0,0,0,0.05);
  }
  .promo-title {
    font-size: 18px;
    font-weight: 700;
    color: #1a1a2e;
    margin-bottom: 8px;
  }
  .promo-desc {
    font-size: 14px;
    color: #666;
    margin-bottom: 16px;
    line-height: 1.5;
  }
  .promo-btn {
    background: #FFD700;
    color: #1a1a2e;
    border: none;
    padding: 12px 24px;
    border-radius: 24px;
    font-size: 14px;
    font-weight: 700;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    box-shadow: 0 2px 8px rgba(255, 215, 0, 0.3);
  }
  .promo-image {
    width: 100%;
    height: 150px;
    background: #f0f0f0;
    border-radius: 12px;
    margin-top: 16px;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #999;
    font-size: 14px;
  }

  /* Bottom Navigation */
  .bottom-nav {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    background: white;
    display: flex;
    justify-content: space-around;
    padding: 8px 0 12px;
    border-top: 1px solid #e0e0e0;
    z-index: 100;
  }
  .nav-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    text-decoration: none;
    color: #999;
    font-size: 11px;
    padding: 4px 12px;
    border-radius: 12px;
    transition: all 0.2s;
  }
  .nav-item.active {
    color: #1a1a2e;
    background: #FFD700;
  }
  .nav-item svg {
    width: 24px;
    height: 24px;
    fill: currentColor;
  }

  /* Responsive */
  @media (max-width: 390px) {
    .sticker-grid {
      gap: 8px;
      padding: 12px;
    }
    .sticker-card {
      border-radius: 8px;
    }
  }
</style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <div class="menu-icon">
        <span></span>
        <span></span>
        <span></span>
      </div>
      <div class="header-title">Álbum de Figurinhas</div>
    </div>
    <div class="header-right">
      <div class="coins">5.600</div>
      <button class="logout-btn">Sair</button>
    </div>
  </div>

  <div class="collection-section">
    <div class="collection-title">Coleção Mundial 2026</div>
    <div class="collection-subtitle">Brasil: 12/26 figurinhas</div>
    <div class="progress-container">
      <div class="progress-bar"></div>
    </div>
    <div class="progress-text">46% completo</div>
  </div>

  <div class="country-tabs">
    ${generateTabs()}
  </div>

  <div class="sticker-grid">
    ${generateStickers()}
  </div>

  <div class="promo-section">
    <div class="promo-card">
      <div class="promo-title">Aumente sua coleção!</div>
      <div class="promo-desc">Ganhe moedas participando de palpites e troque por envelopes novos para completar seu álbum.</div>
      <button class="promo-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
        </svg>
        Abrir Envelopes
      </button>
      <div class="promo-image">Imagem - Abrir Envelopes</div>
    </div>
  </div>

  <div class="bottom-nav">
    <a href="/" class="nav-item">
      <svg viewBox="0 0 24 24"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>
      Início
    </a>
    <a href="#" class="nav-item">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>
      Bolões
    </a>
    <a href="/album" class="nav-item active">
      <svg viewBox="0 0 24 24"><path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg>
      Stats
    </a>
    <a href="#" class="nav-item">
      <svg viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
      Perfil
    </a>
  </div>
</body>
</html>`;
}

function renderHtml(data) {
  const dt = new Date(data.updatedAt);
  const dtStr = dt.toLocaleString("pt-BR");

  const statusColor = { "ao-vivo": "#16a34a", finalizado: "#dc2626", agendado: "#999" };
  const statusLabel = { "ao-vivo": "AO VIVO", finalizado: "Finalizado", agendado: "Agendado" };

  let html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Copa do Mundo 2026</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;background:#f4f4f8;color:#222;padding:20px}
h1{text-align:center;margin-bottom:8px;font-size:1.6rem}
.sub{text-align:center;color:#666;margin-bottom:24px;font-size:0.85rem}
.grupos{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px;margin-bottom:28px}
.card{border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)}
.card h2{background:#1a1a2e;color:#fff;padding:10px 14px;font-size:0.95rem;letter-spacing:.5px}
table{width:100%;border-collapse:collapse;background:#fff;font-size:0.82rem}
th{background:#f0f0f5;padding:7px 6px;font-weight:600;color:#444;text-align:center;font-size:0.75rem}
th:first-child{text-align:center;width:28px}
th:nth-child(2){text-align:left}
td{padding:7px 6px;text-align:center;border-bottom:1px solid #eee}
td:nth-child(2){text-align:left;font-weight:500}
.pos-1{color:#2563eb}
.pos-2{color:#0891b2}
.pos-3,.pos-4{color:#666}
.aprov{font-weight:600}
.aprov.alta{color:#16a34a}
.aprov.media{color:#ca8a04}
.aprov.baixa{color:#dc2626}
.grupos h2{margin-bottom:0}
.grupos .card h2{background:#06AA48}
.artilharia-wrap{background:#fff;border-radius:10px;box-shadow:0 2px 8px rgba(0,0,0,.08);padding:16px;max-width:520px;margin:0 auto}
.artilharia-wrap h2{font-size:1rem;margin-bottom:10px;color:#1a1a2e}
.art-item{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid #eee}
.art-item:last-child{border:none}
.art-pos{width:24px;height:24px;border-radius:50%;background:#e0e0e0;display:flex;align-items:center;justify-content:center;font-size:0.75rem;font-weight:700}
.art-pos.top{background:#fbbf24;color:#1a1a2e}
.art-nome{flex:1;font-weight:500}
.art-selecao{color:#888;font-size:0.78rem}
.art-gols{font-weight:700;font-size:1rem;min-width:30px;text-align:center;color:#1a1a2e}
.loading{text-align:center;padding:40px;color:#888}
.error{text-align:center;padding:40px;color:#dc2626}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:0.65rem;font-weight:700;letter-spacing:.3px}
.badge.ao-vivo{background:#dcfce7;color:#16a34a}
.badge.finalizado{background:#fee2e2;color:#dc2626}
.badge.agendado{background:#f3f4f6;color:#666}
</style>
</head>
<body>
<h1>Copa do Mundo 2026</h1>
<p class="sub" id="subtitle">Atualizado em ${dtStr} - Dados do ge.globo</p>
<div id="app" class="loading">Buscando dados...</div>
<script>
function isDateOnlyValue(raw){
  return /^\\d{4}-\\d{2}-\\d{2}$/.test(String(raw || '').trim());
}

function formatDateOnlyPtBr(raw){
  const match=String(raw || '').trim().match(/^(\\d{4})-(\\d{2})-(\\d{2})$/);
  return match ? match[3] + '/' + match[2] : null;
}

function parseGeDateTimeClient(raw){
  if(!raw) return null;
  const value=String(raw).trim();
  if(/[zZ]$|[+-]\\d{2}:\\d{2}$/.test(value)){
    const parsed=new Date(value);
    return isNaN(parsed.getTime()) ? null : parsed;
  }
  if(/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d{3})?)?$/.test(value)){
    const parsed=new Date(value + '-03:00');
    return isNaN(parsed.getTime()) ? null : parsed;
  }
  const parsed=new Date(value);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function formatBrazilDateTimeClient(raw, fallbackLabel, fallbackHour){
  const dateOnlyLabel = formatDateOnlyPtBr(raw);
  if(dateOnlyLabel) return dateOnlyLabel;
  if(raw){
    const date = parseGeDateTimeClient(raw);
    if(date){
      return date.toLocaleDateString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        timeZone: 'America/Bahia',
      }) + ' ' + date.toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'America/Bahia',
      });
    }
  }
  if(fallbackHour) return ((fallbackLabel || '') + ' ' + fallbackHour).trim();
  return '—';
}

async function init(){
  try{
    const r=await fetch('/ge-classificacao');
    const d=await r.json();
    const sub=document.getElementById('subtitle');
    const dt=new Date(d.updatedAt);
    sub.textContent='Atualizado em '+dt.toLocaleString('pt-BR')+' - Dados do ge.globo';
    const app=document.getElementById('app');
    app.className='';
    let html='<div class="grupos">';
    d.grupos.forEach(g=>{
      html+='<div class="card"><h2>'+g.grupo+'</h2><table><thead><tr><th>#</th><th>Time</th><th>P</th><th>J</th><th>V</th><th>E</th><th>D</th><th>GP</th><th>GC</th><th>SG</th><th>%</th></tr></thead><tbody>';
      g.times.forEach(t=>{
        const s=t.stats||{};
        const pClass=t.pos<=1?'pos-1':t.pos<=2?'pos-2':'pos-3';
        const aClass=parseFloat(s.aproveitamento||0)>=70?'alta':parseFloat(s.aproveitamento||0)>=40?'media':'baixa';
        html+='<tr class="'+pClass+'"><td>'+t.pos+'</td><td>'+t.nome+' <span style="color:#999;font-size:0.7rem">'+t.sigla+'</span></td>'
          +'<td><b>'+(t.pts??'-')+'</b></td><td>'+(s.jogos||0)+'</td><td>'+(s.vitorias||0)+'</td><td>'+(s.empates||0)+'</td><td>'+(s.derrotas||0)+'</td>'
          +'<td>'+(s.golsPro||0)+'</td><td>'+(s.golsContra||0)+'</td><td>'+(s.saldoGols||0)+'</td><td class="aprov '+aClass+'">'+(s.aproveitamento||0)+'%</td></tr>';
      });
      html+='</tbody></table></div>';
    });
    html+='</div>';
    html+='<h2 style="text-align:center;margin:18px 0 10px;font-size:1.1rem">Partidas</h2>';
    html+='<div class="grupos">';
    const rodadas={};
    d.jogos.forEach(j=>{
      if(!rodadas[j.rodada])rodadas[j.rodada]=[];
      rodadas[j.rodada].push(j);
    });
    Object.entries(rodadas).forEach(([rod,jogos])=>{
      html+='<div class="card"><h2>'+rod+'</h2><table><thead><tr><th>Mandante</th><th></th><th>Placar</th><th></th><th>Visitante</th><th>Local</th><th>Data/Hora</th><th></th></tr></thead><tbody>';
      jogos.forEach(j=>{
        const hasScore=j.placar1!==null;
        const placar=hasScore?j.placar1+' x '+j.placar2:'—';
        const dtStr=formatBrazilDateTimeClient(j.data, j.dataLabel, j.hora);
        const local=j.local||'—';
        const sc=j.status||'agendado';
        const badgeClass=sc==='ao-vivo'?'ao-vivo':sc==='finalizado'?'finalizado':'agendado';
        const badgeLabel=sc==='ao-vivo'?'AO VIVO':sc==='finalizado'?'Finalizado':'Agendado';
        html+='<tr><td style="text-align:right;font-weight:500">'+j.time1+'</td>'
          +'<td style="text-align:center;color:#999;font-size:0.75rem">'+j.sigla1+'</td>'
          +'<td style="text-align:center;font-weight:700;font-size:0.95rem;'+(hasScore?'color:#1a1a2e':'')+'">'+placar+'</td>'
          +'<td style="text-align:center;color:#999;font-size:0.75rem">'+j.sigla2+'</td>'
          +'<td style="text-align:left;font-weight:500">'+j.time2+'</td>'
          +'<td style="text-align:center;font-size:0.78rem;color:#555">'+local+'</td>'
          +'<td style="text-align:center;font-size:0.78rem;color:#555;white-space:nowrap">'+dtStr+'</td>'
          +'<td><span class="badge '+badgeClass+'">'+badgeLabel+'</span></td></tr>';
      });
      html+='</tbody></table></div>';
    });
    html+='</div>';
    html+='<div class="artilharia-wrap"><h2>Artilharia - Top 5</h2>';
    d.artilharia.top5.forEach(a=>{
      const pClass=a.pos===1?'top':'';
      html+='<div class="art-item"><div class="art-pos '+pClass+'">'+(a.pos||'')+'</div>'
        +'<div class="art-nome">'+a.nome+'</div><div class="art-selecao">'+a.selecao+' · '+a.posicao+'</div>'
        +'<div class="art-gols">'+a.gols+'</div></div>';
    });
    html+='</div>';
    app.innerHTML=html;
  }catch(e){
    document.getElementById('app').innerHTML='<div class="error">Erro ao carregar dados: '+e.message+'</div>';
  }
}
init();
</script>
</body>
</html>`;

  return html;
}

// ── Appwrite sync endpoint (manual trigger) ───────────────────────

app.post("/sync-appwrite", requireAdmin, async (req, res) => {
  if (!AW_SYNC_ENABLED) {
    return res.status(400).json({ error: "Appwrite sync not configured. Set APPWRITE_PROJECT and APPWRITE_API_KEY." });
  }
  const jogos = loadPartidas();
  if (jogos.length === 0) {
    return res.status(400).json({ error: "No match data available. Wait for the first scrape to complete." });
  }
  const result = await syncToAppwrite(jogos);
  res.json(result);
});

function calcPontosPalpite(palpite1, palpite2, placar1, placar2) {
  if (palpite1 === placar1 && palpite2 === placar2) return 5;
  return 0;
}

async function recalcularPontosPartida(partidaId, placar1, placar2) {
  if (!awDatabases || placar1 == null || placar2 == null) return { atualizados: 0 };
  let atualizados = 0;
  let offset = 0;
  while (true) {
    const palpRes = await awDatabases.listDocuments(AW_DB_ID, "palpites", [
      Query.equal("partidaId", partidaId),
      Query.limit(100),
      Query.offset(offset),
    ]);
    for (const doc of palpRes.documents) {
      const pl = doc;
      const pontos = calcPontosPalpite(pl.palpite1, pl.palpite2, placar1, placar2);
      await awDatabases.updateDocument(AW_DB_ID, "palpites", doc.$id, { pontos });
      atualizados++;
    }
    if (palpRes.documents.length < 100) break;
    offset += 100;
  }
  return { atualizados };
}

// ── Admin: roles (coleção admin_roles) ────────────────────────────

app.post("/admin/users/set-role", requireAdmin, async (req, res) => {
  if (!awDatabases) return res.status(503).json({ error: "Appwrite not configured" });
  const userId = String(req.body?.userId || "").trim();
  const role = String(req.body?.role || "").trim();
  if (!userId || !["admin", "user"].includes(role)) {
    return res.status(400).json({ error: "userId and role (admin|user) required" });
  }
  try {
    const existing = await awDatabases.listDocuments(AW_DB_ID, AW_ADMIN_ROLES_COLLECTION, [
      Query.equal("userId", userId),
      Query.limit(1),
    ]);
    if (role === "admin") {
      if (existing.documents.length === 0) {
        await awDatabases.createDocument(AW_DB_ID, AW_ADMIN_ROLES_COLLECTION, ID.unique(), { userId });
      }
    } else if (existing.documents.length > 0) {
      await awDatabases.deleteDocument(AW_DB_ID, AW_ADMIN_ROLES_COLLECTION, existing.documents[0].$id);
    }
    // Mantém profile.role alinhado (legado / UI)
    const profiles = await awDatabases.listDocuments(AW_DB_ID, AW_PROFILES_COLLECTION, [
      Query.equal("userId", userId),
      Query.limit(1),
    ]);
    if (profiles.documents[0]) {
      await awDatabases.updateDocument(AW_DB_ID, AW_PROFILES_COLLECTION, profiles.documents[0].$id, { role });
    }
    res.json({ ok: true, userId, role });
  } catch (err) {
    console.error("[admin/set-role]", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/users/admins", requireAdmin, async (_req, res) => {
  if (!awDatabases) return res.status(503).json({ error: "Appwrite not configured" });
  try {
    const roles = await awDatabases.listDocuments(AW_DB_ID, AW_ADMIN_ROLES_COLLECTION, [Query.limit(100)]);
    res.json({ admins: roles.documents.map((d) => d.userId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Copia profile.role=admin → admin_roles (migração one-shot). */
app.post("/admin/users/seed-roles", requireAdmin, async (_req, res) => {
  if (!awDatabases) return res.status(503).json({ error: "Appwrite not configured" });
  try {
    const profiles = await awDatabases.listDocuments(AW_DB_ID, AW_PROFILES_COLLECTION, [
      Query.equal("role", "admin"),
      Query.limit(100),
    ]);
    let created = 0;
    let skipped = 0;
    for (const p of profiles.documents) {
      const userId = p.userId;
      if (!userId) continue;
      const existing = await awDatabases.listDocuments(AW_DB_ID, AW_ADMIN_ROLES_COLLECTION, [
        Query.equal("userId", userId),
        Query.limit(1),
      ]);
      if (existing.documents.length > 0) {
        skipped++;
        continue;
      }
      await awDatabases.createDocument(AW_DB_ID, AW_ADMIN_ROLES_COLLECTION, ID.unique(), { userId });
      created++;
    }
    res.json({ ok: true, created, skipped, scanned: profiles.documents.length });
  } catch (err) {
    console.error("[admin/seed-roles]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: partidas CRUD (write só via API key) ───────────────────

app.post("/admin/partidas/update", requireAdmin, async (req, res) => {
  if (!awDatabases) return res.status(503).json({ error: "Appwrite not configured" });
  const id = String(req.body?.id || "").trim();
  if (!id) return res.status(400).json({ error: "id required" });
  const allowed = ["placar1", "placar2", "status", "data", "time1", "time2", "grupo", "fase"];
  const update = {};
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(req.body, k)) update[k] = req.body[k];
  }
  if (Object.keys(update).length === 0) return res.status(400).json({ error: "no fields" });
  try {
    const doc = await awDatabases.updateDocument(AW_DB_ID, AW_COLLECTION_ID, id, update);
    let pontos = null;
    if (update.placar1 != null && update.placar2 != null) {
      pontos = await recalcularPontosPartida(id, update.placar1, update.placar2);
    }
    res.json({ ok: true, partida: doc, pontos });
  } catch (err) {
    console.error("[admin/partidas/update]", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/partidas/create", requireAdmin, async (req, res) => {
  if (!awDatabases) return res.status(503).json({ error: "Appwrite not configured" });
  const { time1, time2, grupo, fase, data, placar1, placar2, status } = req.body || {};
  if (!time1 || !time2 || !data) return res.status(400).json({ error: "time1, time2, data required" });
  try {
    const doc = await awDatabases.createDocument(AW_DB_ID, AW_COLLECTION_ID, ID.unique(), {
      time1: String(time1).trim(),
      time2: String(time2).trim(),
      grupo: String(grupo || "").trim().toUpperCase(),
      fase: String(fase || "grupos"),
      data: new Date(data).toISOString(),
      placar1: placar1 ?? null,
      placar2: placar2 ?? null,
      status: status || "agendado",
    });
    res.json({ ok: true, partida: doc });
  } catch (err) {
    console.error("[admin/partidas/create]", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/partidas/delete", requireAdmin, async (req, res) => {
  if (!awDatabases) return res.status(503).json({ error: "Appwrite not configured" });
  const id = String(req.body?.id || "").trim();
  if (!id) return res.status(400).json({ error: "id required" });
  try {
    await awDatabases.deleteDocument(AW_DB_ID, AW_COLLECTION_ID, id);
    res.json({ ok: true, id });
  } catch (err) {
    console.error("[admin/partidas/delete]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── User: update próprio perfil (campos seguros) ──────────────────

app.patch("/me/profile", requireAppwriteUser, async (req, res) => {
  if (!awDatabases) return res.status(503).json({ error: "Appwrite not configured" });
  const userId = req.appwriteUser.$id;
  const safe = {};
  if (typeof req.body?.name === "string") safe.name = req.body.name.slice(0, 128);
  if (typeof req.body?.avatarUrl === "string") safe.avatarUrl = req.body.avatarUrl.slice(0, 2048);
  if (typeof req.body?.ultimoClaim === "string") safe.ultimoClaim = req.body.ultimoClaim.slice(0, 32);
  if (typeof req.body?.streakDias === "number") safe.streakDias = Math.max(0, Math.min(3650, req.body.streakDias));
  // Nunca aceitar role aqui
  if (Object.keys(safe).length === 0) return res.status(400).json({ error: "no safe fields" });
  try {
    const profiles = await awDatabases.listDocuments(AW_DB_ID, AW_PROFILES_COLLECTION, [
      Query.equal("userId", userId),
      Query.limit(1),
    ]);
    if (!profiles.documents[0]) return res.status(404).json({ error: "profile not found" });
    const doc = await awDatabases.updateDocument(
      AW_DB_ID,
      AW_PROFILES_COLLECTION,
      profiles.documents[0].$id,
      safe,
    );
    res.json({ ok: true, profile: doc });
  } catch (err) {
    console.error("[me/profile]", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/me/is-admin", requireAppwriteUser, async (req, res) => {
  const admin = await isAppwriteAdminUserId(req.appwriteUser.$id);
  res.json({ isAdmin: admin });
});

// ── Routes ────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  if (!cache.data) {
    return res.type("html").send(renderHtml({ updatedAt: new Date().toISOString(), grupos: [], jogos: [], artilharia: { top5: [] } }));
  }
  res.type("html").send(renderHtml(cache.data));
});

app.get("/ge-classificacao", async (req, res) => {
  const now = Date.now();
  if (cache.data && now - cache.timestamp < CACHE_TTL) {
    return res.json(cache.data);
  }

  try {
    const { grupos, artilharia, jogosRaw } = await scrape();

    // Merge with persistent history
    const existing = loadPartidas();
    const merged = mergePartidas(existing, jogosRaw);
    savePartidas(merged);

    // Sync to Appwrite server-side (no user auth needed)
    if (AW_SYNC_ENABLED) {
      syncToAppwrite(merged).then((r) => {
        if (r.atualizadas > 0 || r.criadas > 0) {
          console.log(`[appwrite] sync concluído: ${r.atualizadas} atualizadas, ${r.criadas} criadas`);
        }
        if (r.erros.length > 0) {
          console.warn(`[appwrite] ${r.erros.length} erro(s):`, r.erros.slice(0, 3).join("; "));
        }
      }).catch((err) => console.error("[appwrite] sync error:", err.message));
    }

    const result = {
      url: "https://ge.globo.com/futebol/copa-do-mundo/",
      updatedAt: new Date().toISOString(),
      totalGrupos: grupos.length,
      grupos,
      jogos: merged,
      artilharia: { top5: artilharia },
    };

    cache = { data: result, timestamp: Date.now() };
    res.json(result);
  } catch (err) {
    console.error("[ge-classificacao] scrape error:", err.message);
    // Stale cache fallback — serve expired data rather than 500
    if (cache.data) {
      return res.json({ ...cache.data, stale: true, updatedAt: cache.data.updatedAt });
    }
    res.status(500).json({
      error: "Failed to fetch classification",
      detail: err.message,
    });
  }
});

app.get("/partidas", (req, res) => {
  const partidas = loadPartidas();
  const { status, fase, grupo, rodada } = req.query;

  let result = partidas;
  if (status) result = result.filter((p) => p.status === status);
  if (fase) result = result.filter((p) => p.fase === fase);
  if (grupo) result = result.filter((p) => p.grupo === grupo);
  if (rodada) result = result.filter((p) => p.rodada === rodada);

  res.json({
    total: result.length,
    partidas: result,
  });
});

app.get("/partidas/em-andamento", (req, res) => {
  const partidas = loadPartidas().filter((p) => p.status === "ao-vivo");
  res.json({
    total: partidas.length,
    partidas,
  });
});

app.get("/estatisticas", (req, res) => {
  const partidas = loadPartidas();
  res.json(buildTournamentStats(partidas, cache.data?.updatedAt || null));
});

app.get("/grupos", async (req, res) => {
  const now = Date.now();
  if (cache.data && now - cache.timestamp < CACHE_TTL) {
    return res.json({
      totalGrupos: cache.data.totalGrupos,
      grupos: cache.data.grupos,
    });
  }

  try {
    const { grupos } = await scrape();

    cache = {
      data: {
        url: null,
        totalGrupos: grupos.length,
        grupos,
        jogos: cache.data?.jogos || [],
        artilharia: cache.data?.artilharia || { top5: [] },
        updatedAt: new Date().toISOString(),
      },
      timestamp: Date.now(),
    };

    res.json({
      totalGrupos: grupos.length,
      grupos,
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to fetch groups",
      detail: err.message,
    });
  }
});

// ── Background polling ────────────────────────────────────────────

// ── Live match details endpoint ───────────────────────────────────
app.get("/ge-live/:matchId?", async (req, res) => {
  // Accept either a path matchId (scraper internal id) or query params (time1, time2, optional fase)
  const { matchId } = req.params;
  const { time1, time2, fase } = req.query;
  const partidas = loadPartidas();
  let match = null;
  if (matchId) {
    match = partidas.find(p => p.id === matchId);
  } else if (time1 && time2) {
    match = partidas.find(p => p.time1 === time1 && p.time2 === time2 && (!fase || p.fase === fase));
  }
  if (!match) {
    return res.status(404).json({ error: "Match not found" });
  }
  // Build href from match data if missing
  if (!match.href) {
    const base = "https://ge.globo.com/futebol/copa-do-mundo/jogo";
    let datePart = "";
    const dateSrc = match.data || match.startDate;
    if (dateSrc) {
      const d = new Date(dateSrc);
      if (!isNaN(d.getTime())) {
        datePart = `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
      }
    }
    const name1 = (match.time1 || match.sigla1 || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, "-");
    const name2 = (match.time2 || match.sigla2 || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, "-");
    if (datePart && name1 && name2) {
      match.href = `${base}/${datePart}/${name1}-${name2}.ghtml`;
    }
  }
  let attempts = 0;
  let data = null;
  while (attempts < 3 && !data) {
    data = await fetchLiveDetails(match);
    attempts++;
  }
  if (!data) {
    data = {
      matchId: match.id,
      score: match.placar1 != null ? `${match.placar1} x ${match.placar2}` : null,
      status: match.status || "agendado",
      time1: match.time1,
      time2: match.time2,
      placar1: match.placar1,
      placar2: match.placar2,
      fase: match.fase,
      local: match.local || null,
      hora: match.hora || null,
      dataLabel: match.dataLabel || null,
      startDate: match.startDate || match.data || null,
      halftimeScore: null,
      goalsByHalf: null,
      comebackInfo: null,
      scoringTimeline: [],
      penalties: null,
      statistics: { possession: null, shots: null, yellowCards: null, redCards: null, corners: null },
      extraStats: null,
      events: [],
    };
  }
  res.json(data);
});

const POLL_NORMAL = 5 * 60 * 1000;   // 5 min when no live games
const POLL_LIVE = 120 * 1000;          // 2 min when games are live
let currentInterval = POLL_NORMAL;
let pollTimer = null;

function hasLiveMatches() {
  if (!cache.data?.jogos) return false;
  return cache.data.jogos.some((j) => j.status === "ao-vivo");
}

async function pollScrape() {
  try {
    const { grupos, artilharia, jogosRaw } = await scrape();
    const existing = loadPartidas();
    const merged = mergePartidas(existing, jogosRaw);
    savePartidas(merged);

    // Sync to Appwrite automatically
    if (AW_SYNC_ENABLED) {
      syncToAppwrite(merged).then((r) => {
        if (r.atualizadas > 0 || r.criadas > 0) {
          console.log(`[poll][appwrite] ${r.atualizadas} atualizadas, ${r.criadas} criadas`);
        }
        if (r.erros.length > 0) {
          console.warn(`[poll][appwrite] ${r.erros.length} erro(s):`, r.erros.slice(0, 3).join("; "));
        }
      }).catch((err) => console.error("[poll][appwrite] sync error:", err.message));
    }

    cache = {
      data: {
        url: "https://ge.globo.com/futebol/copa-do-mundo/",
        updatedAt: new Date().toISOString(),
        totalGrupos: grupos.length,
        grupos,
        jogos: merged,
        artilharia: { top5: artilharia },
      },
      timestamp: Date.now(),
    };

    const liveCount = merged.filter((j) => j.status === "ao-vivo").length;
    console.log(`[poll] ${new Date().toLocaleTimeString("pt-BR")} — ${merged.length} partidas, ${liveCount} ao vivo`);
  } catch (err) {
    console.error(`[poll] ${new Date().toLocaleTimeString("pt-BR")} — erro: ${err.message}`);
  }

  // Adjust interval: 1min if live, 5min otherwise
  const newInterval = hasLiveMatches() ? POLL_LIVE : POLL_NORMAL;
  if (newInterval !== currentInterval) {
    currentInterval = newInterval;
    clearInterval(pollTimer);
    pollTimer = setInterval(pollScrape, currentInterval);
    console.log(`[poll] intervalo alterado para ${currentInterval / 1000}s`);
  }
}

// ── Start ─────────────────────────────────────────────────────────

async function fetchLiveDetails(match) {
  if (!match.href) return null;
  const cached = liveCache.get(match.id);
  if (cached && Date.now() - cached.ts < GE_LIVE_TTL_MS) {
    return cached.data;
  }
  const browser = await chromium.launch(chromiumLaunchOptions());
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(match.href, { waitUntil: "domcontentloaded", timeout: 30000 });

    const trv2 = await page.evaluate(() => {
      const t = window.trv2;
      if (!t) return null;
      const participants = t.transmission?.match?.participants || [];
      const homeP = participants.find((p) => p.participantType === "MANDANTE" || p.positionSide === "home") || participants[0];
      const awayP = participants.find((p) => p.participantType === "VISITANTE" || p.positionSide === "away") || participants[1];
      return {
        homeTeamId: homeP?.teamId || homeP?.id || null,
        awayTeamId: awayP?.teamId || awayP?.id || null,
        stats: {
          home: t.statistics?.homeTeam || null,
          away: t.statistics?.awayTeam || null,
        },
        plays: (t.plays || []).map((p) => ({
          moment: p.moment,
          period: p.period?.id || null,
          periodLabel: p.period?.label || null,
          playTypeId: p.playType?.id || null,
          playTypeLabel: p.playType?.label || null,
          title: p.title || null,
          athlete: p.details?.athlete?.popularName || p.details?.athlete?.name || null,
          teamId: p.details?.team?.id || p.details?.teamId || null,
          kind: p.details?.kind || null,
        })),
        detailedScoreboard: t.transmission?.match?.detailedScoreboard || null,
      };
    });

    const rm = await page.evaluate(() => {
      const data = window.roundMatches;
      if (!data) return null;
      const matches = data.championship || [];
      return matches.length > 0 ? matches.map((m) => ({
        time1: m.homeTeam?.popularName || m.homeTeam?.name || null,
        time2: m.awayTeam?.popularName || m.awayTeam?.name || null,
        penalty: m.match?.scoreboard?.penalty || null,
      })) : null;
    });

    const { time1, time2 } = match;

    const isHome = (play) => {
      if (play.teamId && trv2.homeTeamId && play.teamId === trv2.homeTeamId) return true;
      if (play.teamId && trv2.awayTeamId && play.teamId === trv2.awayTeamId) return false;
      if (play.teamId && trv2.homeTeamId && String(play.teamId) === String(trv2.homeTeamId)) return true;
      if (play.teamId && trv2.awayTeamId && String(play.teamId) === String(trv2.awayTeamId)) return false;
      return null;
    };
    const deduceTeam = (play) => {
      const home = isHome(play);
      if (home === true) return "home";
      if (home === false) return "away";
      const t = (play.title || "").toLowerCase();
      if (t.includes((time1 || "").toLowerCase())) return "home";
      if (t.includes((time2 || "").toLowerCase())) return "away";
      return null;
    };

    const goals = (trv2.plays || []).filter((p) => p.playTypeId === "GOAL" || p.playTypeId === "PENALTY_GOAL");
    const firstHalfGoals = goals.filter((p) => p.period === "PRIMEIRO_TEMPO");
    const secondHalfGoals = goals.filter((p) => p.period === "SEGUNDO_TEMPO");
    const extraTimeGoals = goals.filter((p) => p.period === "POS_JOGO" || p.period === "PRIMEIRO_TEMPO_PRORROGACAO" || p.period === "SEGUNDO_TEMPO_PRORROGACAO");

    const countSide = (arr, side) => arr.filter((g) => deduceTeam(g) === side).length;

    const goalsByHalf = {
      firstHalf: { home: countSide(firstHalfGoals, "home"), away: countSide(firstHalfGoals, "away") },
      secondHalf: { home: countSide(secondHalfGoals, "home"), away: countSide(secondHalfGoals, "away") },
      extraTime: extraTimeGoals.length > 0 ? { home: countSide(extraTimeGoals, "home"), away: countSide(extraTimeGoals, "away") } : null,
    };

    const halftimeHome = countSide(firstHalfGoals, "home");
    const halftimeAway = countSide(firstHalfGoals, "away");
    const halftimeScore = { home: halftimeHome, away: halftimeAway };

    const finalHome = match.placar1;
    const finalAway = match.placar2;

    let comebackInfo = null;
    if (finalHome != null && finalAway != null) {
      if (halftimeAway > halftimeHome && finalHome > finalAway) {
        comebackInfo = { team: time1, hadComeback: true, description: `${time1} virou o placar no 2º tempo` };
      } else if (halftimeHome > halftimeAway && finalAway > finalHome) {
        comebackInfo = { team: time2, hadComeback: true, description: `${time2} virou o placar no 2º tempo` };
      } else if (halftimeHome === halftimeAway && halftimeHome > 0 && (finalHome !== finalAway)) {
        comebackInfo = { hadComeback: false, note: "placar empatado no intervalo com definição no 2º tempo" };
      }
    }

    const scoringTimeline = goals.map((g) => ({
      minute: g.moment || null,
      half: g.period === "PRIMEIRO_TEMPO" ? "first" : g.period === "SEGUNDO_TEMPO" ? "second" : g.period === "POS_JOGO" || g.period?.startsWith("PRIMEIRO_TEMPO_P") ? "extraTime" : g.period,
      team: deduceTeam(g),
      scorer: g.athlete,
      kind: g.kind || g.playTypeId,
    }));

    let penalties = null;
    if (rm) {
      const m = rm.find((x) =>
        (x.time1 && x.time1 === time1) && (x.time2 && x.time2 === time2)
      );
      if (m?.penalty) {
        penalties = { home: m.penalty.home, away: m.penalty.away };
      }
    }

    const extraStats = trv2.stats?.home && trv2.stats?.away
      ? {
          home: {
            offside: trv2.stats.home.offSide?.total ?? null,
            fouls: trv2.stats.home.foulMade?.total ?? null,
            tackles: trv2.stats.home.tackle?.total ?? null,
            defense: trv2.stats.home.defense?.total ?? null,
            goalFinish: trv2.stats.home.goalFinish?.total ?? null,
            blockedFinish: trv2.stats.home.blockedFinish?.total ?? null,
            ballOnPost: trv2.stats.home.ballOnThePost?.total ?? null,
            penaltyReceived: trv2.stats.home.penaltyReceived?.total ?? null,
            passesTotal: trv2.stats.home.totalPasses?.total ?? null,
            passesCorrect: trv2.stats.home.rightPasses?.total ?? null,
          },
          away: {
            offside: trv2.stats.away.offSide?.total ?? null,
            fouls: trv2.stats.away.foulMade?.total ?? null,
            tackles: trv2.stats.away.tackle?.total ?? null,
            defense: trv2.stats.away.defense?.total ?? null,
            goalFinish: trv2.stats.away.goalFinish?.total ?? null,
            blockedFinish: trv2.stats.away.blockedFinish?.total ?? null,
            ballOnPost: trv2.stats.away.ballOnThePost?.total ?? null,
            penaltyReceived: trv2.stats.away.penaltyReceived?.total ?? null,
            passesTotal: trv2.stats.away.totalPasses?.total ?? null,
            passesCorrect: trv2.stats.away.rightPasses?.total ?? null,
          },
        }
      : null;

    const evt = trv2.plays
      .filter((p) => p.playTypeId !== "NARRATIVE" && p.playTypeId !== "IMPORTANT" && p.title)
      .map((p) => ({
        type: p.playTypeLabel || p.playTypeId,
        minute: p.moment || null,
        half: p.periodLabel || p.period || null,
        description: p.title || null,
      }));

    const bpHome = trv2.stats?.home?.ballPossession?.total;
    const bpAway = trv2.stats?.away?.ballPossession?.total;
    const possessionStat = bpHome != null && bpAway != null && (bpHome > 0 || bpAway > 0)
      ? `${bpHome} / ${bpAway}`
      : null;

    const shotsStat = trv2.stats?.home?.goalFinish?.total != null && trv2.stats?.home?.wrongFinish?.total != null
      ? `${(trv2.stats.home.goalFinish.total || 0) + (trv2.stats.home.wrongFinish?.total || 0) + (trv2.stats.home.blockedFinish?.total || 0)} / ${(trv2.stats.away.goalFinish?.total || 0) + (trv2.stats.away.wrongFinish?.total || 0) + (trv2.stats.away.blockedFinish?.total || 0)}`
      : null;

    const cornersStat = trv2.stats?.home?.cornerKick?.total != null && trv2.stats?.away?.cornerKick?.total != null
      ? `${trv2.stats.home.cornerKick.total} / ${trv2.stats.away.cornerKick.total}`
      : null;

    const yellowCardsStat = trv2.stats?.home?.yellowCardReceived?.total != null
      ? `${trv2.stats.home.yellowCardReceived.total} / ${trv2.stats.away?.yellowCardReceived?.total ?? 0}`
      : null;

    const redCardsStat = trv2.stats?.home?.redCardReceived?.total != null
      ? `${trv2.stats.home.redCardReceived.total} / ${trv2.stats.away?.redCardReceived?.total ?? 0}`
      : null;

    const score =
      match.placar1 != null && match.placar2 != null
        ? `${match.placar1} x ${match.placar2}`
        : null;

    const result = {
      matchId: match.id,
      score,
      status: match.status,
      halftimeScore,
      goalsByHalf,
      comebackInfo,
      scoringTimeline,
      penalties,
      statistics: {
        possession: possessionStat,
        shots: shotsStat,
        yellowCards: yellowCardsStat,
        redCards: redCardsStat,
        corners: cornersStat,
      },
      extraStats,
      events: evt.slice(0, 30),
    };
    liveCache.set(match.id, { data: result, ts: Date.now() });
    return result;
  } catch (err) {
    console.error(`[fetchLiveDetails] error for ${match.id} (${match.time1} x ${match.time2}): ${err.message}`);
    if (err.stack) console.error(err.stack.split('\n').slice(0, 5).join('\n'));
    return null;
  } finally {
    await browser.close();
  }
}

// ── Elenco scrape (one-time, Wikipedia squads) ──
const ELENCO_FILE = join(DATA_DIR, "elenco.json");

app.post("/admin/scrape-elenco", requireAdmin, async (_req, res) => {
  try {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto("https://en.wikipedia.org/wiki/2026_FIFA_World_Cup_squads", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // Map Wikipedia country names to our team names
    const nameMap = {
      "Bangladesh": null, "Bolivia": null, "Bulgaria": null, // skip non-teams
    };

    const squads = await page.evaluate(() => {
      const results = {};

      // Walk DOM in order: headings set current country, tables collect players
      const content = document.querySelector("#mw-content-text") || document.body;
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_ELEMENT, null);

      let currentCountry = "";
      let node;
      while ((node = walker.nextNode())) {
        if (node.tagName === "H2" || node.tagName === "H3") {
          const span = node.querySelector(".mw-headline");
          currentCountry = span ? span.textContent.trim() : node.textContent.trim();
        }
        if (node.tagName === "TABLE" && node.classList.contains("wikitable")) {
          const headers = [];
          node.querySelectorAll("th").forEach((h) => {
            headers.push(h.textContent.trim());
          });

          if (!headers.includes("No.") || !headers.includes("Player")) continue;

          const players = [];
          node.querySelectorAll("tr").forEach((r) => {
            const allCells = r.querySelectorAll("td, th");
            if (allCells.length < 3) return;
            const firstCell = allCells[0];
            const firstText = firstCell.textContent.trim();
            if (!firstText || headers.includes(firstText)) return;

            const num = parseInt(firstText) || firstText;
            const pos = allCells[1]?.textContent.trim() || "";
            const playerCell = allCells[2];

            // Extract player name and Wikipedia link from the Player column
            const playerLink = playerCell?.querySelector("a");
            const nome = (playerLink?.textContent || playerCell?.textContent || "").trim();
            const wikipediaUrl = playerLink?.href || null;
            if (!nome || nome.includes("[")) return;

            players.push({
              nome,
              posicao: pos,
              numero: typeof num === "number" ? num : 0,
              wikipediaUrl,
            });
          });

          if (players.length >= 10 && currentCountry) {
            results[currentCountry] = players;
          }
        }
      }
      return results;
    });

    // Map Wikipedia country names → our team names
    const GE_TO_WIKI = {
      "Tchéquia": "Czech Republic",
      "África do Sul": "South Africa",
      "México": "Mexico",
      "Coreia do Sul": "South Korea",
      "Suíça": "Switzerland",
      "Bósnia e Herzegovina": "Bosnia and Herzegovina",
      "Canadá": "Canada",
      "Catar": "Qatar",
      "Escócia": "Scotland",
      "Marrocos": "Morocco",
      "Brasil": "Brazil",
      "Haiti": "Haiti",
      "Estados Unidos": "United States",
      "Austrália": "Australia",
      "Turquia": "Turkey",
      "Paraguai": "Paraguay",
      "Alemanha": "Germany",
      "Costa do Marfim": "Ivory Coast",
      "Equador": "Ecuador",
      "Curaçao": "Curaçao",
      "Holanda": "Netherlands",
      "Suécia": "Sweden",
      "Tunísia": "Tunisia",
      "Japão": "Japan",
      "Bélgica": "Belgium",
      "Irã": "Iran",
      "Nova Zelândia": "New Zealand",
      "Egito": "Egypt",
      "Espanha": "Spain",
      "Arábia Saudita": "Saudi Arabia",
      "Uruguai": "Uruguay",
      "Cabo Verde": "Cape Verde",
      "França": "France",
      "Iraque": "Iraq",
      "Noruega": "Norway",
      "Senegal": "Senegal",
      "Argentina": "Argentina",
      "Áustria": "Austria",
      "Jordânia": "Jordan",
      "Argélia": "Algeria",
      "Portugal": "Portugal",
      "Uzbequistão": "Uzbekistan",
      "Colômbia": "Colombia",
      "República Democrática do Congo": "DR Congo",
      "Inglaterra": "England",
      "Gana": "Ghana",
      "Panamá": "Panama",
      "Croácia": "Croatia",
    };

    const elenco = {};
    let totalPlayers = 0;
    const missing = [];

    for (const [geName, wikiName] of Object.entries(GE_TO_WIKI)) {
      const data = squads[wikiName];
      if (data && data.length > 0) {
        elenco[geName] = data;
        totalPlayers += data.length;
      } else {
        missing.push(geName);
        elenco[geName] = [];
      }
    }

    writeFileSync(ELENCO_FILE, JSON.stringify(elenco, null, 2));
    await browser.close();

    res.json({
      success: true,
      totalPlayers,
      teams: Object.keys(elenco).length,
      missing,
      file: ELENCO_FILE,
    });
  } catch (err) {
    console.error("[scrape-elenco]", err);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint to populate figurinhas collection from elenco.json
app.post("/admin/populate-figurinhas", requireAdmin, async (_req, res) => {
  if (!AW_SYNC_ENABLED) return res.status(400).json({ error: "Appwrite not configured" });

  try {
    const elenco = JSON.parse(readFileSync(ELENCO_FILE, "utf-8"));
    const client = new Client()
      .setEndpoint(AW_ENDPOINT)
      .setProject(AW_PROJECT)
      .setKey(AW_API_KEY);
    const db = new Databases(client);
    const COLL = "figurinhas";

    const results = [];
    for (const [timeId, jogadores] of Object.entries(elenco)) {
      if (!jogadores.length) {
        results.push({ timeId, count: 0, error: "sem dados" });
        continue;
      }

      // Delete existing figurinhas for this team then re-create
      try {
        const existing = await db.listDocuments(AW_DB_ID, COLL, [Query.equal("timeId", timeId), Query.limit(100)]);
        for (const doc of existing.documents) {
          await db.deleteDocument(AW_DB_ID, COLL, doc.$id);
        }
      } catch (_) { /* ignore */ }

      let created = 0;
      for (const j of jogadores) {
        try {
          await db.createDocument(AW_DB_ID, COLL, ID.unique(), {
            timeId,
            nome: j.nome,
            posicao: j.posicao || "",
            numero: j.numero || 0,
            imagemUrl: j.imagemUrl || null,
            wikipediaUrl: j.wikipediaUrl || null,
          });
          created++;
        } catch (e) {
          console.error(`[populate] erro ${timeId}/${j.nome}:`, e.message);
        }
      }
      results.push({ timeId, count: created, total: jogadores.length });
    }

    res.json({ success: true, results });
  } catch (err) {
    console.error("[populate-figurinhas]", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Scrape player images from Wikipedia ──
app.post("/admin/scrape-figurinhas-images", requireAdmin, async (_req, res) => {
  if (!AW_SYNC_ENABLED) return res.status(400).json({ error: "Appwrite not configured" });
  const { force } = _req.query;

  const client = new Client()
    .setEndpoint(AW_ENDPOINT)
    .setProject(AW_PROJECT)
    .setKey(AW_API_KEY);
  const db = new Databases(client);
  const COLL = "figurinhas";

  try {
    // List all figurinhas
    let allDocs = [];
    let offset = 0;
    const limit = 100;
    while (true) {
      const page = await db.listDocuments(AW_DB_ID, COLL, [Query.limit(limit), Query.offset(offset)]);
      allDocs = allDocs.concat(page.documents);
      if (page.documents.length < limit) break;
      offset += limit;
    }
    console.log(`[scrape-images] ${allDocs.length} figurinhas encontradas`);

    const browser = await chromium.launch({ headless: true });
    let updated = 0;
    let skipped = 0;
    let failed = 0;

    try {
      const context = await browser.newContext();
      const page = await context.newPage();

      // Process sequentially to avoid rate limiting
      for (const doc of allDocs) {
        const wikiUrl = doc.wikipediaUrl;
        if (!wikiUrl) {
          skipped++;
          continue;
        }
        // Skip if already has image (or was attempted and had no image), unless force=true
        if (!force && doc.imagemUrl !== null) {
          skipped++;
          continue;
        }

        try {
          // Navigate to the player's Wikipedia page
          await page.goto(wikiUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
          await page.waitForTimeout(500);

          const imgUrl = await page.evaluate(() => {
            // Try infobox image: look for .infobox img or .mw-file-description img
            const infobox = document.querySelector(".infobox");
            if (infobox) {
              const img = infobox.querySelector("img");
              if (img) {
                // Prefer srcset for higher res, fallback to src
                const srcset = img.getAttribute("srcset");
                if (srcset) {
                  const candidates = srcset.split(",").map(s => s.trim()).filter(Boolean);
                  // Pick the largest (last entry)
                  const largest = candidates[candidates.length - 1].split(/\s+/)[0];
                  if (largest && largest.startsWith("//")) return "https:" + largest;
                  if (largest && largest.startsWith("http")) return largest;
                }
                const src = img.getAttribute("src");
                if (src && src.startsWith("//")) return "https:" + src;
                if (src && src.startsWith("http")) return src;
              }
            }
            return null;
          });

          if (imgUrl) {
            // Ensure HTTPS
            const finalUrl = imgUrl.startsWith("//") ? "https:" + imgUrl : imgUrl;
            await db.updateDocument(AW_DB_ID, COLL, doc.$id, { imagemUrl: finalUrl });
            updated++;
            console.log(`[scrape-images] atualizado: ${doc.nome} (${doc.timeId}) → ${finalUrl}`);
          } else {
            console.log(`[scrape-images] sem imagem: ${doc.nome} (${doc.timeId})`);
            // Mark as empty so we don't retry
            await db.updateDocument(AW_DB_ID, COLL, doc.$id, { imagemUrl: "" });
            failed++;
          }
        } catch (err) {
          console.error(`[scrape-images] erro ao processar ${doc.nome}: ${err.message}`);
          failed++;
        }
      }
    } finally {
      await browser.close();
    }

    res.json({
      success: true,
      total: allDocs.length,
      updated,
      skipped,
      failed,
    });
  } catch (err) {
    console.error("[scrape-figurinhas-images]", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Álbum de Figurinhas Route ──────────────────────────────────

app.get("/album", (req, res) => {
  res.type("html").send(renderAlbumHtml());
});

// ── PicPay / Pote de Ouro Routes ────────────────────────────────────────────

const AW_COLLECTION_BOLOES = "boloes";
const AW_COLLECTION_PARTICIPANTES = "bolao_participantes";
const AW_COLLECTION_BOLAO_PAGAMENTOS = "bolao_pagamentos";

// Webhook API Key gerada no Painel Lojista → Configurações → URL de notificação
const PICPAY_WEBHOOK_API_KEY = process.env.PICPAY_WEBHOOK_API_KEY || "";

/**
 * POST /api/pagamentos/pix
 * Gera Link de Pagamento PicPay (com PIX) para entrada em bolão pago.
 * Requer JWT do usuário no header Authorization.
 * Response: { paymentLinkId, qrcode, paymentUrl, valor, expiresAt, referenceId }
 */
app.post("/api/pagamentos/pix", requireAppwriteUser, async (req, res) => {
  const corsOrigin = resolveCorsOrigin(req);
  if (corsOrigin) res.setHeader("Access-Control-Allow-Origin", corsOrigin);

  try {
    const { bolaoId } = req.body;
    if (!bolaoId) return res.status(400).json({ error: "bolaoId obrigatório" });

    const user = req.appwriteUser;

    // Buscar dados do bolão
    const bolao = await awDatabases.getDocument(AW_DB_ID, AW_COLLECTION_BOLOES, bolaoId);
    if (!bolao) return res.status(404).json({ error: "Bolão não encontrado" });
    if (bolao.tipo !== "pote_ouro") return res.status(400).json({ error: "Bolão não é do tipo Pote de Ouro" });

    const valor = parseFloat(bolao.valorInscricao || 10);
    if (!valor || valor <= 0) return res.status(400).json({ error: "Valor de inscrição inválido" });

    // Verificar se já pagou
    try {
      const jaExiste = await awDatabases.listDocuments(AW_DB_ID, AW_COLLECTION_BOLAO_PAGAMENTOS, [
        Query.equal("bolaoId", bolaoId),
        Query.equal("usuarioId", user.$id),
        Query.equal("status", "paid"),
      ]);
      if (jaExiste.documents.length > 0) {
        return res.status(409).json({ error: "Usuário já pagou para participar deste bolão" });
      }
    } catch {}

    // Gerar ID único para esta transação
    const referenceId = `bolao_${bolaoId}_user_${user.$id}_${Date.now()}`;

    const callbackUrl = `${process.env.API_BASE_URL || "https://apipitaco2026.ctqs.com.br"}/webhook/picpay`;

    const cobranca = await criarCobrancaPicPay({
      referenceId,
      valor,
      callbackUrl,
      comprador: {
        firstName: user.name?.split(" ")[0] || "Participante",
        lastName: user.name?.split(" ").slice(1).join(" ") || "",
        email: user.email || "",
      },
    });

    // Salvar registro de pagamento pendente no Appwrite
    try {
      await awDatabases.createDocument(AW_DB_ID, AW_COLLECTION_BOLAO_PAGAMENTOS, referenceId, {
        bolaoId,
        usuarioId: user.$id,
        valor,
        status: "pending",
        referenceId,
        paymentUrl: cobranca.paymentUrl,
        expiresAt: cobranca.expiresAt,
      });
    } catch (err) {
      console.warn("[picpay] Falha ao salvar pagamento pendente:", err.message);
    }

    return res.json({
      referenceId,
      qrcode: cobranca.qrcode,
      paymentUrl: cobranca.paymentUrl,
      valor,
      expiresAt: cobranca.expiresAt,
    });
  } catch (err) {
    console.error("[picpay] Erro ao criar cobrança:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/pagamentos/status/:referenceId
 * Consulta status de um pagamento (polling do frontend).
 */
app.get("/api/pagamentos/status/:referenceId", requireAppwriteUser, async (req, res) => {
  const corsOrigin = resolveCorsOrigin(req);
  if (corsOrigin) res.setHeader("Access-Control-Allow-Origin", corsOrigin);

  try {
    const { referenceId } = req.params;
    const resultado = await consultarCobrancaPicPay(referenceId);
    return res.json(resultado);
  } catch (err) {
    console.error("[picpay] Erro ao consultar status:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /webhook/picpay
 * Recebe notificação de pagamento confirmado do PicPay.
 * Adiciona automaticamente o usuário como participante do bolão.
 */
app.post("/webhook/picpay", async (req, res) => {
  try {
    const { referenceId, authorizationId, cancellationId } = req.body;

    if (!referenceId) return res.status(400).json({ error: "referenceId obrigatório" });

    const isPaid = !!authorizationId && !cancellationId;
    const isCancelled = !!cancellationId;

    console.log(`[webhook/picpay] referenceId=${referenceId} paid=${isPaid} cancelled=${isCancelled}`);

    if (!awDatabases) return res.status(200).json({ ok: true, warning: "Appwrite não configurado" });

    // Buscar registro do pagamento
    let pagamento;
    try {
      pagamento = await awDatabases.getDocument(AW_DB_ID, AW_COLLECTION_BOLAO_PAGAMENTOS, referenceId);
    } catch {
      console.warn("[webhook/picpay] Pagamento não encontrado no Appwrite:", referenceId);
      return res.status(200).json({ ok: true });
    }

    if (isPaid) {
      // Atualizar status do pagamento para 'paid'
      await awDatabases.updateDocument(AW_DB_ID, AW_COLLECTION_BOLAO_PAGAMENTOS, referenceId, {
        status: "paid",
        authorizationId,
        paidAt: new Date().toISOString(),
      }).catch(() => {});

      // Adicionar participante ao bolão
      const participanteId = `${pagamento.bolaoId}_${pagamento.usuarioId}`;
      try {
        await awDatabases.createDocument(AW_DB_ID, AW_COLLECTION_PARTICIPANTES, participanteId, {
          bolaoId: pagamento.bolaoId,
          usuarioId: pagamento.usuarioId,
          role: "member",
        });
        console.log(`[webhook/picpay] Participante adicionado: ${participanteId}`);
      } catch (err) {
        // Pode já existir — não é erro crítico
        if (!err.message?.includes("409")) {
          console.error("[webhook/picpay] Erro ao adicionar participante:", err.message);
        }
      }
    } else if (isCancelled) {
      await awDatabases.updateDocument(AW_DB_ID, AW_COLLECTION_BOLAO_PAGAMENTOS, referenceId, {
        status: "cancelled",
        cancellationId,
      }).catch(() => {});
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[webhook/picpay] Erro inesperado:", err);
    return res.status(200).json({ ok: true }); // sempre 200 para o PicPay não retentar
  }
});

// CORS preflight para rotas de pagamento
app.options("/api/pagamentos/pix", (req, res) => {
  const corsOrigin = resolveCorsOrigin(req);
  if (corsOrigin) {
    res.setHeader("Access-Control-Allow-Origin", corsOrigin);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }
  res.sendStatus(204);
});

app.options("/api/pagamentos/status/:referenceId", (req, res) => {
  const corsOrigin = resolveCorsOrigin(req);
  if (corsOrigin) {
    res.setHeader("Access-Control-Allow-Origin", corsOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }
  res.sendStatus(204);
});

// ── Sandbox Test Endpoint ─────────────────────────────────────────────────────
// Disponível apenas quando PICPAY_SANDBOX=true
// Simula o webhook de pagamento aprovado para testes locais (sem ngrok)

app.post("/api/pagamentos/simular/:paymentLinkId", requireAppwriteUser, async (req, res) => {
  const corsOrigin = resolveCorsOrigin(req);
  if (corsOrigin) res.setHeader("Access-Control-Allow-Origin", corsOrigin);

  if (process.env.PICPAY_SANDBOX !== "true") {
    return res.status(403).json({ error: "Simulação disponível apenas em modo sandbox" });
  }

  const { paymentLinkId } = req.params;
  const pendente = buscarPendente(paymentLinkId);

  if (!pendente) {
    return res.status(404).json({ error: `Nenhum pagamento pendente para paymentLinkId: ${paymentLinkId}` });
  }

  // Simular payload do webhook PicPay
  const webhookPayload = {
    type: "PAYMENT",
    data: {
      transaction: {
        id: `sandbox-tx-${Date.now()}`,
        status: "PAYED",
        amount: 1000,
        paymentType: "PIX",
        originalTransactionId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      charge: {
        paymentLinkId,
        qrCode: "sandbox-qrcode",
        expiresAt: null,
        amount: 1000,
        checkoutLink: `https://link.picpay.com/p/${paymentLinkId}`,
      },
    },
    eventDate: new Date().toISOString(),
  };

  // Processar localmente (mesmo código do webhook real)
  const { bolaoId, usuarioId, usuarioNome, referenceId } = pendente;
  const participanteId = `${bolaoId}_${usuarioId}`;
  const transactionId = webhookPayload.data.transaction.id;

  console.log(`[sandbox] Simulando pagamento confirmado para bolão ${bolaoId} user ${usuarioId}`);

  if (awDatabases) {
    try {
      await awDatabases.updateDocument(AW_DB_ID, AW_COLLECTION_PARTICIPANTES, participanteId, {
        statusPagamento: "confirmado",
        transactionId,
        paymentLinkId,
        valorPago: webhookPayload.data.transaction.amount / 100,
        pagoEm: new Date().toISOString(),
      });
    } catch {
      try {
        await awDatabases.createDocument(AW_DB_ID, AW_COLLECTION_PARTICIPANTES, participanteId, {
          bolaoId,
          usuarioId,
          usuarioNome: usuarioNome || "Participante",
          statusPagamento: "confirmado",
          transactionId,
          paymentLinkId,
          valorPago: webhookPayload.data.transaction.amount / 100,
          pagoEm: new Date().toISOString(),
          role: "member",
        });
      } catch (err) {
        console.error("[sandbox] Erro ao registrar participante:", err.message);
        return res.status(500).json({ error: err.message });
      }
    }
  }

  removerPendente(paymentLinkId);
  console.log(`[sandbox] ✅ Pagamento simulado com sucesso: ${transactionId}`);

  return res.json({
    ok: true,
    sandbox: true,
    transactionId,
    bolaoId,
    usuarioId,
    message: "Pagamento simulado com sucesso — participante confirmado no Appwrite",
  });
});

app.options("/api/pagamentos/simular/:paymentLinkId", (req, res) => {
  const corsOrigin = resolveCorsOrigin(req);
  if (corsOrigin) {
    res.setHeader("Access-Control-Allow-Origin", corsOrigin);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }
  res.sendStatus(204);
});

app.listen(PORT, () => {

  console.log(`Server running on port ${PORT}`);

  // Pós-Copa / hibernação: POLL_ENABLED=false (default) evita Chromium 24/7.
  // Ligar no Coolify com POLL_ENABLED=true só quando precisar sync contínuo.
  const pollEnabled = !['0', 'false', 'off', 'no'].includes(
    String(process.env.POLL_ENABLED ?? 'false').toLowerCase(),
  );
  if (!pollEnabled) {
    console.log('[poll] hibernado (POLL_ENABLED=false) — scrape sob demanda via /ge-classificacao e /sync-appwrite');
    return;
  }

  // Initial scrape, then adaptive polling
  pollScrape().then(() => {
    pollTimer = setInterval(pollScrape, currentInterval);
  });
});
