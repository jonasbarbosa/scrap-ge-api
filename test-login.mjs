import { chromium } from 'playwright';

const EMAIL = process.argv[2] || 'jonasqant@gmail.com';
const PASSWORD = process.argv[3] || 'h45qrsh45qrs';

async function test() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  await page.goto('https://ge.globo.com/futebol/copa-do-mundo/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Check login form structure
  const loginHtml = await page.evaluate(() => {
    const allEls = document.querySelectorAll('button, a, [class*=entrar], [class*=login]');
    let loginBtn = null;
    allEls.forEach(el => {
      if (el.textContent?.toLowerCase().includes('entrar')) loginBtn = el;
    });
    const inputs = document.querySelectorAll('input[type=email], input[name*=email], input[id*=email], input[type=password], input[name*=password]');
    const forms = document.querySelectorAll('form');
    return {
      loginBtn: loginBtn?.outerHTML?.substring(0, 300) || null,
      inputCount: inputs.length,
      inputs: Array.from(inputs).slice(0, 5).map(i => ({ name: i.name, id: i.id, type: i.type, placeholder: i.placeholder })),
      forms: Array.from(forms).slice(0, 3).map(f => ({ id: f.id, action: f.action?.substring(0, 100) })),
      bodyPreview: document.body?.innerText?.substring(0, 500),
    };
  });
  console.log('Login page structure:');
  console.log(JSON.stringify(loginHtml, null, 2));
  console.log('\n---\n');

  // Try to click login button using Playwright locator
  let clicked = false;
  const loginBtn = page.locator('button, a, [class*=entrar]').filter({ hasText: 'Entrar' }).first();
  if (await loginBtn.count() > 0) {
    console.log('Clicking login button');
    await loginBtn.click();
    clicked = true;
  }

  if (!clicked) {
    // Try evaluating directly
    clicked = await page.evaluate(() => {
      const all = document.querySelectorAll('button, a, [class*=entrar]');
      for (const el of all) {
        if (el.textContent?.toLowerCase().includes('entrar')) {
          el.click();
          return true;
        }
      }
      return false;
    });
    console.log('Click via evaluate:', clicked);
  }

  await page.waitForTimeout(3000);

  // Check what appeared
  const afterClick = await page.evaluate(() => {
    const inputs = document.querySelectorAll('input[type=email], input[name*=email], input[type=text]');
    const iframes = document.querySelectorAll('iframe').length;
    return {
      inputs: Array.from(inputs).slice(0, 5).map(i => ({ name: i.name, id: i.id, type: i.type, placeholder: i.placeholder, className: i.className?.substring(0, 80) })),
      iframeCount: iframes,
      bodyPreview: document.body?.innerText?.substring(0, 300),
    };
  });
  console.log('\nAfter click:');
  console.log(JSON.stringify(afterClick, null, 2));

  await browser.close();
}
test().catch(e => { console.error('Error:', e.message); process.exit(1); });