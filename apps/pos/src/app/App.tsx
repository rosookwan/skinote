// 앱 뼈대: 해시 경로 → 화면. 역할(카운터 · 기사)과 잰 크기로 기기 등급을 고르는 DeviceProfileProvider 안에 화면을 둔다.
// 기사 화면을 '휴대폰 모양으로 보기'(#/driver/:date?device=phone)로 넓은 화면에서 열면, 휴대폰 검사 크기(360×640) 틀 안에
// 휴대폰 등급으로 그린다(창이 그 틀보다 작으면 잰 크기 그대로).
import { DEVICE_PROFILES, DeviceProfileProvider, pickDeviceClass, useViewportSize } from '@skinote/ui';
import { useEffect, type ReactNode } from 'react';
import { PosCollectionScreen, DriverListScreen } from '../screens/CollectionListScreen.tsx';
import { DayLedgerScreen } from '../screens/DayLedgerScreen.tsx';
import { OrderSlipScreen } from '../screens/OrderSlipScreen.tsx';
import { ExitScreen, StartScreen } from '../screens/PlainScreens.tsx';
import { useClient, useConfig } from './client.tsx';
import { go, useRoute, type Route } from './router.ts';
import { say } from './strings.ts';

/** 브라우저 탭 · 설치한 앱 창의 제목. */
const TITLES: Record<Route['name'], string> = {
  start: say('appName'),
  ledger: say('titleLedger'),
  slip: say('titleSlip'),
  collection: say('titleCollection'),
  exit: say('titleExit'),
  driver: say('titleDriver'),
  unknown: say('appName'),
};

function Screen({ route }: { route: Route }) {
  switch (route.name) {
    case 'start': return <StartScreen />;
    case 'ledger': return <DayLedgerScreen key={'ledger:' + (route.date ?? '')} date={route.date} />;
    case 'slip': return <OrderSlipScreen key={'slip:' + route.orderId} orderId={route.orderId} />;
    case 'collection': return <PosCollectionScreen key={'collection:' + (route.date ?? '')} date={route.date} />;
    case 'exit': return <ExitScreen from={route.from ?? 'pos'} />;
    case 'driver': return <DriverListScreen key={'driver:' + route.date} date={route.date} />;
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
  const viewport = useViewportSize(PHONE);
  const driverSide = route.name === 'driver' || (route.name === 'exit' && route.from === 'driver');
  // 이 화면이 어느 기기의 것인지 클라이언트에 알린다(체험판: 기사 기기의 보냄 대기 · 연결은 기사 화면에서만 보인다).
  // 화면이 처음 읽기 전에 알아야 하므로 그리는 중에 부른다(같은 값이면 아무 일도 없다).
  client.setDevice?.(driverSide ? 'driver' : 'counter');
  useEffect(() => {
    if (route.name === 'unknown') go({ name: 'start' }, { replace: true });
    document.title = TITLES[route.name];
  }, [route.name]);
  const timezone = config?.timezone ?? 'Asia/Seoul';
  // 휴대폰 틀은 창이 휴대폰보다 넓을 때만(기사 역할로 잰 크기가 태블릿 등급일 때, DeviceProfile의 등급 고르기와 같은 기준).
  const phoneFrame = route.name === 'driver' && route.device === 'phone' && pickDeviceClass(viewport, 'driver') !== 'driver_phone' && viewport.height >= PHONE.height;
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
