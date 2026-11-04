// 카운터가 보는 차량 연결(work/impl-offline/plan.md O11 · §5-6): 서버의 기기 연결 셈(vehicleLinks)을 읽기 모델의 한 줄로. 화면은 셈하지 않는다.
//   - 수거 목록 제목 줄 표시: 끊김 `1호 차량 연결 끊김` · `21:40부터` · `전송 대기 3`(알린 수만), 전송 대기(약한 신호) `1호 차량 기록 3건 전송 대기` ·
//     `21:40부터`. 좁으면 뒤 조각부터 빠진다.
//   - 일정 변경 · 긴급 요청의 경고: 끊김 `… 연결 끊김 · 21:40부터 · 수거 여부 미확인`(결정 25), 전송 대기 `… 기록 3건 전송 대기 · 21:40부터 · 수거 여부
//     미확인`, 조용함(주머니 속 휴대폰) `… 마지막 연결 21:40 · 수거 여부 미확인`.
// 문구는 docs/design/wording.md 3-21(확인 대기).
import type { FitPart, VehicleLink } from '@skinote/contract';
import type { ShopState } from './model.ts';
import { vehicleLabel } from './rules.ts';
import { hm } from './time.ts';

/** 차량의 연결(없으면 undefined). */
export const linkOf = (links: readonly VehicleLink[] | undefined, vehicleId: string | undefined): VehicleLink | undefined =>
  vehicleId === undefined ? undefined : links?.find((l) => l.vehicleId === vehicleId);

const timeOf = (iso: string | undefined): string | undefined => {
  const ms = iso === undefined ? Number.NaN : Date.parse(iso);
  return Number.isFinite(ms) ? hm(ms) : undefined;
};

/** 수거 목록 제목 줄의 표시(끊김 · 전송 대기만). */
export function linkChipParts(state: ShopState, link: VehicleLink | undefined): FitPart[] | undefined {
  if (!link || (link.state !== 'offline' && link.state !== 'stuck')) return undefined;
  const vehicle = vehicleLabel(state.registry, link.vehicleId);
  const since = timeOf(link.since);
  const pending = link.reportedPending !== null && link.reportedPending > 0 ? link.reportedPending : null;
  if (link.state === 'stuck' && pending !== null) {
    return [{ text: vehicle + ' 기록 ' + pending + '건 전송 대기', drop: 0 }, ...(since ? [{ text: since + '부터', drop: 1 }] : [])];
  }
  return [
    { text: vehicle + ' 연결 끊김', drop: 0 },
    ...(since ? [{ text: since + '부터', drop: 1 }] : []),
    ...(pending !== null ? [{ text: '전송 대기 ' + pending, drop: 2 }] : []),
  ];
}

/**
 * 장부 제목 줄의 표시(§17 R3-23): 끊기거나 전송 대기인 차량을 모두(끊김이 먼저, 같으면 차량 차례, §18 R4-16). 차량마다 사실 조각(`1호 차량 연결 끊김` ·
 * `2호 차량 기록 1건 전송 대기`)은 빠지지 않고, 좁으면 뒤 차량의 시각 · 수부터 빠진다. 문제가 없으면 undefined. 차량 id는 가장 나쁜 차량.
 */
export function vanLinksChip(state: ShopState, links: readonly (VehicleLink | undefined)[]): { vehicleId: string; parts: FitPart[] } | undefined {
  const rank = (l: VehicleLink) => (l.state === 'offline' ? 0 : 1);
  const bad = links
    .map((link, i) => ({ link, i, parts: linkChipParts(state, link) }))
    .filter((x): x is { link: VehicleLink; i: number; parts: FitPart[] } => x.link !== undefined && x.parts !== undefined)
    .sort((a, b) => rank(a.link) - rank(b.link) || a.i - b.i);
  const first = bad[0];
  if (!first) return undefined;
  if (bad.length === 1) return { vehicleId: first.link.vehicleId, parts: first.parts };
  // 여럿: 사실 조각은 모두 남기고(drop 0), 시각 · 수는 뒤 차량의 것부터 빠진다.
  const parts = bad.flatMap((x, n) => x.parts.map((p) => (p.drop === 0 ? p : { ...p, drop: p.drop + (n + 1) * 10 })));
  return { vehicleId: first.link.vehicleId, parts };
}

/** 일정 변경 · 긴급 요청의 경고(끊김 · 전송 대기 · 조용함). 연결이 괜찮으면 undefined. */
export function linkWarningParts(state: ShopState, link: VehicleLink | undefined): FitPart[] | undefined {
  if (!link) return undefined;
  const vehicle = vehicleLabel(state.registry, link.vehicleId);
  const unknown = { text: '수거 여부 미확인', drop: 0 };
  if (link.state === 'offline' || link.state === 'stuck') {
    const since = timeOf(link.since);
    const pending = link.reportedPending !== null && link.reportedPending > 0 ? link.reportedPending : null;
    const fact = link.state === 'stuck' && pending !== null ? vehicle + ' 기록 ' + pending + '건 전송 대기' : vehicle + ' 연결 끊김';
    return [{ text: fact, drop: 0 }, ...(since ? [{ text: since + '부터', drop: 1 }] : []), unknown];
  }
  if (link.state === 'asleep') {
    const last = timeOf(link.lastContactAt ?? link.since);
    return [{ text: vehicle + (last ? ' 마지막 연결 ' + last : ' 연결 끊김'), drop: 0 }, unknown];
  }
  return undefined;
}

/** 조각들을 한 줄 글로(요약 줄이 글 목록인 창). */
export const partsText = (parts: readonly FitPart[]): string => parts.map((p) => p.text).join(' · ');
