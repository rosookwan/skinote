// 스키노트 포스 앱의 시작점. 체험판은 서버 대신 FixtureClient(브라우저 안의 체험 자료)를 쓴다.
// 운영에서는 같은 자리에 HttpClient(매장 PC 서버 /api/v2) 또는 LocalClient가 들어간다(ui 7절).
import '@skinote/ui/styles.css';
import './app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.tsx';
import { ClientProvider } from './app/client.tsx';
import { registerServiceWorker } from './app/pwa.ts';
import { FixtureClient, type FixtureStorage } from './fixture/fixture-client.ts';

function browserStorage(): FixtureStorage | null {
  try {
    const storage = window.localStorage;
    storage.getItem('skinote.probe');
    return storage;
  } catch {
    return null;
  }
}

const client = new FixtureClient({ storage: browserStorage(), listenToOtherTabs: true });
// 체험 시계는 페이지가 닫혀 있는 동안 멈춘다: 떠날 때 지금 시각을 남긴다.
window.addEventListener('pagehide', () => client.persist());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') client.persist(); });

// 설치한 PWA: 운영 빌드에서만 서비스 워커를 등록한다(개발 서버에서는 저장된 옛 파일이 섞이지 않게 하지 않는다).
if (import.meta.env.PROD) registerServiceWorker();

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ClientProvider client={client}>
        <App />
      </ClientProvider>
    </StrictMode>,
  );
}
