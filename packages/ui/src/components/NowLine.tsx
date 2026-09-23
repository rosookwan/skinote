// 지금 줄(ui 5 NowLine, A1): 시각순 줄 사이의 노란 줄 '지금 15:40'. 줄을 덮지 않고 24px 구분선으로 쪽 높이에 센다.
// 야간 반납 타임 60분 전(설정)부터는 '야간 수거 준비 · 설천 주차장 12팀'을 함께 적는다. 앞쪽(이전 쪽)에 늦은 줄이 있으면
// 끝에 '앞쪽에 늦은 팀 5'를 늦음 색으로 적는다(늦은 것이라 빨강이 허락된다). 누르는 곳이 아니다(줄 높이 24px): ‹를 누른다.
import type { NightPrepNotice } from '@skinote/contract';
import { useUi } from '../context.tsx';
import { formatTime } from '../format.ts';
import { t } from '../strings.ko-KR.ts';
import { TextFit } from './TextFit.tsx';

export interface NowLineProps {
  nowMs: number;
  /** 안내가 보일 때만(서버가 시작 시각을 정해 준다). */
  nightPrep?: NightPrepNotice | null;
  /** 표 안에 그릴 때 칸 수. 없으면 한 덩이 띠. */
  colSpan?: number;
  /** 앞쪽 쪽들에 있는 늦은 줄 수(0이면 적지 않음). */
  lateBefore?: number;
}

export function NowLine({ nowMs, nightPrep, colSpan, lateBefore = 0 }: NowLineProps) {
  const { timezone } = useUi();
  const band = (
    <div className="sn-now-band">
      <span className="sn-now-label">{t('now', { time: formatTime(nowMs, timezone) })}</span>
      {nightPrep ? <TextFit className="sn-now-note" input={{ mode: 'parts', parts: [{ text: t('nightPrep', { place: nightPrep.placeLabel, n: nightPrep.teams }), drop: 1 }] }} /> : <span className="sn-now-note" />}
      {lateBefore > 0 ? <span className="sn-now-late tone-late">{t('lateBefore', { n: lateBefore })}</span> : null}
    </div>
  );
  if (colSpan === undefined) return <div className="sn-now">{band}</div>;
  return (
    <tr className="sn-now">
      <td colSpan={colSpan}>{band}</td>
    </tr>
  );
}
