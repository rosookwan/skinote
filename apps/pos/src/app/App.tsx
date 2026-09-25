// 앱 뼈대: 해시 경로 → 화면. 역할(카운터 · 기사)과 잰 크기로 기기 등급을 고르는 DeviceProfileProvider 안에 화면을 둔다.
// 기사 화면을 '휴대폰 모양으로 보기'(#/driver/:date?device=phone)로 넓은 화면에서 열면, 휴대폰 검사 크기(360×640) 틀 안에
// 휴대폰 등급으로 그린다(창이 그 틀보다 작으면 잰 크기 그대로).
// 서버 모드(로그인한 세션이 있음, 계획 work/impl-server/plan.md 6-3): 역할은 기기 종류에서 온다(포스 = 카운터, 기사 태블릿 · 휴대폰 =
// 기사). 처음 화면(#/)은 기기의 첫 화면(카운터 #/ledger, 기사 #/driver/<오늘>)으로 가고, 기사 기기는 기사 화면 밖을 열지 않는다.
import { isDriverDevice } from '@skinote/contract';
import { DEVICE_PROFILES, DeviceProfileProvider, pickDeviceClass, useViewportSize } from '@skinote/ui';
import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { DeliveryListScreen, DriverListScreen, PosCollectionScreen } from '../screens/CollectionListScreen.tsx';
import { DayLedgerScreen } from '../screens/DayLedgerScreen.tsx';
import { OrderSlipScreen } from '../screens/OrderSlipScreen.tsx';
import { ExitScreen, StartScreen } from '../screens/PlainScreens.tsx';

// 둘째 판 화면(새 접수 · 일괄 수납 · 마감 · 관리 · 매장 설정 · 기사 업무 판)은 따로 묶어 처음 열 때 받는다(첫 화면 묶음을 작게, 설치한 앱은
// 서비스 워커가 모두 미리 받아 둔다). 장부 · 접수증 · 수거 목록 · 처음 · 나가기는 첫 묶음이다.
const NewOrderScreen = lazy(() => import('../screens/NewOrderScreen.tsx').then((m) => ({ default: m.NewOrderScreen })));
const GroupPayScreen = lazy(() => import('../screens/GroupPayScreen.tsx').then((m) => ({ default: m.GroupPayScreen })));
const ClosingScreen = lazy(() => import('../screens/ClosingScreen.tsx').then((m) => ({ default: m.ClosingScreen })));
const ManageScreen = lazy(() => import('../screens/ManageScreen.tsx').then((m) => ({ default: m.ManageScreen })));
const ShopSettingsScreen = lazy(() => import('../screens/ShopSettingsScreen.tsx').then((m) => ({ default: m.ShopSettingsScreen })));
const TaskSheetScreen = lazy(() => import('../screens/TaskSheetScreen.tsx').then((m) => ({ default: m.TaskSheetScreen })));
// 체험판 전용 미리 보기(#/preview/keyboard, 연결하지 않은 주소): 규칙 검사기가 여는 곳이라 따로 묶는다.
const PreviewScreen = lazy(() => import('./preview.tsx').then((m) => ({ default: m.PreviewScreen })));
// 서버 모드의 연결 끊김 화면(기사 첫 화면이 오늘을 받지 못함): 서버 모드 묶음에 있다.
const OfflineScreen = lazy(() => import('../screens/EnrollScreen.tsx').then((m) => ({ default: m.OfflineScreen })));
import { useClient, useConfig } from './client.tsx';
import { go, useRoute, type Route } from './router.ts';
import { serverRedirect, useSession } from './session-context.ts';
import { say } from './strings.ts';

/** 브라우저 탭 · 설치한 앱 창의 제목. */
const TITLES: Record<Route['name'], string> = {
  start: say('appName'),
  ledger: say('titleLedger'),
  slip: say('titleSlip'),
  newOrder: say('titleNewOrder'),
  groupPay: say('titleGroupPay'),
  closing: say('titleClosing'),
  manage: say('titleManage'),
  shopSettings: say('titleShopSettings'),
  collection: say('titleCollection'),
  exit: say('titleExit'),
  driver: say('titleDriver'),
  deliveries: say('titleDeliveries'),
  task: say('titleTask'),
  preview: say('appName'),
  unknown: say('appName'),
};

/** 기사 기기의 화면(역할 driver: 기사 등급 · 기사 기기의 연결 · 전송 대기). */
const isDriverRoute = (route: Route) => route.name === 'driver' || route.name === 'deliveries' || route.name === 'task' || (route.name === 'exit' && route.from === 'driver')
  || (route.name === 'preview' && route.device !== null);

function Screen({ route }: { route: Route }) {
  // 따로 받는 화면을 받는 동안은 빈 화면(로컬 파일이라 한순간).
  return <Suspense fallback={null}><RouteScreen route={route} /></Suspense>;
}

function RouteScreen({ route }: { route: Route }) {
  switch (route.name) {
    case 'start': return <StartScreen />;
    case 'ledger': return <DayLedgerScreen key={'ledger:' + (route.date ?? '')} date={route.date} />;
    case 'slip': return <OrderSlipScreen key={'slip:' + route.orderId} orderId={route.orderId} />;
    // 새 접수 ① 품목 · ② 일정(V2 · V3): 두 단계가 한 화면이라 단계를 오가도 초안 · 연 종류가 그대로다(key 하나).
    case 'newOrder': return <NewOrderScreen key="new" step={route.step} />;
    // 일괄 수납(V5): 다른 팀 몫까지 받을 팀의 접수증에서 연다.
    case 'groupPay': return <GroupPayScreen key={'pay:' + route.orderId} orderId={route.orderId} />;
    // 하루 마감(V6): 장부의 주 버튼 `마감`(마지막 반납 타임 뒤) · 관리 → 마감.
    case 'closing': return <ClosingScreen key={'closing:' + (route.date ?? '')} date={route.date} />;
    // 관리(카드 목록: 매장 설정 · 마감)와 매장 설정(V8은 운영 규칙 탭, 다른 탭은 준비 중인 화면). 탭마다 새로 그린다(저장하지 않은 바꿈은
    // 떠나기 전에 `미저장 변경 N건` 창이 묻는다).
    case 'manage': return <ManageScreen />;
    case 'shopSettings': return <ShopSettingsScreen key={'settings:' + route.tab} tab={route.tab} />;
    // 기사 배달 목록(ui 6-5)과 업무 판(V7): 목록의 팀 칸 → 업무 판, 바닥줄 `‹ 배달 목록`으로 그 쪽 그 줄에 돌아온다.
    case 'deliveries': return <DeliveryListScreen key={'deliveries:' + route.date} date={route.date} device={route.device} />;
    case 'task': return <TaskSheetScreen key={'task:' + route.taskId} taskId={route.taskId} device={route.device} />;
    case 'collection': return <PosCollectionScreen key={'collection:' + (route.date ?? '')} date={route.date} />;
    case 'exit': return <ExitScreen from={route.from ?? 'pos'} />;
    case 'driver': return <DriverListScreen key={'driver:' + route.date} date={route.date} device={route.device} />;
    case 'preview': return <PreviewScreen key={'preview:' + route.view + ':' + (route.device ?? 'counter')} view={route.view} />;
    case 'unknown': return null;
  }
}

const PHONE = DEVICE_PROFILES.driver_phone.checkSizes[0] ?? { width: 360, height: 640 };

/** 넓은 화면에서 휴대폰 모양으로 볼 때의 틀(휴대폰 크기, 창 · 판은 틀 안에 뜬다). */
function PhoneStage({ timezone, children }: { timezone: string; children: ReactNode }) {
  return (
    <DeviceProfileProvider role="driver" timezone={timezone} size={PHONE} deviceClass="driver_phone" className="pos-phone-stage">
      <div className="pos-phone-frame" style={{ width: PHONE.width, height: PHONE.height }}>
        {children}
      </div>
    </DeviceProfileProvider>
  );
}

export function App() {
  const route = useRoute();
  const config = useConfig();
  const client = useClient();
  const session = useSession();
  const viewport = useViewportSize(PHONE);
  const kind = session?.info.device.kind ?? null;
  const driverSide = kind ? isDriverDevice(kind) || isDriverRoute(route) : isDriverRoute(route);
  // 서버 모드: 기기에 맞지 않는 경로는 기기의 첫 화면으로(기사의 첫 화면은 오늘을 받은 뒤, 그동안은 빈 화면).
  const redirect = kind ? serverRedirect(route, kind, session?.today ?? null) : null;
  // 이 화면이 어느 기기의 것인지 클라이언트에 알린다(체험판: 기사 기기의 보냄 대기 · 연결은 기사 화면에서만 보인다).
  // 화면이 처음 읽기 전에 알아야 하므로 그리는 중에 부른다(같은 값이면 아무 일도 없다).
  client.setDevice?.(driverSide ? 'driver' : 'counter');
  useEffect(() => {
    if (redirect && redirect !== 'wait') go(redirect, { replace: true });
    else if (!kind && route.name === 'unknown') go({ name: 'start' }, { replace: true });
    document.title = TITLES[route.name];
  }, [route, redirect, kind]);
  // 기사의 첫 화면이 오늘을 기다린다: 묻기가 실패했으면 빈 화면 대신 연결 끊김 화면(재시도), 아직 묻는 중이면 잠깐 빈 화면.
  if (redirect === 'wait' && session?.todayFailed) {
    return (
      <DeviceProfileProvider role="driver" timezone={config?.timezone ?? 'Asia/Seoul'}>
        <Suspense fallback={null}>
          <OfflineScreen lastSyncAt={session.lastSyncAt} onRetry={() => session.retryToday?.()} />
        </Suspense>
      </DeviceProfileProvider>
    );
  }
  if (redirect) return null;
  const timezone = config?.timezone ?? 'Asia/Seoul';
  // 휴대폰 틀은 창이 휴대폰보다 넓을 때만(기사 역할로 잰 크기가 태블릿 등급일 때, DeviceProfile의 등급 고르기와 같은 기준).
  const phoneShape = (route.name === 'driver' || route.name === 'deliveries' || route.name === 'task' || route.name === 'preview') && route.device === 'phone';
  const phoneFrame = phoneShape && pickDeviceClass(viewport, 'driver') !== 'driver_phone' && viewport.height >= PHONE.height;
  if (phoneFrame) {
    return (
      <PhoneStage timezone={timezone}>
        <Screen route={route} />
      </PhoneStage>
    );
  }
  return (
    <DeviceProfileProvider role={driverSide ? 'driver' : 'counter'} timezone={timezone}>
      <Screen route={route} />
    </DeviceProfileProvider>
  );
}
