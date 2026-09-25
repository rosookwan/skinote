// 설치한 PWA의 서비스 워커 등록(운영 빌드에서만, main.tsx). 서비스 워커는 빌드가 dist/sw.js로 쓴다(pwa/skinote-pwa.ts).
// 주소와 범위는 상대 주소('./')라 GitHub Pages의 하위 경로(/skinote/)나 매장 PC 어디에 올려도 그 폴더가 범위다.
// 등록이 안 되는 브라우저(사생활 보호 창 등)에서도 앱은 그대로 돈다(오프라인에서 열리지 않을 뿐).
//
// 새 판 바꾸기(deployment 7절 'PWA 판이 바뀌는 때'): 새 서비스 워커는 받아 둔 뒤 기다린다. 하루 종일 켜 두는 카운터는 창을 닫지
// 않아 기다리는 판이 영영 바뀌지 않으므로, 앱이 스스로 '지금 바꾸기'를 보낸다. 손을 대기 전(열고 나서 아무것도 누르지 않은 동안)
// 이거나, 05:00 ~ 06:00에 5분 넘게 손대지 않았고 열린 창(대화 상자)이 없을 때만 보낸다. 바뀌면 한 번 다시 연다.

const START_GRACE_MS = 20_000;
const IDLE_MS = 5 * 60_000;
const CHECK_EVERY_MS = 30 * 60_000;

/** 지금 바꿔도 되는가: 아직 손대지 않았거나, 새벽 5시대에 오래 손대지 않았고 열린 대화 상자가 없을 때. */
export function safeToApply(now: number, loadedAt: number, lastTouch: number | null, hour: number, dialogOpen: boolean): boolean {
  if (dialogOpen) return false;
  if (lastTouch === null) return now - loadedAt <= START_GRACE_MS || hour === 5;
  return hour === 5 && now - lastTouch >= IDLE_MS;
}

export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const loadedAt = Date.now();
  let lastTouch: number | null = null;
  let reloading = false;
  for (const type of ['pointerdown', 'keydown'] as const) {
    window.addEventListener(type, () => { lastTouch = Date.now(); }, { capture: true, passive: true });
  }
  // 새 서비스 워커가 창을 맡으면(바꾸기 끝) 한 번만 다시 연다. 처음 설치(맡던 워커가 없던 때)는 다시 열지 않는다.
  const hadController = navigator.serviceWorker.controller !== null;
  // 새 서비스 워커가 설치될 때 묻는다: 이 화면은 새 판 바꾸기를 안다(답하지 않는 옛 화면만 바로 맡음, sw.js).
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    if (event.data && event.data.type === 'skinote:ping') event.source?.postMessage({ type: 'skinote:pong' });
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    window.location.reload();
  });

  const tryApply = (reg: ServiceWorkerRegistration) => {
    const waiting = reg.waiting;
    if (!waiting || !hadController) return;
    const dialogOpen = document.querySelector('[role="dialog"], [aria-modal="true"]') !== null;
    if (safeToApply(Date.now(), loadedAt, lastTouch, new Date().getHours(), dialogOpen)) waiting.postMessage({ type: 'skinote:apply-update' });
  };

  const watch = (reg: ServiceWorkerRegistration) => {
    tryApply(reg);
    reg.addEventListener('updatefound', () => {
      const incoming = reg.installing;
      incoming?.addEventListener('statechange', () => { if (incoming.state === 'installed') tryApply(reg); });
    });
    // 오래 켜 둔 기기도 새 판을 알도록 가끔 확인하고, 기다리는 판이 있으면 바꿔도 되는 때를 본다.
    window.setInterval(() => {
      reg.update().catch(() => { /* 연결이 없으면 다음에 */ });
      tryApply(reg);
    }, CHECK_EVERY_MS);
    window.setInterval(() => tryApply(reg), 60_000);
  };

  const register = () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).then(watch, () => {
      // 등록 실패는 화면에 알리지 않는다(연결이 있는 동안은 차이가 없다).
    });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
