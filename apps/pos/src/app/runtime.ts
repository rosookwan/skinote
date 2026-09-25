// 어느 클라이언트로 돌지(계획 work/impl-server/plan.md D7 · 6-1). 앱은 주소(호스트 이름)나 물어본 답으로 짐작하지 않는다:
//   - 앱 뼈대(index.html)에 서버 표시 `<meta name="skinote-runtime" content="server">`가 없음 → 체험판, 서버에 묻지 않는다
//     (GitHub Pages · vite 개발 · 미리 보기 · PWA 검사 · 규칙 검사기). ?demo는 여기서만 뜻이 있다(표시가 없으니 어차피 체험판).
//   - 표시가 있음(우리 서버가 배포하며 찍은 index.html) → 서버 모드, 늘. ?demo도 무시한다: 우리 주소의 ?demo 링크 · 즐겨찾기 · 설치한
//     앱이 직원을 그 기기 안의 가짜 장부로 보내 진짜 대여 · 돈을 적게 되지 않게. GET api/v2/session이 200이면 로그인한 세션, 401이면
//     등록 · 로그인 화면, 그 밖(404 = API 끔 · 옛 판, 5xx, JSON 아님, 시간 초과, 연결 없음)은 `연결 끊김` 화면이고 저절로 다시 묻는다.
//     우리 호스트에서는 절대 체험판으로 가지 않는다.
// 순수 모듈이다(문서 · fetch는 부르는 쪽이 넘긴다): 시험이 표를 그대로 본다.
import type { SessionInfo } from '@skinote/contract';

export const RUNTIME_META = 'skinote-runtime';
export const RUNTIME_SERVER = 'server';

export type RuntimeMode =
  | { mode: 'demo' }
  | { mode: 'server'; session: SessionInfo | null }
  | { mode: 'server-offline' };

/** 세션 묻기의 답: 200 SessionInfo, 401 로그아웃 상태, 그 밖은 연결 안 됨(offline). */
export type SessionProbe = { kind: 'session'; session: SessionInfo } | { kind: 'signed_out'; code: string } | { kind: 'offline' };

/** 주소의 ?demo(값은 보지 않는다: ?demo · ?demo=1 모두). */
export function wantsDemo(search: string): boolean {
  return new URLSearchParams(search).has('demo');
}

/** 앱 뼈대의 표시(document.querySelector('meta[name="skinote-runtime"]')의 content). */
export function readRuntimeMarker(doc: Pick<Document, 'querySelector'> | undefined): string | null {
  const meta = doc?.querySelector('meta[name="' + RUNTIME_META + '"]');
  const content = meta?.getAttribute('content');
  return typeof content === 'string' ? content : null;
}

/**
 * 모드 고르기(D7 표). probe는 표시가 서버일 때만 부른다(체험판은 서버에 묻지 않는다). probe가 던지면 연결 안 됨이다.
 */
export async function decideMode({ marker, search, probe }: { marker: string | null; search: string; probe: () => Promise<SessionProbe> }): Promise<RuntimeMode> {
  // 표시가 없으면 체험판(?demo든 아니든). 표시가 있으면 ?demo여도 서버 모드다(위 설명): search는 보지 않는다.
  void search;
  if (marker !== RUNTIME_SERVER) return { mode: 'demo' };
  let answer: SessionProbe;
  try {
    answer = await probe();
  } catch {
    return { mode: 'server-offline' };
  }
  if (answer.kind === 'session') return { mode: 'server', session: answer.session };
  if (answer.kind === 'signed_out') return { mode: 'server', session: null };
  return { mode: 'server-offline' };
}

/** 세션 답의 모양이 맞는지(서버의 SessionInfo: 직원 · 기기 · csrf). 다른 것(옛 판의 답, 앞단의 오류 쪽)은 연결 안 됨으로 본다. */
export function isSessionInfo(value: unknown): value is SessionInfo {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const staff = v.staff as Record<string, unknown> | undefined;
  const device = v.device as Record<string, unknown> | undefined;
  const shop = v.shop as Record<string, unknown> | undefined;
  return typeof v.csrf === 'string' && v.csrf.length > 0
    && !!staff && typeof staff.id === 'string' && typeof staff.name === 'string' && typeof staff.roleKey === 'string'
    && !!device && typeof device.id === 'string' && (device.kind === 'pos' || device.kind === 'driver_tablet' || device.kind === 'driver_phone')
    && !!shop && typeof shop.name === 'string';
}

/**
 * GET api/v2/session 한 번(10초). 200 + SessionInfo → session, 401 + 우리 서버의 JSON → signed_out(code: SIGNED_OUT ·
 * SESSION_EXPIRED · DEVICE_REVOKED), 그 밖은 offline. 쿠키는 같은 곳이라 붙는다(credentials same-origin).
 */
export async function probeSession(fetchImpl: typeof fetch, url: string, timeoutMs = 10_000): Promise<SessionProbe> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' }, signal: abort.signal });
    const type = res.headers.get('content-type') ?? '';
    if (!/application\/json/.test(type)) return { kind: 'offline' };
    const body: unknown = await res.json().catch(() => null);
    const service = body && typeof body === 'object' ? (body as { service?: unknown }).service : undefined;
    if (res.status === 200 && isSessionInfo(body)) return { kind: 'session', session: body };
    if (res.status === 401 && service === 'skinote') {
      const code = (body as { code?: unknown }).code;
      return { kind: 'signed_out', code: typeof code === 'string' ? code : 'SIGNED_OUT' };
    }
    return { kind: 'offline' };
  } catch {
    return { kind: 'offline' };
  } finally {
    clearTimeout(timer);
  }
}
