import "dotenv/config";
import express from "express";
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Client, Databases, ID, Query } from "node-appwrite";

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
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  if (req.method === "OPTIONS") return res.sendStatus(204);
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
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

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
            
            const link = jogo.querySelector("a.jogo__transmissao--link, a.placar-jogo-link");
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
              href: link?.href || null,
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
}

// ── HTML template ─────────────────────────────────────────────────

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

app.post("/sync-appwrite", async (req, res) => {
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
    match = partidas.find(p => p.id === matchId && p.status === "ao-vivo");
  } else if (time1 && time2) {
    match = partidas.find(p => p.time1 === time1 && p.time2 === time2 && p.status === "ao-vivo" && (!fase || p.fase === fase));
  }
  if (!match) {
    return res.status(404).json({ error: "Match not found or not live" });
  }
  // Build href from match data if missing
  if (!match.href) {
    const base = "https://ge.globo.com/futebol/copa-do-mundo/jogo";
    let datePart = "";
    if (match.data) {
      const d = new Date(match.data);
      if (!isNaN(d.getTime())) {
        datePart = `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
      }
    }
    const name1 = (match.time1 || match.sigla1 || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const name2 = (match.time2 || match.sigla2 || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
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
    return res.status(504).json({ error: "Dados indisponíveis no momento" });
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
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url.includes("doubleclick") || url.includes("googleads") || url.includes("pubmatic") ||
          url.includes("criteo") || url.includes("rubicon") || url.includes("adsrvr") ||
          url.includes("adnami") || url.includes("temu") || url.includes("rlcdn") ||
          url.includes("id5-sync") || url.includes("permutive") || url.includes("thesports01") ||
          url.includes("sentry") || url.includes("analytics") || url.includes("imasdk") ||
          url.includes("datadome") || url.includes("smartadserver") || url.includes("prebid")) {
        return route.abort();
      }
      return route.continue();
    });

    await page.goto(match.href, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(10000);

    const events = await page.evaluate(() => {
      const items = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
      const eventLabels = ["GOL", "Cartão amarelo", "Cartão vermelho", "GOL CONTRA", "PÊNALTI PERDIDO", "PÊNALTI"];
      while (walker.nextNode()) {
        const text = walker.currentNode.textContent.trim();
        if (eventLabels.includes(text)) {
          const span = walker.currentNode.parentElement;
          if (!span) continue;
          let container = span.closest("div");
          if (!container) continue;
          for (let i = 0; i < 5 && container; i++) {
            const allText = container.textContent || "";
            const lines = allText.split("\n").map((l) => l.trim()).filter(Boolean);
            if (lines.length >= 2) {
              const minute = lines.find((l) => /^\d+'/.test(l) || /^\d+:\d+/.test(l)) || null;
              const descLines = lines.filter((l) => l !== text && !/^\d+'/.test(l) && !/^\d+:\d+/.test(l) && l.length > 10);
              const description = descLines[0] || allText.substring(0, 200).trim();
              items.push({ type: text, minute, description });
              break;
            }
            container = container.parentElement;
          }
        }
      }
      return items;
    });

    const statistics = await page.evaluate(() => {
      const container = document.getElementById("enrichment-tab-estatisticas");
      if (!container) return null;

      const rawText = container.innerText || container.textContent || "";
      const lines = rawText.split("\n").map((l) => l.trim()).filter(Boolean);

      const findVal = (label) => {
        const idx = lines.findIndex((l) => l.includes(label));
        if (idx === -1) return null;
        const vals = lines.slice(idx, idx + 3).filter((l) => /^\d+$/.test(l.replace(/\D/g, "") && l.length < 5));
        return vals.length >= 2 ? `${vals[0]} / ${vals[1]}` : vals[0] || null;
      };

      return {
        possession: findVal("Posse de bola") || findVal("Posse"),
        shots: findVal("Finaliza") || findVal("Finalizações"),
        yellowCards: findVal("Cartão amarelo") || findVal("Amarelo"),
        redCards: findVal("Cartão vermelho") || findVal("Vermelho"),
        corners: findVal("Escanteios") || findVal("Escanteio"),
      };
    });

    const score =
      match.placar1 != null && match.placar2 != null
        ? `${match.placar1} x ${match.placar2}`
        : null;

    const result = { matchId: match.id, score, status: match.status, events, statistics };
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);

  // Initial scrape, then adaptive polling
  pollScrape().then(() => {
    pollTimer = setInterval(pollScrape, currentInterval);
  });
});
