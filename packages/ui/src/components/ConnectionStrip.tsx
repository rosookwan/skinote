// 연결 띠(ui 5 ConnectionStrip, work/impl-offline/plan.md §8-1): 기사 기기의 32px 띠. 쪽 높이에 센다. 늦음이 아니므로 빨강을 쓰지 않는다.
// 보일지 말지는 connectionStripVisible로 화면 틀이 먼저 알고 쪽 높이에서 뺀다. 상태마다 한 줄(좁으면 뒤 조각부터 빠진다):
//   - 끊김: `연결 끊김 · 전송 대기 3 · 마지막 연결 21:40`(대기가 없으면 `연결 끊김 · 마지막 연결 21:40`), 저장할 곳이 없는 기기는 `연결 끊김 ·
//     이 기기 저장 불가 · …`.
//   - 보내는 중(2초 넘게): `전송 중 · 전송 대기 12`(바닥줄 · 탭의 `잔여`와 겹치지 않게, §17 R3-20).
//   - 연결되었지만 보내지 못한 것이 남음(서버 오류 뒤 기다림 · 혼자도 못 보내는 항목): `전송 대기 2`.
//   - 다시 붙어 보낸 뒤(2분 또는 다음 창까지): `전송 대기 0`, 답에 줄 메모가 붙은 기록이 있으면 `· 매장 반납 완료 1팀` · …(§17 R3-26).
//   - 답을 잃었다가 다시 보낸 온라인 명령이 받아들여지지 않음: 무엇이 안 되었는지 `처리 실패 · 현금 인계 350,000원 · 매장 확인`(§18 R4-15, 여럿이면
//     뒤의 것부터 · 돈부터 빠진다). 일 이름을 모르는 옛 모양은 `전송 실패 · 재전송 필요`(§17 R3-5).
//   - 저장할 곳이 없는 기기(연결됨): `이 기기 저장 불가`(§17 R3-25).
// 상태마다 모양이 다르다(§17 R3-21): 끊김은 진한 노랑 테두리, 보낸 뒤는 차분한 초록, 보내지 못함 · 거절은 주황 옅은 바탕, 저장할 곳 없음은 회색 바탕과
// 테두리. 빨강은 없다.
// 보내기가 막 시작된 2초 동안(flushing)은 그리지 않는다: 연결된 채 누른 도장이 실선이 되는 1초 사이에 띠가 깜빡이지 않게.
import type { ConnectionState } from '@skinote/contract';
import type { TextPart } from '@skinote/layout';
import { useUi } from '../context.tsx';
import { formatTime } from '../format.ts';
import { t } from '../strings.ko-KR.ts';
import { TextFit } from './TextFit.tsx';

/** 연결되어 있는데 보내지 못한 것이 남아 띠를 그릴지(보내는 중 2초 전은 그리지 않는다). */
const waitingOnline = (state: ConnectionState) => state.online && state.pendingCount > 0 && !state.flushing;

/** 띠가 보이는지: 끊겼거나, 보내는 중(2초 넘게) · 보내지 못한 것이 남음 · 보낸 뒤 결과 · 거절 · 저장할 곳 없음일 때. */
export function connectionStripVisible(state: ConnectionState): boolean {
  return !state.online || state.sending !== undefined || waitingOnline(state) || state.settled === true || state.recordingOff === true || (state.refusedCount ?? 0) > 0;
}

/** 띠의 모양(부품 클래스): 끊김 · 보내는 중 · 보내지 못함 · 거절 · 저장할 곳 없음 · 보낸 뒤. */
export type StripTone = 'offline' | 'sending' | 'stuck' | 'refused' | 'recording-off' | 'settled';

/** 띠의 모양(순수 함수, 시험). 보이지 않으면 null. */
export function connectionStripTone(state: ConnectionState): StripTone | null {
  if (!connectionStripVisible(state)) return null;
  if (!state.online) return 'offline';
  if (state.sending) return 'sending';
  if (waitingOnline(state)) return 'stuck';
  if ((state.refusedCount ?? 0) > 0) return 'refused';
  if (state.recordingOff) return 'recording-off';
  return 'settled';
}

/** 띠의 조각(순수 함수, 시험). 좁으면 drop이 큰 조각부터 빠진다. */
export function connectionStripParts(state: ConnectionState, timezone: string): TextPart[] {
  const tone = connectionStripTone(state);
  if (tone === null) return [];
  switch (tone) {
    case 'offline':
      return [
        { text: t('offline'), drop: 0 },
        ...(state.pendingCount > 0 ? [{ text: t('pendingCount', { n: state.pendingCount }), drop: 0 }] : []),
        ...(state.recordingOff ? [{ text: t('recordingOff'), drop: 1 }] : []),
        ...(state.lastSyncAt ? [{ text: t('lastSync', { time: formatTime(state.lastSyncAt, timezone) }), drop: 2 }] : []),
      ];
    case 'sending':
      return [{ text: t('sendingCount', { n: state.sending!.remaining }), drop: 0 }];
    case 'stuck':
      return [{ text: t('pendingCount', { n: state.pendingCount }), drop: 0 }, ...(state.recordingOff ? [{ text: t('recordingOff'), drop: 1 }] : [])];
    case 'refused': {
      const list = state.refused ?? [];
      if (list.length === 0) return [{ text: t('sendFailedLine'), drop: 0 }];
      // 사실 `처리 실패` · 일마다 한 조각(`현금 인계 350,000원`, 좁으면 뒤의 것부터 · 돈부터) · 할 일 `매장 확인`. 이름 뒤에 글을 붙이지 않는다
      // (`후불 처리` + `처리 실패`가 겹치지 않게).
      return [
        { text: t('failedHead'), drop: 0 },
        ...list.map((r, i) => ({
          text: r.money ? r.what + ' ' + r.money : r.what, drop: i + 1,
          ...(r.money ? { short: r.what } : {}),
        })),
        { text: t('storeCheck'), drop: 0 },
      ];
    }
    case 'recording-off':
      return [{ text: t('recordingOff'), drop: 0 }];
    case 'settled':
      return [
        { text: t('pendingCount', { n: 0 }), drop: 0 },
        ...(state.settledNotes ?? []).map((n, i) => ({ text: t('settledNote', { note: n.note, n: n.count }), drop: i + 1 })),
      ];
  }
}

export function ConnectionStrip(state: ConnectionState) {
  const { timezone } = useUi();
  const tone = connectionStripTone(state);
  if (tone === null) return null;
  const parts = connectionStripParts(state, timezone);
  return (
    <div className={'sn-strip is-' + tone} data-tone={tone} role="status" aria-live="polite">
      <TextFit input={{ mode: 'parts', parts }} />
    </div>
  );
}
