import { chromium } from 'playwright';

async function test() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' });
  await page.goto('https://ge.globo.com/futebol/copa-do-mundo/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  const data = await page.evaluate(() => {
    const sections = document.querySelectorAll('.tabela__lista-jogos');
    return Array.from(sections).map((s, i) => {
      const rodada = s.querySelector('.lista-jogos__navegacao--rodada')?.textContent?.trim();
      const jogos = Array.from(s.querySelectorAll('.placar')).map(p => {
        const golsM = p.querySelector('.placar-box__valor--mandante')?.textContent?.trim();
        const golsV = p.querySelector('.placar-box__valor--visitante')?.textContent?.trim();
        const mn = p.querySelector('.placar__equipes--mandante .equipes__nome')?.textContent?.trim();
        const vn = p.querySelector('.placar__equipes--visitante .equipes__nome')?.textContent?.trim();
        return { time1: mn, time2: vn, placar1: golsM, placar2: golsV };
      });
      const comPlacar = jogos.filter(j => j.placar1).length;
      return { secao: i, rodada, total: jogos.length, comPlacar, jogos };
    });
  });

  console.log('=== PÁGINA INICIAL (default round) ===');
  data.forEach(d => {
    console.log(`${d.rodada}: ${d.total} jogos, ${d.comPlacar} com placar`);
    d.jogos.filter(j => !j.placar1).forEach(j => console.log('   SEM:', j.time1, 'x', j.time2));
  });

  let clicked = true;
  let attempts = 0;
  while (clicked && attempts < 10) {
    clicked = await page.evaluate(() => {
      const arrows = document.querySelectorAll('.lista-jogos__navegacao--seta-esquerda');
      let did = false;
      arrows.forEach(a => { if (a.classList.contains('lista-jogos__navegacao--setas-ativa')) { a.click(); did = true; } });
      return did;
    });
    if (clicked) { await page.waitForTimeout(1000); attempts++; }
  }
  console.log('\n=== APÓS NAVEGAR PARA TRÁS (attempts: ' + attempts + ') ===');
  await page.waitForTimeout(1000);

  const r1 = await page.evaluate(() => {
    const sections = document.querySelectorAll('.tabela__lista-jogos');
    return Array.from(sections).map((s, i) => {
      const rodada = s.querySelector('.lista-jogos__navegacao--rodada')?.textContent?.trim();
      const jogos = Array.from(s.querySelectorAll('.placar')).map(p => ({
        t1: p.querySelector('.placar__equipes--mandante .equipes__nome')?.textContent?.trim(),
        t2: p.querySelector('.placar__equipes--visitante .equipes__nome')?.textContent?.trim(),
        g1: p.querySelector('.placar-box__valor--mandante')?.textContent?.trim(),
        g2: p.querySelector('.placar-box__valor--visitante')?.textContent?.trim(),
      }));
      const comPlacar = jogos.filter(j => j.g1).length;
      return { rodada, total: jogos.length, comPlacar, jogos };
    });
  });
  r1.forEach(d => console.log(`${d.rodada}: ${d.total} jogos, ${d.comPlacar} com placar`));

  // Now navigate forward - should go through round 2 and 3
  for (let step = 0; step < 5; step++) {
    const hasNext = await page.evaluate(() => {
      const arrows = document.querySelectorAll('.lista-jogos__navegacao--seta-direita');
      let did = false;
      arrows.forEach(a => { if (a.classList.contains('lista-jogos__navegacao--setas-ativa')) { a.click(); did = true; } });
      return did;
    });
    if (!hasNext) { console.log('Sem mais setas direita após step', step); break; }
    await page.waitForTimeout(1000);

    const rd = await page.evaluate(() => {
      const sections = document.querySelectorAll('.tabela__lista-jogos');
      return Array.from(sections).map((s, i) => {
        const rodada = s.querySelector('.lista-jogos__navegacao--rodada')?.textContent?.trim();
        const jogos = Array.from(s.querySelectorAll('.placar')).map(p => ({
          t1: p.querySelector('.placar__equipes--mandante .equipes__nome')?.textContent?.trim(),
          t2: p.querySelector('.placar__equipes--visitante .equipes__nome')?.textContent?.trim(),
          g1: p.querySelector('.placar-box__valor--mandante')?.textContent?.trim(),
          g2: p.querySelector('.placar-box__valor--visitante')?.textContent?.trim(),
        }));
        const comPlacar = jogos.filter(j => j.g1).length;
        return { rodada, total: jogos.length, comPlacar };
      });
    });
    rd.forEach(d => console.log(`Step ${step+1} -> ${d.rodada}: ${d.total} jogos, ${d.comPlacar} com placar`));
  }

  await browser.close();
}
test().catch(e => { console.error(e); process.exit(1); });
