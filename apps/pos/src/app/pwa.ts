// 설치한 PWA의 서비스 워커 등록(운영 빌드에서만, main.tsx). 서비스 워커는 빌드가 dist/sw.js로 쓴다(pwa/skinote-pwa.ts).
// 주소와 범위는 상대 주소('./')라 GitHub Pages의 하위 경로(/skinote/)나 매장 PC 어디에 올려도 그 폴더가 범위다.
// 등록이 안 되는 브라우저(사생활 보호 창 등)에서도 앱은 그대로 돈다(오프라인에서 열리지 않을 뿐).
export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const register = () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {
      // 등록 실패는 화면에 알리지 않는다(연결이 있는 동안은 차이가 없다).
    });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
