import express from "express";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_TTL = 5 * 60 * 1000;
let cache = { data: null, timestamp: 0 };

app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Copa do Mundo 2026 — Classificação</title>
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
</style>
</head>
<body>
<h1>⚽ Copa do Mundo 2026</h1>
<p class="sub" id="subtitle">Carregando...</p>
<div id="app" class="loading">Buscando dados do GE...</div>
<script>
async function init(){
  try{
    const r=await fetch('/ge-classificacao');
    const d=await r.json();
    const sub=document.getElementById('subtitle');
    const dt=new Date(d.updatedAt);
    sub.textContent='Atualizado em '+dt.toLocaleString('pt-BR')+' · Dados do ge.globo';
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
    html+='<div class="artilharia-wrap"><h2>⚡ Artilharia — Top 5</h2>';
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
</html>`);
});

app.get("/ge-classificacao", async (req, res) => {
  const now = Date.now();
  if (cache.data && now - cache.timestamp < CACHE_TTL) {
    return res.json(cache.data);
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
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
        const statRows = statsTable
          ? statsTable.querySelectorAll("tr")
          : [];

        const times = Array.from(teamRows).map((row, idx) => {
          const pos = row.querySelector(".classificacao__equipes--posicao")
            ?.textContent?.trim();
          const nome = row.querySelector(".classificacao__equipes--nome")
            ?.textContent?.trim();
          const sigla = row.querySelector(".classificacao__equipes--sigla")
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

          return {
            pos: pos ? parseInt(pos) : null,
            nome: nome || null,
            sigla: sigla || null,
            pts,
            stats,
          };
        }).filter((t) => t.nome);

        return { grupo, times };
      });
    });

    const artilharia = await page.evaluate(() => {
      const items = document.querySelectorAll(".ranking-item-wrapper");
      return Array.from(items).slice(0, 5).map((item) => {
        const pos = item.querySelector(".ranking-item")?.textContent?.trim();
        const nome = item.querySelector(".jogador-nome")?.textContent?.trim();
        const posicao = item.querySelector(".jogador-posicao")?.textContent?.trim();
        const gols = item.querySelector(".jogador-gols")?.textContent?.trim();
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

    await browser.close();
    browser = null;

    const result = {
      url: "https://ge.globo.com/futebol/copa-do-mundo/",
      updatedAt: new Date().toISOString(),
      totalGrupos: grupos.length,
      grupos,
      artilharia: { top5: artilharia },
    };

    cache = { data: result, timestamp: Date.now() };
    res.json(result);
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({
      error: "Failed to fetch classification",
      detail: err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
