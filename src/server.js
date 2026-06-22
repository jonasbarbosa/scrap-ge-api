import express from "express";
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_TTL = 5 * 60 * 1000;
const DATA_DIR = join(__dirname, "..", "data");
const PARTIDAS_FILE = join(DATA_DIR, "partidas.json");

let cache = { data: null, timestamp: 0 };

// ── CORS & Cache headers ─────────────────────────────────────────

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
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

// ── Match merging ─────────────────────────────────────────────────

function mergePartidas(existing, scraped) {
  const map = new Map(existing.map((p) => [p.id, p]));

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
    await page.goto("https://ge.globo.com/futebol/copa-do-mundo/", {
      waitUntil: "load",
      timeout: 30000,
    });
    await page.waitForTimeout(5000);

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

    // Extract group names in order for section→group mapping
    const grupoNames = grupos.map((g) => g.grupo);

    const jogosRaw = await page.evaluate((grupoNames) => {
      const sections = document.querySelectorAll(".tabela__lista-jogos");
      const allJogos = [];
      const seen = new Set();

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
          if (seen.has(key)) return;
          seen.add(key);

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

          // Detect status from broadcast label
          const broadcast = link
            ?.querySelector(".jogo__transmissao--broadcast")
            ?.textContent?.trim()
            ?.toLowerCase();
          let status = "agendado";
          if (broadcast?.includes("tempo real")) {
            status = "ao-vivo";
          } else if (broadcast?.includes("saiba como foi")) {
            status = "finalizado";
          }

          allJogos.push({
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
          });
        });
      });

      return allJogos;
    }, grupoNames);

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
        let dtStr='—';
        if(j.data){
          const d2=new Date(j.data);
          dtStr=d2.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'})+' '+d2.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
        }else if(j.hora){
          dtStr=(j.dataLabel||'')+' '+j.hora;
        }
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

// ── Routes ────────────────────────────────────────────────────────

app.get("/", (req, res) => {
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
      data: { ...cache.data, grupos, updatedAt: new Date().toISOString() },
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

// ── Start ─────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
