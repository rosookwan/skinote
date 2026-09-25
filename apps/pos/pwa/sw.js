/* 스키노트 서비스 워커. 빌드할 때 skinote-pwa 플러그인(pwa/skinote-pwa.ts)이 판 번호와 미리 받을 파일 목록을 채워 dist/sw.js로 쓴다.
 *
 * - 설치: 앱 뼈대(index.html) · 스크립트 · 스타일 · 묶은 글꼴(Pretendard) · 아이콘 · manifest를 한 번에 받아 둔다.
 *   주소는 모두 이 파일 자리 기준의 상대 주소라 GitHub Pages 하위 경로(/skinote/)에서도 그 폴더가 범위다.
 * - 가져오기: 범위 안의 GET만. 화면 열기(navigate)는 받아 둔 앱 뼈대를, 나머지는 받아 둔 파일을 먼저 쓰고 없으면 네트워크.
 *   그래서 한 번 연 뒤에는 연결이 없어도 앱이 열린다(자료는 FixtureClient가 브라우저 저장소에 둔다).
 * - 새 판: 새 서비스 워커는 받아 둔 뒤 기다리고(열린 창이 모두 닫히면 바뀐다), 옛 판의 저장은 바뀔 때 지운다.
 *   앱이 '지금 바꾸기'를 보내면({ type: 'skinote:apply-update' }) 바로 바꾼다(열린 창이 없고 보냄 대기가 0일 때만 보내기로, ui 7절).
 * - 서버 API(범위 안의 api/ 아래, 계획 work/impl-server/plan.md 6-5)는 건드리지 않는다: 저장하지도 감싸지도 않는다(세션 · 조회는 늘
 *   서버에서, 알림 연결(SSE)은 서비스 워커를 거치지 않고 바로).
 */
const VERSION = '__SKINOTE_VERSION__';
const FILES = __SKINOTE_FILES__;
const PREFIX = 'skinote-app-';
const CACHE = PREFIX + VERSION;

const here = (path) => new URL(path, self.location.href).href;
const SHELL = here('index.html');

// 열린 화면이 새 판 바꾸기를 아는가(앱의 pwa.ts가 'skinote:pong'으로 답함). 답하지 않는 화면은 스스로 바꾸지 못하는 옛 판이다.
async function legacyClientOpen() {
  const windows = await self.clients.matchAll({ type: 'window' });
  if (!windows.length) return false;
  const answered = new Set();
  const listen = (event) => { if (event.data && event.data.type === 'skinote:pong' && event.source) answered.add(event.source.id); };
  self.addEventListener('message', listen);
  for (const client of windows) client.postMessage({ type: 'skinote:ping' });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  self.removeEventListener('message', listen);
  return windows.some((client) => !answered.has(client.id));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // HTTP 저장을 건너뛰고 새로 받는다(같은 이름의 옛 파일이 섞이지 않게).
    await cache.addAll(FILES.map((file) => new Request(here(file), { cache: 'reload' })));
    // 스스로 바꾸지 못하는 옛 판 화면이 열려 있으면 기다리지 않고 바로 맡는다(그 화면은 다음 새로 고침에 새 판).
    // 새 판 화면끼리는 기다렸다가 앱이 쉬는 때에 '지금 바꾸기'를 보낸다(pwa.ts).
    if (await legacyClientOpen()) self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
    }
    // 처음 설치한 뒤 새로 고치지 않아도 지금 열린 창이 이 서비스 워커를 쓴다(한 번 연 뒤 오프라인에서 열림).
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'skinote:apply-update') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const scope = self.registration.scope;
  if (url.origin !== self.location.origin || !url.href.startsWith(scope)) return;
  if (url.pathname.startsWith(new URL('api/', scope).pathname)) return;
  const bare = url.origin + url.pathname;
  const shell = request.mode === 'navigate' && (bare === scope || bare === SHELL);
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // ignoreVary: 모듈 스크립트 · 스타일은 crossorigin 요청이라 Origin 머리가 붙는다. 서버가 'Vary: Origin'을 보내면
    // 설치 때 저장한 응답(Origin 없음)과 맞지 않으므로 Vary를 보지 않는다(같은 곳의 같은 파일이다).
    const hit = await cache.match(shell ? SHELL : request, { ignoreSearch: true, ignoreVary: true });
    if (hit) return hit;
    try {
      return await fetch(request);
    } catch (error) {
      // 연결이 없고 받아 둔 것도 없을 때: 화면 열기라면 앱 뼈대로(경로는 주소의 # 뒤라 뼈대가 알아서 그린다).
      if (request.mode === 'navigate') {
        const fallback = await cache.match(SHELL, { ignoreVary: true });
        if (fallback) return fallback;
      }
      throw error;
    }
  })());
});
