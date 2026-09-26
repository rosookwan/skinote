// 체험판 전용 미리 보기 경로(계획 work/impl-server/plan.md 6-3, 어디에도 연결하지 않은 주소). 아직 화면이 없는 곳의 부품을 규칙 검사기가
// 기기 크기마다 재도록 그린다. #/preview/keyboard: 화면 키보드(글자 입력 판, 40자). 기사 화면에는 아직 글자 칸이 없어 휴대폰(360×640) ·
// 기사 태블릿의 키보드는 여기서 잰다(?device=phone · tablet). 체험 클라이언트가 아니면(운영) 이 경로는 없고 처음 화면으로 간다.
// #/preview/enroll · #/preview/login: 서버 모드의 기기 등록 · 로그인 화면(서버 없이 그림: 보내면 `체험판 미지원`). 로그인 타일의 이름은
// 체험판이 주는 견본 직원(client.previewStaff), ?many면 쪽 넘김을 보려고 여러 번 늘어놓는다. #/preview/offline: 서버에 닿지 않을 때의
// `연결 끊김` 화면. #/preview/exit: 로그인한 기기의 나가기(오늘 · 직원 · `로그아웃`, 로그아웃은 아무 일도 하지 않음).
// #/preview/choose: 시험 매장의 열린 등록(기기 선택 → 기사 기기면 차량 선택). 차량은 체험판이 주는 견본 차량(client.previewVehicles),
// ?many면 쪽 넘김을 보려고 여러 번 늘어놓고, ?none이면 차량이 없는 매장(`차량 없음 · 관리자 확인 필요`), ?kind=driver_tablet ·
// driver_phone이면 차량 선택부터 연다. 차량 선택은 앱(session.tsx)처럼 어느 크기에서나 기사 등급으로 그린다(규칙 검사기가 기사 등급으로
// 잰다: 태블릿 크기의 `이전`도 56px). 고르면 `체험판 미지원`. 로그인 미리 보기의 ?open은 스스로 붙은
// 기기의 로그인(매장 이름 줄의 기기 모양 · 바닥줄의 `기기 선택`, 누르면 `체험판 미지원`).
// 체험 자료(fixture)를 가져오지 않는다.
import type { EnrollVehicle, LedgerViewResult, StaffTile } from '@skinote/contract';
import { DeviceProfileProvider, useUi } from '@skinote/ui';
import { useEffect, useMemo, useState } from 'react';
import { TextSheet } from '../components/TextSheet.tsx';
import { ChooseScreen, type DriverKind } from '../screens/ChooseScreen.tsx';
import { EnrollScreen, OfflineScreen } from '../screens/EnrollScreen.tsx';
import { LoginScreen } from '../screens/LoginScreen.tsx';
import { ExitScreen } from '../screens/PlainScreens.tsx';
import { useClient, useConfig, useLive } from './client.tsx';
import { go, useRoute, type PreviewView } from './router.ts';
import { SessionContext, type SessionControls } from './session-context.ts';
import { say } from './strings.ts';

/** ?many의 늘어놓는 수(견본 셋 × 8 = 24명: 가장 큰 검사 크기 1366×768에서도 두 쪽 넘게). */
const MANY_TIMES = 8;
/** 기기 선택 ?many의 차량 늘어놓는 수(견본 둘 × 12 = 24대). */
const MANY_VEHICLE_TIMES = 12;

/** 미리 보기 글자 한도: 가장 긴 글자 칸(현금 점검 직접 입력 사유 40자, 계획 7-5). */
const PREVIEW_TEXT_MAX = 40;

export function PreviewScreen({ view }: { view: PreviewView }) {
  const client = useClient();
  // 체험판 조작(체험 시계)이 있는 클라이언트만 체험판이다.
  const demo = typeof client.advanceClock === 'function';
  useEffect(() => { if (!demo) go({ name: 'start' }, { replace: true }); }, [demo]);
  if (!demo) return null;
  // 기기 선택 · 로그인 미리 보기는 주소의 뒷부분(?many · none · kind · open)으로 처음 상태를 정한다. 같은 화면에서 주소만 바뀌어도
  // (#/preview/choose?many → ?none) 새로 그린다: 앞 주소에서 고른 종류 · 한 줄이 남지 않게.
  const query = window.location.hash.split('?')[1] ?? '';
  switch (view) {
    case 'keyboard': return <KeyboardPreview />;
    case 'enroll': return <EnrollScreen onSubmit={() => Promise.resolve(say('demoUnsupported'))} />;
    case 'choose': return <ChoosePreview key={'choose?' + query} />;
    case 'login': return <LoginPreview key={'login?' + query} />;
    case 'offline': return <OfflinePreview />;
    case 'exit': return <ExitPreview />;
  }
}

/** 연결 끊김 화면: 마지막 연결은 체험 시계의 지금. */
function OfflinePreview() {
  const client = useClient();
  const [at] = useState(() => new Date(client.now?.() ?? Date.now()).toISOString());
  return <OfflineScreen lastSyncAt={at} onRetry={() => {}} />;
}

/** 로그인한 기기의 나가기: 견본 직원 · 기기 종류 이름(카운터 · 기사 태블릿 · 기사 휴대폰), 로그아웃은 아무 일도 하지 않는다. */
function ExitPreview() {
  const client = useClient();
  const route = useRoute();
  const device = route.name === 'preview' ? route.device : null;
  const today = useLive<LedgerViewResult>('today', (c) => c.ledgerView('day_ledger', {})).data?.currentBusinessDate ?? null;
  const session = useMemo<SessionControls>(() => ({
    info: {
      shop: { name: '' },
      staff: { id: 'preview', name: client.previewStaff?.()[device ? 2 : 1] ?? '', roleKey: device ? 'driver' : 'counter' },
      device: device
        ? { id: 'preview', kind: device === 'phone' ? 'driver_phone' : 'driver_tablet', label: say(device === 'phone' ? 'startPhone' : 'startTablet'), vehicleId: 'v1' }
        : { id: 'preview', kind: 'pos', label: say('startCounter') },
      csrf: '', idleTimeoutS: 0, serverTime: '',
    },
    today,
    logout: () => Promise.resolve(),
  }), [client, device, today]);
  return (
    <SessionContext.Provider value={session}>
      <ExitScreen from={device ? 'driver' : 'pos'} />
    </SessionContext.Provider>
  );
}

/** 기기 선택(열린 등록): 견본 차량 타일, 고르면 `체험판 미지원`. 차량 선택은 기사 등급(앱과 같게). */
function ChoosePreview() {
  const client = useClient();
  const { timezone } = useUi();
  const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  const many = params.has('many');
  const none = params.has('none');
  const start = params.get('kind');
  const [kind, setKind] = useState<DriverKind | null>(start === 'driver_tablet' || start === 'driver_phone' ? start : null);
  const vehicles = useMemo<EnrollVehicle[]>(() => {
    const list = none ? [] : client.previewVehicles?.() ?? [];
    return Array.from({ length: many ? MANY_VEHICLE_TIMES : 1 }, () => list).flat().map((v, i) => ({ id: v.id + '-' + i, name: v.name }));
  }, [client, many, none]);
  const screen = <ChooseScreen vehicles={vehicles} kind={kind} onKind={setKind} onChoose={() => Promise.resolve(say('demoUnsupported'))} />;
  return kind ? <DeviceProfileProvider role="driver" timezone={timezone}>{screen}</DeviceProfileProvider> : screen;
}

/** 로그인 화면: 견본 직원 타일, 비밀번호를 보내면 `체험판 미지원`. */
function LoginPreview() {
  const client = useClient();
  const config = useConfig();
  const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  const many = params.has('many');
  const open = params.has('open');
  const device = params.get('device');
  const [note, setNote] = useState<string | null>(null);
  const staff = useMemo<StaffTile[]>(() => {
    const names = client.previewStaff?.() ?? [];
    return Array.from({ length: many ? MANY_TIMES : 1 }, () => names).flat().map((name, i) => ({ id: 'preview-' + i, name }));
  }, [client, many]);
  const vehicleName = client.previewVehicles?.()[0]?.name;
  // ?open: 스스로 붙은 기기(휴대폰 · 태블릿이면 기사 기기와 견본 첫 차량, 아니면 카운터).
  const deviceLine = device === 'phone' || device === 'tablet'
    ? say(device === 'phone' ? 'startPhone' : 'startTablet') + (vehicleName ? ' · ' + vehicleName : '')
    : say('startCounter');
  return (
    <LoginScreen
      shopName={config?.shopName ?? ''}
      staff={staff}
      note={note}
      onPin={() => Promise.resolve(say('demoUnsupported'))}
      {...(open ? { deviceLine, onChooseDevice: () => setNote(say('demoUnsupported')) } : {})}
    />
  );
}

/** 대표자 칸 하나: 열면 화면 키보드가 올라오고, `입력`한 글이 종이에 남는다. 처음에 열려 있다. */
function KeyboardPreview() {
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(true);
  return (
    <div className="pos-plain">
      <main className="pos-card">
        <h1 className="pos-card-title">{say('leader')}</h1>
        <p className={'pos-card-line pos-preview-text' + (value ? '' : ' is-empty')}>{value || say('leaderEmpty')}</p>
        <div className="pos-card-row">
          <button type="button" className="sn-button pos-preview-open" onClick={() => setOpen(true)}>{say('leaderPad')}</button>
        </div>
      </main>
      {open ? (
        <TextSheet
          title={say('leader')}
          value={value}
          placeholder={say('leaderEmpty')}
          maxLength={PREVIEW_TEXT_MAX}
          onSubmit={(text) => { setValue(text); setOpen(false); }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}
