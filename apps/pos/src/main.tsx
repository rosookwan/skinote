// 스키노트 포스 앱의 시작점. 어느 클라이언트로 돌지는 앱 뼈대의 표시로 정한다(app/runtime.ts, 계획 work/impl-server/plan.md D7):
//   - 표시 없음(GitHub Pages · vite 개발 · 미리 보기) 또는 주소에 ?demo → 체험판: FixtureClient(브라우저 안의 체험 자료, 체험 시계 · 뒷이야기).
//   - 우리 서버가 배포하며 찍은 표시(<meta name="skinote-runtime" content="server">) → 서버 모드: 세션을 묻고, 등록 · 로그인 뒤
//     HttpClient(우리 서버의 /api/v2)로 같은 화면을 그린다. 서버에 닿지 않으면 `연결 끊김` 화면이고 체험판으로 가지 않는다.
// 두 클라이언트는 따로 묶어 받는다: 체험 자료는 운영 묶음에, 서버 몫(HttpClient · 기기 열쇠 · 등록 · 로그인)은 체험판 묶음에 들지 않는다.
import '@skinote/ui/styles.css';
import './app.css';
import { API_V2 } from '@skinote/contract';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.tsx';
import { ClientProvider } from './app/client.tsx';
import { registerServiceWorker } from './app/pwa.ts';
import { decideMode, probeSession, readRuntimeMarker } from './app/runtime.ts';
import type { FixtureStorage } from './fixture/fixture-client.ts';

function browserStorage(): FixtureStorage | null {
  try {
    const storage = window.localStorage;
    storage.getItem('skinote.probe');
    return storage;
  } catch {
    return null;
  }
}

// 설치한 PWA: 운영 빌드에서만 서비스 워커를 등록한다(개발 서버에서는 저장된 옛 파일이 섞이지 않게 하지 않는다).
if (import.meta.env.PROD) registerServiceWorker();

const root = document.getElementById('root');

function startDemo() {
  // 체험 자료(FixtureClient)는 따로 묶어 받는다: 운영의 HttpClient · LocalClient 묶음에는 들지 않는 체험판 몫이다.
  void import('./fixture/fixture-client.ts').then(({ FixtureClient }) => {
    // 뒷이야기(story): 체험 시계를 앞으로 돌리면 그 사이 다른 직원 · 기사가 한 일이 적힌다(fixture/story.ts).
    const client = new FixtureClient({ storage: browserStorage(), listenToOtherTabs: true, story: true });
    // 체험 시계는 페이지가 닫혀 있는 동안 멈춘다: 떠날 때 지금 시각을 남긴다.
    window.addEventListener('pagehide', () => client.persist());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') client.persist(); });
    if (root) {
      createRoot(root).render(
        <StrictMode>
          <ClientProvider client={client}>
            <App />
          </ClientProvider>
        </StrictMode>,
      );
    }
  });
}

const baseUrl = document.baseURI;
void decideMode({
  marker: readRuntimeMarker(document),
  search: window.location.search,
  probe: () => probeSession((input, init) => window.fetch(input, init), new URL(API_V2.session, baseUrl).href),
}).then((mode) => {
  if (mode.mode === 'demo') {
    startDemo();
    return;
  }
  void import('./app/session.tsx').then(({ ServerApp }) => {
    if (!root) return;
    createRoot(root).render(
      <StrictMode>
        <ServerApp initial={mode} baseUrl={baseUrl} origin={window.location.origin} />
      </StrictMode>,
    );
  });
});
