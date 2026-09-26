// 체험판의 처음 화면(#/) · 나가기(#/exit). 종이 한 장에 큰 버튼 몇 개.
// 처음 화면은 어느 기기로 볼지 고른다: 카운터(포스) · 기사 태블릿 · 기사 휴대폰. 나가기에서는 체험 시계를 앞으로 돌리거나
// 체험 자료를 처음(12월 26일 15:40)으로 되돌린다. 기사 기기의 나가기(#/exit?from=driver)에서는 기사 기기의 연결을 끊고 이어
// 보냄 대기(점선 도장)를 볼 수 있다.
// 서버 모드(로그인한 세션, 계획 work/impl-server/plan.md 6-3): 처음 화면은 없고(기기의 첫 화면으로 간다), 나가기는 오늘 · 직원 이름과
// `장부`(기사는 `수거 목록`) · `로그아웃`(묻는 창 `로그아웃`)이다. 체험 시계 · 초기화 · 연결 끊기 체험은 체험판에만 있다.
import type { LedgerViewResult } from '@skinote/contract';
import { formatDateTitle, formatTime, useUi } from '@skinote/ui';
import { useEffect, useState } from 'react';
import { useClient, useConfig, useConnection, useLive } from '../app/client.tsx';
import { clearClosingDraft } from '../app/closing-draft.ts';
import { clearNewOrder } from '../app/new-order-draft.ts';
import { back, go, navState } from '../app/router.ts';
import { shapeOf, useSession, type SessionControls } from '../app/session-context.ts';
import { say } from '../app/strings.ts';
import { NoticeDialog } from '../components/NoticeDialog.tsx';

/**
 * 오늘 영업일(읽기 모델의 머리). 기사 쪽은 수거 목록에서 읽는다: 서버의 기사 세션은 장부(day_ledger)를 읽지 못한다(plan §5-4).
 */
function useToday(driver = false): string | null {
  const live = useLive<LedgerViewResult>(driver ? 'today:driver' : 'today', (c) => c.ledgerView(driver ? 'collection_list' : 'day_ledger', {}));
  return live.data?.currentBusinessDate ?? null;
}

export function StartScreen() {
  const config = useConfig();
  const today = useToday();
  return (
    <div className="pos-plain">
      <main className="pos-card">
        <h1 className="pos-card-title">{say('appName')}</h1>
        <p className="pos-card-line">{[config?.shopName, say('demoData'), today ? formatDateTitle(today) : ''].filter(Boolean).join(' · ')}</p>
        <div className="pos-card-choices">
          <button type="button" className="sn-primary pos-big-choice" data-primary="true" onClick={() => go({ name: 'ledger', date: null })}>
            <span>{say('startCounter')}</span>
            <small>{say('startCounterNote')}</small>
          </button>
          {/* 기사 휴대폰이 먼저: 첫 매장 기사의 주 기기는 개인 휴대폰이다(2026-09-26 답 12). */}
          <button type="button" className="sn-button pos-big-choice" onClick={() => today && go({ name: 'driver', date: today, device: 'phone' })}>
            <span>{say('startPhone')}</span>
            <small>{say('startDriverNote')}</small>
          </button>
          <button type="button" className="sn-button pos-big-choice" onClick={() => today && go({ name: 'driver', date: today, device: 'tablet' })}>
            <span>{say('startTablet')}</span>
            <small>{say('startDriverNote')}</small>
          </button>
        </div>
        <p className="pos-card-note">{say('startNote')}</p>
      </main>
    </div>
  );
}

export function ExitScreen({ from = 'pos' }: { from?: 'pos' | 'driver' }) {
  const session = useSession();
  if (session) return <SessionExit session={session} from={from} />;
  return <DemoExit from={from} />;
}

/** 서버 모드의 나가기: 오늘 · 직원 · 기기 한 줄, 돌아가는 곳(카운터 `장부`, 기사 `수거 목록`), `로그아웃`(묻는 창). */
function SessionExit({ session, from }: { session: SessionControls; from: 'pos' | 'driver' }) {
  const driver = from === 'driver';
  const today = useToday(driver);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const who = session.info.staff.name + ' · ' + session.info.device.label;
  const line = [today ? formatDateTitle(today) : '', who].filter(Boolean).join(' · ');
  const toHome = () => {
    if (driver) {
      if (navState().fromDriver) back();
      else if (today) go({ name: 'driver', date: today, device: shapeOf(session.info.device.kind) });
    } else {
      go({ name: 'ledger', date: null });
    }
  };
  const logout = () => {
    if (busy) return;
    setBusy(true);
    void session.logout().finally(() => setBusy(false));
  };
  return (
    <div className="pos-plain">
      <main className="pos-card">
        <h1 className="pos-card-title">{say('exitTitle')}</h1>
        <p className="pos-card-line">{line}</p>
        <div className="pos-card-row">
          <button type="button" className="sn-primary" data-primary="true" onClick={toHome}>{driver ? say('toList') : say('toLedger')}</button>
          <button type="button" className="sn-button" onClick={() => setAsking(true)}>{say('logout')}</button>
        </div>
      </main>
      {asking ? (
        <NoticeDialog
          title={say('logout')}
          lines={[who]}
          actions={[{ label: say('logout'), primary: true, onPress: () => { setAsking(false); logout(); } }]}
          onClose={() => setAsking(false)}
        />
      ) : null}
    </div>
  );
}

function DemoExit({ from }: { from: 'pos' | 'driver' }) {
  const client = useClient();
  const { timezone } = useUi();
  const today = useToday();
  const [, redraw] = useState(0);
  const [asking, setAsking] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => {
    const timer = setInterval(() => redraw((n) => n + 1), 15_000);
    return () => clearInterval(timer);
  }, []);
  const clock = client.now ? formatTime(client.now(), timezone) : '';
  const advance = (minutes: number) => {
    client.advanceClock?.(minutes);
    redraw((n) => n + 1);
  };
  const line = [today ? formatDateTitle(today) : '', clock ? say('demoClockAt', { time: clock }) : ''].filter(Boolean).join(' · ');
  if (from === 'driver') return <DriverExit today={today} line={line} advance={advance} />;
  return (
    <div className="pos-plain">
      <main className="pos-card">
        <h1 className="pos-card-title">{say('exitTitle')}</h1>
        <p className="pos-card-line">{line}</p>
        <div className="pos-card-row">
          <button type="button" className="sn-primary" data-primary="true" onClick={() => go({ name: 'start' })}>{say('toStart')}</button>
          <button type="button" className="sn-button" onClick={() => go({ name: 'ledger', date: null })}>{say('toLedger')}</button>
        </div>
        <section className="pos-card-section" aria-labelledby="exit-clock">
          <h2 id="exit-clock" className="pos-card-subtitle">{say('demoClock')}</h2>
          <p className="pos-card-note">{say('demoClockNote')}</p>
          <div className="pos-card-row">
            <button type="button" className="sn-button" onClick={() => advance(10)}>{say('plus10')}</button>
            <button type="button" className="sn-button" onClick={() => advance(60)}>{say('plus60')}</button>
          </div>
        </section>
        <section className="pos-card-section" aria-labelledby="exit-reset">
          <h2 id="exit-reset" className="pos-card-subtitle">{say('demoData')}</h2>
          <p className="pos-card-note">{done ?? say('resetNote')}</p>
          <div className="pos-card-row">
            <button type="button" className="sn-button" onClick={() => setAsking(true)}>{say('resetButton')}</button>
          </div>
        </section>
      </main>
      {asking ? (
        <NoticeDialog
          title={say('resetButton')}
          lines={[say('resetConfirm')]}
          actions={[{
            label: say('resetAction'),
            primary: true,
            onPress: () => {
              client.reset?.();
              // 이 기기에 둔 화면 초안(새 접수 · 마감 셈)도 옛 자료의 것이라 함께 버린다.
              clearNewOrder();
              clearClosingDraft();
              setAsking(false);
              setDone(say('resetDone'));
            },
          }]}
          onClose={() => setAsking(false)}
        />
      ) : null}
    </div>
  );
}

/** 기사 기기의 나가기: 처음 화면 · 수거 목록으로, 기사 기기 연결 끊기 · 잇기(체험), 체험 시계. 휴대폰 한 화면에 들어가게 짧게. */
function DriverExit({ today, line, advance }: { today: string | null; line: string; advance: (minutes: number) => void }) {
  const client = useClient();
  const connection = useConnection();
  const offline = client.driverOffline?.() ?? !connection.online;
  const toList = () => {
    if (navState().fromDriver) back();
    else if (today) go({ name: 'driver', date: today, device: 'tablet' });
  };
  const toggle = () => client.setOffline?.(!offline);
  const waiting = connection.pendingCount;
  return (
    <div className="pos-plain">
      <main className="pos-card">
        <h1 className="pos-card-title">{say('exitTitle')}</h1>
        <p className="pos-card-line">{line}</p>
        <div className="pos-card-row">
          <button type="button" className="sn-primary" data-primary="true" onClick={() => go({ name: 'start' })}>{say('toStart')}</button>
          <button type="button" className="sn-button" onClick={toList}>{say('toList')}</button>
        </div>
        <section className="pos-card-section" aria-labelledby="exit-link">
          <h2 id="exit-link" className="pos-card-subtitle">{offline ? say('deviceOffline') : say('deviceOnline')}</h2>
          <p className="pos-card-note">{offline ? say('offlineNote') : say('onlineNote')}</p>
          <div className="pos-card-row">
            <button type="button" className="sn-button" onClick={toggle}>{offline ? (waiting ? say('reconnectWaiting', { n: waiting }) : say('reconnect')) : say('disconnect')}</button>
          </div>
        </section>
        <section className="pos-card-section" aria-labelledby="exit-clock">
          <h2 id="exit-clock" className="pos-card-subtitle">{say('demoClock')}</h2>
          <div className="pos-card-row">
            <button type="button" className="sn-button" onClick={() => advance(10)}>{say('plus10')}</button>
            <button type="button" className="sn-button" onClick={() => advance(60)}>{say('plus60')}</button>
          </div>
        </section>
      </main>
    </div>
  );
}
