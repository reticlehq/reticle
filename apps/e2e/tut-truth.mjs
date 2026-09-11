import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage();
const dels = [];
p.on('request', r => { if (r.method() === 'DELETE') dels.push(r.url()); });
await p.goto('http://localhost:4395/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await p.waitForTimeout(3000);
await p.locator('input[name=username], input#username').first().fill('login');
await p.locator('input[name=password], input#password').first().fill('password');
await p.getByRole('button', { name: /sign in/i }).click();
await p.waitForTimeout(6000);
const t = await p.evaluate(() => document.body.innerText);
console.log('after login CHARS:', t.length, '|', JSON.stringify(t.slice(0,120)));
await p.getByRole('menuitem', { name: /posts/i }).first().click().catch(async () => {
  await p.getByRole('link', { name: /posts/i }).first().click();
});
await p.waitForTimeout(6000);
console.log('on posts:', JSON.stringify((await p.evaluate(() => document.body.innerText)).slice(0,120)));
const boxes = p.locator('input[type=checkbox]');
console.log('checkboxes:', await boxes.count());
if (await boxes.count() > 1) {
  await boxes.nth(1).click({ force: true });
  await p.waitForTimeout(800);
  const del = p.getByRole('button', { name: /delete/i }).first();
  await del.click({ force: true });
  await p.waitForTimeout(10000);
}
console.log('DELETE count:', dels.length);
console.log('urls:', dels.join(' | '));
await b.close();
