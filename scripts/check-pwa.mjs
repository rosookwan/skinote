// 설치한 PWA 검사: 빌드한 앱을 GitHub Pages와 같은 하위 경로(/skinote/)로 띄우고 확인한다.
//   ① manifest.webmanifest: 받아지고(형식), 이름 · 짧은 이름 스키노트, 언어 ko, standalone, 상대 주소(start_url · scope),
//      색이 디자인 토큰(--sn-desk)과 같고, 아이콘(마스크 아이콘 포함)이 모두 받아지는지
//   ② index.html의 manifest 링크 · theme-color, sw.js가 받아지고 미리 받을 목록의 파일이 모두 있는지
//   ③ 브라우저: 처음 방문에 서비스 워커가 설치 · 제어(범위 = 하위 경로)하고 목록만큼 저장하는지
//   ④ 연결을 끊고(브라우저 오프라인) 다시 열면 앱이 뜨고 묶은 글꼴도 저장본에서 오는지
//   ⑤ 서버를 아예 멈춘 뒤 새 창으로 기사 화면 주소를 열어도 뜨는지(이 스크립트가 서버를 띄웠을 때)
//   ⑥ 개발 서버(vite)에서는 서비스 워커를 등록하지 않는지
// 단위 시험에 넣지 않는다(브라우저 필요). 실행: npm run build && npm run test:pwa
//   환경 변수: SKINOTE_PWA_URL(기본 http://127.0.0.1:5182/skinote/, 없으면 vite preview --base /skinote/를 그 포트에 띄움),
//   SKINOTE_UI_OUT(찍은 화면, 기본 work/screens/step3), SKINOTE_PWA_DEV=0이면 ⑥을 건너뜀
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = new URL('../', import.meta.url);
const URL_BASE = process.env.SKINOTE_PWA_URL ?? 'http://127.0.0.1:5182/skinote/';
const OUT = new URL((process.env.SKINOTE_UI_OUT ?? 'work/screens/step3').replace(/\/?$/, '/'), ROOT);
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log((ok ? '✓ ' : '✗ ') + name + (detail ? '  ' + detail : ''));
};

// npx를 거치면 리눅스에서 kill()이 npx만 멈추고 vite는 남는다. node로 vite를 바로 띄워 멈춤을 확실히 한다.
const VITE_BIN = fileURLToPath(new URL('node_modules/vite/bin/vite.js', ROOT));
const APP_DIR = fileURLToPath(new URL('apps/pos/', ROOT));
const startVite = (args) => spawn(process.execPath, [VITE_BIN, ...args], { cwd: APP_DIR, stdio: 'ignore' });

/** 서버 프로세스를 멈추고 정말 끝날 때까지(최대 5초) 기다린다. */
async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  child.kill();
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  clearTimeout(timer);
}

async function reachable(url) {
  try { return (await fetch(url)).ok; } catch { return false; }
}

async function waitFor(url, child) {
  for (let i = 0; i < 75; i += 1) {
    if (await reachable(url)) return child;
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error('서버를 띄우지 못했다: ' + url);
}

/** 미리보기 서버(빌드한 dist)를 URL의 포트 · 하위 경로로 띄운다. 이미 떠 있으면 null. */
async function ensurePreview() {
  if (await reachable(URL_BASE)) return null;
  const url = new URL(URL_BASE);
  const child = startVite(['preview', '--port', url.port, '--strictPort', '--host', url.hostname, '--base', url.pathname]);
  return waitFor(URL_BASE, child);
}

async function devCheck(browser) {
  const devUrl = 'http://127.0.0.1:5184/';
  const child = startVite(['--port', '5184', '--strictPort', '--host', '127.0.0.1']);
  try {
    await waitFor(devUrl, child);
    const context = await browser.newContext({ viewport: { width: 1024, height: 600 } });
    const page = await context.newPage();
    await page.goto(devUrl + '#/ledger');
    await page.waitForSelector('.sn-row', { timeout: 20_000 });
    await page.waitForTimeout(1500);
    const registrations = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
    check('개발 서버에서는 서비스 워커를 등록하지 않는다', registrations === 0, '등록 ' + registrations + '개');
    await context.close();
  } finally {
    await stopServer(child);
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  let server = await ensurePreview();
  const browser = await chromium.launch();
  try {
    // ① manifest
    const manifestRes = await fetch(URL_BASE + 'manifest.webmanifest');
    const manifestType = manifestRes.headers.get('content-type') ?? '';
    check('manifest.webmanifest가 받아진다', manifestRes.ok && /manifest\+json|application\/json/.test(manifestType), manifestRes.status + ' ' + manifestType);
    const manifest = await manifestRes.json();
    const tokens = readFileSync(new URL('packages/ui/src/styles/tokens.css', ROOT), 'utf8');
    const desk = /--sn-desk:\s*(#[0-9A-Fa-f]{3,8})/.exec(tokens)?.[1];
    check('이름 · 짧은 이름 · 언어 · 표시', manifest.name === '스키노트' && manifest.short_name === '스키노트' && manifest.lang === 'ko' && manifest.display === 'standalone',
      [manifest.name, manifest.short_name, manifest.lang, manifest.display].join(' · '));
    check('주소가 상대 주소(하위 경로 범위)', manifest.start_url === './' && manifest.scope === './', 'start_url ' + manifest.start_url + ' · scope ' + manifest.scope);
    check('색이 디자인 토큰(--sn-desk)', manifest.theme_color === desk && manifest.background_color === desk, manifest.theme_color + ' · ' + manifest.background_color + ' · 토큰 ' + desk);
    check('마스크 아이콘이 있다', manifest.icons.some((i) => i.purpose === 'maskable'), manifest.icons.map((i) => i.src + ' ' + i.purpose).join(', '));
    for (const icon of manifest.icons) {
      const res = await fetch(new URL(icon.src, URL_BASE + 'manifest.webmanifest'));
      check('아이콘 ' + icon.src, res.ok && (res.headers.get('content-type') ?? '').startsWith('image/'), res.status + ' ' + res.headers.get('content-type'));
    }

    // ② index.html · sw.js
    const html = await (await fetch(URL_BASE)).text();
    check('index.html에 manifest 링크와 theme-color', html.includes('rel="manifest" href="./manifest.webmanifest"') && html.includes('name="theme-color" content="' + desk + '"'));
    const swRes = await fetch(URL_BASE + 'sw.js');
    const sw = await swRes.text();
    check('sw.js가 받아진다', swRes.ok && /javascript/.test(swRes.headers.get('content-type') ?? ''), swRes.status + ' ' + swRes.headers.get('content-type'));
    const files = JSON.parse(/const FILES = (\[[\s\S]*?\]);/.exec(sw)?.[1] ?? '[]');
    const version = /const VERSION = "([0-9a-f]+)";/.exec(sw)?.[1];
    check('미리 받을 목록: 앱 뼈대 · 스크립트 · 스타일 · 글꼴 · 아이콘', files.includes('index.html') && files.some((f) => f.endsWith('.js')) && files.some((f) => f.endsWith('.css')) && files.some((f) => f.endsWith('.woff2')) && files.includes('manifest.webmanifest'),
      '파일 ' + files.length + '개 · 판 ' + version);
    let missing = 0;
    for (const file of files) if (!(await fetch(URL_BASE + file)).ok) missing += 1;
    check('목록의 파일이 모두 받아진다', missing === 0, '빠짐 ' + missing);

    // ③ 처음 방문: 설치 · 제어 · 저장
    const context = await browser.newContext({ viewport: { width: 1024, height: 600 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(URL_BASE + '#/ledger');
    await page.waitForSelector('.sn-row');
    const sw1 = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      for (let i = 0; i < 50 && !navigator.serviceWorker.controller; i += 1) await new Promise((r) => setTimeout(r, 100));
      const keys = await caches.keys();
      const entries = keys.length ? (await (await caches.open(keys[0])).keys()).length : 0;
      return { scope: registration.scope, controlled: Boolean(navigator.serviceWorker.controller), keys, entries };
    });
    check('처음 방문에 서비스 워커가 설치되고 이 창을 제어한다', sw1.controlled, '범위 ' + sw1.scope);
    check('범위가 하위 경로', sw1.scope === URL_BASE, sw1.scope);
    // 브라우저가 푼 앱 id(설치한 앱의 정체)가 하위 경로 안인지: 사이트 뿌리로 풀리면 같은 사이트의 다른 앱과 겹친다.
    const cdp = await context.newCDPSession(page);
    const appId = await cdp.send('Page.getAppManifest').then((r) => r.manifest?.id ?? '', () => '');
    check('브라우저가 푼 앱 id가 하위 경로 안', appId.startsWith(URL_BASE), appId || '(읽지 못함)');
    await cdp.detach();
    check('저장한 파일 수가 목록과 같다', sw1.entries === files.length && sw1.keys.length === 1, sw1.keys.join(', ') + ' · ' + sw1.entries + '개');

    // ④ 브라우저 오프라인에서 다시 열기
    await context.setOffline(true);
    const fromWorker = [];
    page.on('response', (res) => { if (res.fromServiceWorker()) fromWorker.push(new URL(res.url()).pathname); });
    await page.reload();
    await page.waitForSelector('.sn-row', { timeout: 10_000 });
    await page.evaluate(() => document.fonts.ready);
    // 정말 끊겼는지: 저장본에 없는 주소를 부르면 실패해야 한다.
    const offline = await page.evaluate(async () => ({
      probe: await fetch('./__skinote_probe__?' + Date.now()).then(() => 'reached', () => 'failed'),
      rows: document.querySelectorAll('.sn-row').length,
      font: document.fonts.check('16px "Skinote Pretendard"'),
    }));
    await page.screenshot({ path: new URL('pwa-offline-ledger-1024x600.png', OUT).pathname });
    check('연결 없이 다시 열어도 장부가 뜬다', offline.probe === 'failed' && offline.rows > 0, '연결 확인 ' + offline.probe + ' · 줄 ' + offline.rows);
    check('묶은 글꼴을 저장본에서 읽는다', offline.font && fromWorker.some((p) => p.endsWith('.woff2')), fromWorker.filter((p) => /woff2|\.js|\.css|\/$/.test(p)).join(', '));
    await page.goto(URL_BASE + '#/driver/2026-12-26');
    await page.waitForSelector('.sn-row', { timeout: 10_000 });
    await page.screenshot({ path: new URL('pwa-offline-driver-1024x600.png', OUT).pathname });
    check('연결 없이 기사 화면 주소로 가도 뜬다', (await page.locator('.sn-row').count()) > 0);
    await context.setOffline(false);

    // ⑤ 서버를 멈춘 뒤 새 창(같은 브라우저 저장소)
    if (server) {
      await stopServer(server);
      server = null;
      check('서버가 멈췄다', !(await reachable(URL_BASE)));
      const phone = await context.newPage();
      await phone.setViewportSize({ width: 360, height: 640 });
      await phone.goto(URL_BASE + '#/driver/2026-12-26');
      await phone.waitForSelector('.sn-row', { timeout: 10_000 });
      await phone.evaluate(() => document.fonts.ready);
      await phone.screenshot({ path: new URL('pwa-server-stopped-driver-360x640.png', OUT).pathname });
      check('서버 없이 새 창에서 기사 휴대폰 화면이 뜬다', (await phone.locator('.sn-row').count()) > 0);
    } else {
      console.log('  (서버를 이 스크립트가 띄우지 않아 ⑤를 건너뜀)');
    }
    check('페이지 오류 없음', errors.length === 0, errors.join(' | ').slice(0, 300));
    await context.close();

    // ⑥ 개발 서버
    if (process.env.SKINOTE_PWA_DEV !== '0') await devCheck(browser);
  } finally {
    await browser.close();
    if (server) await stopServer(server);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log('\nPWA 검사 ' + results.length + '개 · 어긋남 ' + failed + '건');
  process.exitCode = failed ? 1 : 0;
}

await main();
