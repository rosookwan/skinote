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
// 기사 연결 끊김 기록(work/impl-offline/plan.md §8-3): #/preview/lock 앱 잠금(기억한 기사 타일 하나 + 비밀번호 판, 보내면 `비밀번호 불일치 · 재입력
// 필요`, ?out=1이면 `로그인 잠김 · 연결 후 가능`), #/preview/offline?pending=3(&unknown=1 · &off=1) 연결 끊김 화면의 전송 대기 · 한 줄,
// #/preview/unconfirmed 답을 잃은 매장 입고(창에 `연결 끊김 · 결과 확인 중`, 끊긴 동안 주 버튼 막힘), #/preview/drain?pending=2 보냄 대기가 비지 않은
// 매장 입고(`입고 불가 · 전송 대기 2`), #/preview/elsewhere 로그인 때 같은 차량 다른 기기의 미전송 알림(기사 목록 위). 창 · 목록은 앱의 부품 그대로
// (ConfirmFlow · DriverListScreen)이고 명령의 답과 세션만 미리 보기가 정한다.
// 체험 자료(fixture)를 가져오지 않는다.
import type { AnyCommandEnvelope, CommandOutcome, ConnectionState, EnrollVehicle, LedgerViewResult, SettingsOp, StaffTile } from '@skinote/contract';
import { DeviceProfileProvider, formatTime, t, useUi } from '@skinote/ui';
import { useEffect, useMemo, useState } from 'react';
import { useConfirmFlow } from '../components/ConfirmFlow.tsx';
import { DriverListScreen } from '../screens/CollectionListScreen.tsx';
import { TextSheet } from '../components/TextSheet.tsx';
import { ChooseScreen, type DriverKind } from '../screens/ChooseScreen.tsx';
import { EnrollScreen, OfflineScreen } from '../screens/EnrollScreen.tsx';
import { LoginScreen } from '../screens/LoginScreen.tsx';
import { ExitScreen } from '../screens/PlainScreens.tsx';
import { SettingsTabPreview } from '../screens/ShopSettingsScreen.tsx';
import { PinDialog } from '../components/PinDialog.tsx';
import { ClientProvider, useClient, useConfig, useLive, type AppClient } from './client.tsx';
import { go, useRoute, type PreviewView } from './router.ts';
import { SessionContext, lockPadNote, type SessionControls } from './session-context.ts';
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
    case 'pin': return <PinPreview />;
    case 'settings-many': return <SettingsManyPreview key={'many?' + query} />;
    case 'lock': return <LockPreview key={'lock?' + query} />;
    case 'unconfirmed': return <DialogStatePreview key={'unconfirmed?' + query} mode="unconfirmed" />;
    case 'drain': return <DialogStatePreview key={'drain?' + query} mode="drain" />;
    case 'elsewhere': return <ElsewherePreview key={'elsewhere?' + query} />;
  }
}

const previewQuery = () => new URLSearchParams(window.location.hash.split('?')[1] ?? '');

/**
 * 앱 잠금(O15 d): 기억한 기사(견본 기사) 타일 하나와 곧바로 열린 비밀번호 판. 보내면 틀림 한 줄. ?out=1이면 다섯 번 틀려 5분 잠김(`로그인 잠김 · {시각} 이후
 * 가능`, 숫자 키 · 입력을 누를 수 없음), ?login=1이면 기기에서 풀 수 없음(`로그인 잠김 · 연결 후 가능`), ?pending=n이면 판 위의 `전송 대기 n`(§17 R3-24).
 */
function LockPreview() {
  const client = useClient();
  const config = useConfig();
  const { timezone } = useUi();
  const q = previewQuery();
  const out = q.get('out') === '1';
  const login = q.get('login') === '1';
  const pending = Math.max(0, Number(q.get('pending') ?? '0') || 0);
  const [until] = useState(() => new Date((client.now?.() ?? Date.now()) + 5 * 60_000).toISOString());
  const tile = useMemo<StaffTile>(() => ({ id: 'preview-lock', name: client.previewStaff?.()[2] ?? '' }), [client]);
  const locked = login ? say('lockOffline') : out ? say('loginLocked', { time: formatTime(until, timezone) }) : undefined;
  return (
    <LoginScreen
      shopName={config?.shopName ?? ''}
      staff={[tile]}
      openFor={tile}
      note={lockPadNote({ pendingCount: pending })}
      onPin={() => Promise.resolve(say('pinWrong'))}
      {...(locked ? { locked } : {})}
    />
  );
}

/**
 * 매장 입고 창의 두 상태(앱의 ConfirmFlow 그대로): 답을 잃음(unconfirmed: 끊긴 기기, 명령의 답 `연결 끊김 · 결과 확인 중` · 주 버튼 막힘) · 보냄 대기가
 * 비지 않음(drain: 연결된 기기, `입고 불가 · 전송 대기 {n}` · 주 버튼 그대로). 읽기는 체험 자료, 명령의 답과 연결만 미리 보기가 정한다.
 */
function DialogStatePreview({ mode }: { mode: 'unconfirmed' | 'drain' }) {
  const client = useClient();
  const pending = Math.max(1, Number(previewQuery().get('pending') ?? '2') || 2);
  const proxy = useMemo<AppClient>(() => {
    const connection: ConnectionState = mode === 'unconfirmed'
      ? { online: false, pendingCount: 1, sendQueue: true, unconfirmedCount: 1, lastSyncAt: new Date(client.now?.() ?? Date.now()).toISOString() }
      : { online: true, pendingCount: pending, sendQueue: true };
    const answer = (envelope: AnyCommandEnvelope): CommandOutcome => ({
      outcome: mode === 'unconfirmed' ? 'unknown' : 'rejected', requestId: envelope.requestId, rev: envelope.basis.rev, asOfRev: envelope.basis.rev,
      epoch: envelope.basis.epoch, rebased: false, changes: [],
      error: mode === 'unconfirmed' ? { code: 'UNKNOWN', message: say('resultChecking') } : { code: 'PENDING', message: say('receiveWaiting', { n: pending }) },
    });
    return {
      config: () => client.config(), ledgerView: (key, params) => client.ledgerView(key, params), query: (name, params) => client.query(name, params),
      command: (envelope) => Promise.resolve(answer(envelope)), subscribe: (listener) => client.subscribe(listener), connection: () => connection,
      pending: () => client.pending(),
    };
  }, [client, mode, pending]);
  return (
    <ClientProvider client={proxy}>
      <ReceiveDialog />
    </ClientProvider>
  );
}

/** 1호 차량의 매장 입고 창을 곧바로 연다(차에 받은 것이 없으면 한 줄 알림). */
function ReceiveDialog() {
  const flow = useConfirmFlow();
  useEffect(() => { flow.open({ actionKey: 'receive_to_shop', vehicleId: 'v1' }); }, []);
  return <div className="pos-plain">{flow.element}</div>;
}

/**
 * 로그인 때 같은 차량의 다른 기기가 보낼 기록을 가짐(sync 6): 기사 목록 위의 한 번 알림. 서버가 알려 주는 그 기기의 등록 이름 · 마지막 로그인 직원
 * (견본 기사 둘째)과 ?pending=n(없으면 수를 모름, §17 R3-28). ?kind=tablet이면 태블릿, ?old=1이면 기기를 알려 주지 않는 옛 서버의 줄.
 */
function ElsewherePreview() {
  const client = useClient();
  const route = useRoute();
  const device = route.name === 'preview' && route.device ? route.device : 'tablet';
  const q = previewQuery();
  const other = q.get('kind') === 'tablet' ? 'driver_tablet' as const : 'driver_phone' as const;
  const count = Number(q.get('pending') ?? '');
  const today = useLive<LedgerViewResult>('today:driver', (c) => c.ledgerView('collection_list', {})).data?.currentBusinessDate ?? null;
  const [elsewhere, setElsewhere] = useState<SessionControls['elsewhere']>(() => ({
    deviceKind: other, pending: Number.isInteger(count) && count > 0 ? count : null,
    ...(q.get('old') === '1' ? {} : { label: other === 'driver_tablet' ? '1호 차량 태블릿' : '1호 차량 휴대폰', staffName: client.previewStaff?.()[2] ?? '' }),
  }));
  const session = useMemo<SessionControls>(() => ({
    info: {
      shop: { name: '' },
      staff: { id: 'preview', name: client.previewStaff?.()[2] ?? '', roleKey: 'driver' },
      device: { id: 'preview', kind: device === 'phone' ? 'driver_phone' : 'driver_tablet', label: say(device === 'phone' ? 'startPhone' : 'startTablet'), vehicleId: 'v1' },
      csrf: '', idleTimeoutS: 0, serverTime: '',
    },
    today,
    logout: () => Promise.resolve(null),
    ...(elsewhere ? { elsewhere, dismissElsewhere: () => setElsewhere(undefined) } : {}),
  }), [client, device, today, elsewhere]);
  if (!today) return null;
  return (
    <SessionContext.Provider value={session}>
      <DriverListScreen date={today} device={device} />
    </SessionContext.Provider>
  );
}

/** 미리 보기 비밀번호(예시 숫자: 브라우저는 비밀번호를 만들지 않는다, 서버가 만든다). */
const PREVIEW_PIN = '2468';

/** 비밀번호 재발급 창의 둘째 단계(새 비밀번호 · 한 번 보임): 견본 기사 이름과 예시 숫자. */
function PinPreview() {
  const client = useClient();
  const [open, setOpen] = useState(true);
  const name = client.previewStaff?.()[2] ?? '';
  return (
    <div className="pos-plain">
      {open ? <PinDialog client={client} staffId="preview" name={name} preview={PREVIEW_PIN} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

/** 권종 · 장소가 많은 매장의 매장 설정 탭(?tab=pricing 기본 · places): 긴 카드의 `(계속)`. */
function SettingsManyPreview() {
  const client = useClient();
  const tab = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('tab') === 'places' ? 'places' : 'pricing';
  if (!client.previewSettings) return null;
  const load = (ops: SettingsOp[]) => client.previewSettings!(tab, ops);
  return <SettingsTabPreview tab={tab} load={load} />;
}

/**
 * 연결 끊김 화면: 마지막 연결은 체험 시계의 지금. ?pending=3이면 이 기기의 `전송 대기 3`과 기사 기기의 `수거 목록 · 연결 후 조회 가능`(§17 R3-30),
 * &unknown=1이면 되살린 서버가 모르는 기기(`기기 등록 없음 · 공급자 연락`), &off=1이면 저장할 곳이 없는 기기(`이 기기 저장 불가`).
 */
function OfflinePreview() {
  const client = useClient();
  const [at] = useState(() => new Date(client.now?.() ?? Date.now()).toISOString());
  const q = previewQuery();
  const pending = Math.max(0, Number(q.get('pending') ?? '0') || 0);
  const notice = q.get('unknown') === '1' ? say('deviceUnknown') : q.get('off') === '1' ? say('recordingOff') : undefined;
  return <OfflineScreen lastSyncAt={at} onRetry={() => {}} pending={pending} driver={pending > 0} {...(notice ? { notice } : {})} />;
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
    logout: () => Promise.resolve(null),
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
