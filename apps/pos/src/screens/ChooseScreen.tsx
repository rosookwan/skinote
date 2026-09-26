// 기기 선택(시험 매장의 열린 기기 등록, 2026-09-26 시험 중 요청 "등록번호는 좀 빼줘"): 서버가 등록 방법을 'open'으로 답하면 등록 번호
// 숫자판 대신 이 화면이 나온다. 종이 한 장에 `기기 선택`과 큰 버튼 셋(처음 화면과 같은 말: `카운터(포스)` · `기사 휴대폰` · `기사 태블릿`).
// 버튼 차례와 주 버튼은 이 화면의 등급을 따른다: 휴대폰 폭(기사 등급)이면 `기사 휴대폰`이 먼저이고 보라 주 버튼, `카운터(포스)`는 맨
// 뒤의 보통 버튼이다(개인 휴대폰을 연 기사가 카운터를 잘못 고르지 않게). 카운터 폭이면 `카운터(포스)`가 먼저이고 주황 주 버튼이다.
// 카운터는 누르면 바로 보내고, 기사 기기는 `차량 선택`(매장의 쓰는 차량 타일, 잰 높이로 쪽을 나눔, 바닥에 `이전`과 `‹ 1 / 2쪽 ›`)에서
// 차량을 고르면 보낸다. 고른 종류(kind)는 부르는 쪽이 쥔다: 차량 선택은 기사 등급으로 그린다(session.tsx). 매장에 쓰는 차량이 없으면
// 기사 기기 버튼은 눌리지 않고 한 줄 `차량 없음 · 관리자 확인 필요`. 보내는 동안은 `처리 중`, 틀리면 한 줄(`기기 수 초과 · 관리자 확인
// 필요` …). 보내기 · 다음 화면은 부르는 쪽(session.tsx)이 한다. 체험판 미리 보기(#/preview/choose)가 같은 화면을 견본 차량으로
// 그린다(보내면 `체험판 미지원`).
import type { DeviceKind, EnrollVehicle } from '@skinote/contract';
import { Pager, TextFit, t, useDeviceProfile, useElementSize } from '@skinote/ui';
import { useEffect, useRef, useState } from 'react';
import { say } from '../app/strings.ts';
import { staffGrid } from './LoginScreen.tsx';

export type DriverKind = Exclude<DeviceKind, 'pos'>;

export interface ChooseScreenProps {
  /** 기사 기기가 고를 차량(서버의 등록 방법 답). 없으면 기사 기기 버튼은 눌리지 않는다. */
  vehicles: readonly EnrollVehicle[];
  /** 고른 기사 기기 종류(차량 선택 단계), 아직이면 null. */
  kind: DriverKind | null;
  /** 기사 기기를 고름 · `이전`(null). */
  onKind: (kind: DriverKind | null) => void;
  /** 고른 종류 · 차량을 보낸다. 실패하면 보일 한 줄, 되면 null(부르는 쪽이 다음 화면으로 간다). */
  onChoose: (kind: DeviceKind, vehicleId?: string) => Promise<string | null>;
}

/** 기사 기기 종류의 이름(처음 화면의 말). */
const driverName = (kind: DriverKind) => say(kind === 'driver_phone' ? 'startPhone' : 'startTablet');

export function ChooseScreen({ vehicles, kind, onKind, onChoose }: ChooseScreenProps) {
  const profile = useDeviceProfile();
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { document.title = say('titleChoose'); }, []);

  const send = (chosen: DeviceKind, vehicleId?: string) => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    onChoose(chosen, vehicleId).then((line) => {
      setBusy(false);
      if (line) setNote(line);
    }, () => {
      setBusy(false);
      setNote(say('sendFailed'));
    });
  };
  const line = busy ? t('processing') : note;

  if (kind) {
    return (
      <VehicleStep
        kindName={driverName(kind)}
        vehicles={vehicles}
        line={line}
        busy={busy}
        onPick={(vehicleId) => send(kind, vehicleId)}
        onBack={() => { if (!busy) { setNote(null); onKind(null); } }}
      />
    );
  }
  const noVans = vehicles.length === 0;
  const pickDriver = (next: DriverKind) => { if (!busy) { setNote(null); onKind(next); } };
  // 이 화면의 등급이 기사(휴대폰 폭)면 기사 기기가 먼저이고 주 버튼, 카운터 폭이면 카운터가 먼저이고 주 버튼.
  const driverFirst = profile.key === 'driver_phone' || profile.key === 'driver_tablet';
  const counter = (primary: boolean) => (
    <button
      key="pos"
      type="button"
      className={(primary ? 'sn-primary' : 'sn-button') + ' pos-big-choice'}
      {...(primary ? { 'data-primary': 'true' } : {})}
      disabled={busy}
      onClick={() => send('pos')}
    >
      <span>{say('startCounter')}</span>
      <small>{say('startCounterNote')}</small>
    </button>
  );
  const driver = (next: DriverKind, primary: boolean) => (
    <button
      key={next}
      type="button"
      className={(primary ? 'sn-primary' : 'sn-button') + ' pos-big-choice'}
      {...(primary ? { 'data-primary': 'true' } : {})}
      disabled={busy || noVans}
      onClick={() => pickDriver(next)}
    >
      <span>{driverName(next)}</span>
      <small>{say('startDriverNote')}</small>
    </button>
  );
  // 휴대폰 폭에서 차량이 없으면 주 버튼이 없다(누를 수 없는 주 버튼을 두지 않고, 카운터를 기사 색으로 칠하지 않는다: 한 줄이 까닭을 말한다).
  const buttons = driverFirst
    ? [driver('driver_phone', !noVans), driver('driver_tablet', false), counter(false)]
    // 기사 휴대폰이 기사 태블릿보다 먼저: 첫 매장 기사의 주 기기는 개인 휴대폰이다(처음 화면과 같은 차례).
    : [counter(true), driver('driver_phone', false), driver('driver_tablet', false)];
  const shownLine = line ?? (noVans ? say('noVehicles') : null);
  return (
    <div className="pos-plain">
      <main className="pos-card pos-choose">
        <h1 className="pos-card-title">{say('chooseTitle')}</h1>
        {shownLine ? <p className="pos-card-line pos-choose-note" role="status">{shownLine}</p> : null}
        <div className="pos-card-choices">{buttons}</div>
      </main>
    </div>
  );
}

/** 차량 선택: 차량 타일(잰 폭 · 높이로 칸 · 쪽), 바닥줄에 `이전`과 쪽 넘김. */
function VehicleStep({ kindName, vehicles, line, busy, onPick, onBack }: {
  kindName: string;
  vehicles: readonly EnrollVehicle[];
  line: string | null;
  busy: boolean;
  onPick: (vehicleId: string) => void;
  onBack: () => void;
}) {
  const profile = useDeviceProfile();
  const boxRef = useRef<HTMLDivElement>(null);
  const box = useElementSize(boxRef);
  const [page, setPage] = useState(0);
  // 타일은 로그인 타일과 같은 크기(높이 plain.choicePx, 가장 작은 폭은 그 세 배).
  const grid = box ? staffGrid(box, { heightPx: profile.plain.choicePx, minWidthPx: profile.plain.choicePx * 3, gapPx: profile.space.s }) : null;
  const pageCount = grid ? Math.max(1, Math.ceil(vehicles.length / grid.perPage)) : 1;
  const current = Math.min(page, pageCount - 1);
  const shown = grid ? vehicles.slice(current * grid.perPage, (current + 1) * grid.perPage) : [];
  return (
    <div className="pos-plain">
      <main className="pos-card pos-choose pos-choose-vehicles">
        <h1 className="pos-card-title">{say('chooseVehicleTitle')}</h1>
        <p className="pos-card-line">{kindName}</p>
        {line ? <p className="pos-card-line pos-choose-note" role="status">{line}</p> : null}
        <div
          ref={boxRef}
          className="pos-choose-tiles"
          style={grid ? { gridTemplateColumns: 'repeat(' + grid.columns + ', minmax(0, 1fr))' } : undefined}
        >
          {shown.map((vehicle, i) => (
            <button key={vehicle.id + ':' + i} type="button" className="sn-button pos-choose-tile" disabled={busy} onClick={() => onPick(vehicle.id)}>
              <TextFit input={{ mode: 'alts', alts: [vehicle.name] }} lines={2} />
            </button>
          ))}
        </div>
        <div className="pos-choose-foot">
          <button type="button" className="sn-button" disabled={busy} onClick={onBack}>{say('back')}</button>
          {pageCount > 1 ? <Pager page={current} pageCount={pageCount} onChange={setPage} /> : null}
        </div>
      </main>
    </div>
  );
}
