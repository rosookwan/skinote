// 로그인(계획 work/impl-server/plan.md 6-3): 종이 한 장에 `로그인` · 매장 이름과 직원 타일(잰 높이로 쪽을 나누고 바닥에 `‹ 1 / 2쪽 ›`).
// 타일을 누르면 비밀번호 숫자판(아래 판, 가린 표시 ● ● ● ●, 제목 `{이름} · 비밀번호`)이 올라온다. 보내는 동안은 판에 `처리 중`,
// 틀리면 판 안에 한 줄(`비밀번호 불일치 · 재입력 필요`). 잠기면 `로그인 잠김 · 16:40 이후 가능`이 그 시각까지 남고 `입력`을 누를 수
// 없다(숫자를 눌러도 줄이 사라지지 않는다 — 풀리는 시각을 잃지 않게). 다른 사람 타일을 고르거나 시각이 지나면 풀린다.
// 직원 목록 · 보내기는 부르는 쪽(session.tsx)이 한다. 시험 매장의 열린 등록으로 스스로 붙은 기기면 매장 이름 줄에 기기 종류 · 차량을
// 더하고(`시험 매장 · 기사 휴대폰 · 1호 차량`) 바닥줄에 `기기 선택`(보통 버튼: 이 기기의 등록을 끊고 기기 선택으로)을 둔다.
// 체험판 미리 보기(#/preview/login)가 같은 화면을 예시 이름으로 그린다.
import type { StaffTile } from '@skinote/contract';
import { cardColumns } from '@skinote/layout';
import { NumberPad, Pager, TextFit, t, useDeviceProfile, useElementSize } from '@skinote/ui';
import { useEffect, useRef, useState } from 'react';
import { say } from '../app/strings.ts';

export interface LoginScreenProps {
  shopName: string;
  /** 직원 타일(기사 기기는 기사가 먼저). 아직 모르면 null. */
  staff: readonly StaffTile[] | null;
  /** 화면의 한 줄(로그인 만료 · 목록 조회 실패). */
  note?: string | null;
  /**
   * 비밀번호를 보낸다. 실패하면 판에 보일 한 줄(잠김이면 풀리는 시각 lockedUntil도), 되면 null(부르는 쪽이 다음 화면으로 간다).
   */
  onPin: (staff: StaffTile, pin: string) => Promise<PinAnswer>;
  /** 스스로 붙은 기기의 모양(`기사 휴대폰 · 1호 차량`): 매장 이름 뒤에 잇는다. */
  deviceLine?: string;
  /** 스스로 붙은 기기만: `기기 선택`(등록을 끊고 기기 선택으로). */
  onChooseDevice?: () => void;
  /** `기기 선택`을 보내는 중. */
  choosing?: boolean;
}

/** 비밀번호 보내기의 답: null = 됨, 글 = 판의 한 줄, 잠김 = 한 줄 + 풀리는 시각(ISO). */
export type PinAnswer = string | { line: string; lockedUntil: string } | null;

/** 타일 칸 · 줄 수(잰 폭 · 높이, 타일 높이 · 가장 작은 폭은 등급 값). 순수 함수(시험). */
export function staffGrid(box: { width: number; height: number }, tile: { heightPx: number; minWidthPx: number; gapPx: number }): { columns: number; rows: number; perPage: number } {
  const columns = cardColumns(box.width, tile.minWidthPx, tile.gapPx);
  const rows = Math.max(1, Math.floor((box.height + tile.gapPx) / (tile.heightPx + tile.gapPx)));
  return { columns, rows, perPage: columns * rows };
}

export function LoginScreen({ shopName, staff, note, onPin, deviceLine, onChooseDevice, choosing = false }: LoginScreenProps) {
  const profile = useDeviceProfile();
  const boxRef = useRef<HTMLDivElement>(null);
  const box = useElementSize(boxRef);
  const [page, setPage] = useState(0);
  const [picked, setPicked] = useState<StaffTile | null>(null);
  const [digits, setDigits] = useState('');
  const [padNote, setPadNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 고른 사람의 잠김이 풀리는 때(ms). 그때까지 줄이 남고 `입력`을 누를 수 없다. */
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  useEffect(() => { document.title = say('titleLogin'); }, []);
  useEffect(() => {
    if (lockedUntil === null) return undefined;
    const timer = setTimeout(() => { setLockedUntil(null); setPadNote(null); }, Math.max(0, lockedUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [lockedUntil]);
  const locked = lockedUntil !== null;

  const tiles = staff ?? [];
  // 타일: 높이는 큰 고르기 버튼(plain.choicePx), 가장 작은 폭은 그 세 배(이름 열 자가 두 줄 안에 든다).
  const grid = box ? staffGrid(box, { heightPx: profile.plain.choicePx, minWidthPx: profile.plain.choicePx * 3, gapPx: profile.space.s }) : null;
  const pageCount = grid ? Math.max(1, Math.ceil(tiles.length / grid.perPage)) : 1;
  const current = Math.min(page, pageCount - 1);
  const shown = grid ? tiles.slice(current * grid.perPage, (current + 1) * grid.perPage) : [];

  const open = (tile: StaffTile) => {
    if (tile.id !== picked?.id) setLockedUntil(null);
    setPicked(tile);
    setDigits('');
    setPadNote(null);
  };
  const submit = (pin: string) => {
    if (!picked || busy || locked) return;
    setBusy(true);
    setPadNote(null);
    onPin(picked, pin).then((answer) => {
      setBusy(false);
      setDigits('');
      if (answer === null) return;
      if (typeof answer === 'string') {
        setPadNote(answer);
        return;
      }
      setPadNote(answer.line);
      const until = Date.parse(answer.lockedUntil);
      if (Number.isFinite(until) && until > Date.now()) setLockedUntil(until);
    }, () => {
      setBusy(false);
      setDigits('');
      setPadNote(say('sendFailed'));
    });
  };

  return (
    <div className="pos-plain">
      <main className="pos-card pos-login">
        <h1 className="pos-card-title">{say('loginTitle')}</h1>
        <p className="pos-card-line">{[shopName, deviceLine].filter(Boolean).join(' · ')}</p>
        {note ? <p className="pos-card-line pos-login-note" role="status">{note}</p> : null}
        <div
          ref={boxRef}
          className="pos-login-tiles"
          style={grid ? { gridTemplateColumns: 'repeat(' + grid.columns + ', minmax(0, 1fr))' } : undefined}
        >
          {shown.map((tile, i) => (
            <button key={tile.id + ':' + i} type="button" className="sn-button pos-login-tile" onClick={() => open(tile)}>
              <TextFit input={{ mode: 'alts', alts: [tile.name] }} lines={2} />
            </button>
          ))}
        </div>
        {pageCount > 1 || onChooseDevice ? (
          <div className={'pos-login-pager' + (onChooseDevice ? ' pos-login-foot' : '')}>
            {onChooseDevice ? (
              <button type="button" className="sn-button pos-login-choose" disabled={choosing || busy} onClick={onChooseDevice}>{say('chooseTitle')}</button>
            ) : null}
            {pageCount > 1 ? <Pager page={current} pageCount={pageCount} onChange={setPage} /> : null}
          </div>
        ) : null}
      </main>
      {picked ? (
        <NumberPad
          mode="pin"
          title={say('pinPadTitle', { name: picked.name })}
          value={digits}
          onChange={(value) => { setDigits(value); if (padNote && !locked) setPadNote(null); }}
          onSubmit={submit}
          onClose={() => { setPicked(null); setDigits(''); if (!locked) setPadNote(null); }}
          accept={() => !busy && !locked}
          {...(busy ? { note: t('processing') } : padNote ? { note: padNote } : {})}
        />
      ) : null}
    </div>
  );
}
