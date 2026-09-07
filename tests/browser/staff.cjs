const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../src/prsystem/static');
const secret = 'a'.repeat(32) + '.' + 'b'.repeat(64);
(async () => {
  const server = http.createServer((req, res) => {
    const file = req.url.includes('/assets/') ? path.basename(req.url) : 'staff.html';
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(path.join(root, file)));
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage();
    const origin = `http://127.0.0.1:${server.address().port}`;
    let requests = [];
    let status = 200, code = {}, delay = false;
    await page.route('**/auth/**', async route => {
      requests.push({url: route.request().url(), body: route.request().postDataJSON()});
      if (delay) await new Promise(r => setTimeout(r, 200));
      await route.fulfill({status, contentType: 'application/json', body: status === 204 ? '' : JSON.stringify(code)});
    });
    for (const [name, endpoint] of [['accept', '/auth/invitations/accept'], ['restaurant-accept', '/auth/restaurants/invitations/accept'], ['reset', '/auth/password/reset/complete']]) {
      status = name === 'reset' ? 204 : 200;
      await page.goto(`${origin}/staff/${name}#token=${secret}`);
      assert.equal(new URL(page.url()).hash, '');
      assert.equal(await page.locator('html').getAttribute('lang'), 'mn');
      await page.locator('#submit').click();
      assert.equal(await page.locator('#password').getAttribute('aria-invalid'), 'true');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'password');
      await page.getByLabel(name === 'reset' ? 'Шинэ нууц үг' : 'Одоогийн нууц үг', {exact:true}).fill('Password for test 2026!');
      await page.locator('#reveal').click();
      assert.equal(await page.locator('#password').getAttribute('type'), 'text');
      await page.locator('#reveal').press('Space');
      assert.equal(await page.locator('#password').getAttribute('type'), 'password');
      const before = requests.length;
      delay = true;
      await page.locator('#submit').click();
      await page.evaluate(() => document.querySelector('form').dispatchEvent(new Event('submit', {cancelable:true})));
      await page.locator('#form').waitFor({state:'hidden'});
      assert.equal(requests.length, before + 1);
      assert.equal(requests.at(-1).url, origin + endpoint);
      assert.equal(requests.at(-1).body.token, secret);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'feedback');
      assert.equal(await page.locator('#password').inputValue(), '');
      assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    }
    status = 401; code = {code:'INVALID_CREDENTIALS'}; delay = false;
    await page.goto(`${origin}/staff/accept#token=${secret}`);
    await page.locator('#password').fill('bad');
    await page.locator('#submit').click();
    await page.waitForFunction(() => document.querySelector('#feedback').dataset.error === 'true');
    assert.equal(await page.locator('#password').inputValue(), '');
    status = 200; code = {};
    await page.locator('input[value=new]').check();
    assert.equal(await page.locator('#password').getAttribute('autocomplete'), 'new-password');
    await page.locator('#password').fill('short');
    await page.locator('#submit').click();
    assert.match(await page.locator('#field-error').textContent(), /12–128/);
    await page.setViewportSize({width:320, height:560});
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.documentElement).scrollbarColor), 'auto');
    fs.mkdirSync(path.resolve(__dirname, '../../artifacts'), {recursive:true});
    await page.screenshot({path:path.resolve(__dirname, '../../artifacts/staff-mobile.png'), fullPage:true});
    status = 400; code = {code:'INVALID_LINK'};
    await page.locator('#password').fill('Valid password 2026!');
    await page.locator('#submit').click();
    await page.locator('#form').waitFor({state:'hidden'});
    assert.match(await page.locator('#feedback').textContent(), /Холбоос хүчингүй/);
    await page.goto(`${origin}/staff/reset`);
    assert.equal(await page.locator('#form').isVisible(), false);
    assert.match(await page.title(), /Холбоос буруу/);
    console.log('Browser: 3 purpose routes, 204 success, duplicate guard, password reveal, validation/focus, retry, invalid links, mn, 320px, reduced motion and storage isolation OK');
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exit(1); });
