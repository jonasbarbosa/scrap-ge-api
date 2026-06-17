import express from "express";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.json({ status: "ok", endpoint: "GET /ge-classificacao" });
});

app.get("/ge-classificacao", async (req, res) => {
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
          const pts = row.querySelector(
            ".classificacao__equipes--variacao span"
          )?.textContent?.trim();

          const statRow = statRows[idx + 1];
          let stats = null;
          if (statRow) {
            const cells = statRow.querySelectorAll("td");
            stats = {
              pts: cells[0]?.textContent?.trim(),
              jogos: cells[1]?.textContent?.trim(),
              vitorias: cells[2]?.textContent?.trim(),
              empates: cells[3]?.textContent?.trim(),
              derrotas: cells[4]?.textContent?.trim(),
              golsPro: cells[5]?.textContent?.trim(),
              golsContra: cells[6]?.textContent?.trim(),
              saldoGols: cells[7]?.textContent?.trim(),
              aproveitamento: cells[8]?.textContent?.trim(),
            };
          }

          return {
            pos: pos ? parseInt(pos) : null,
            nome: nome || null,
            sigla: sigla || null,
            pts: pts ? parseInt(pts) : null,
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

    res.json({
      url: "https://ge.globo.com/futebol/copa-do-mundo/",
      totalGrupos: grupos.length,
      grupos,
      artilharia: { top5: artilharia },
    });
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
