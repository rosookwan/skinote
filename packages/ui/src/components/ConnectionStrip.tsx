// 연결 띠(ui 5 ConnectionStrip): 오프라인이면 32px 띠 '연결 끊김 · 보냄 대기 3 · 마지막 맞춤 21:40'. 쪽 높이에 센다.
// 늦음이 아니므로 빨강을 쓰지 않는다. 보일지 말지는 connectionStripVisible로 화면 틀이 먼저 알고 쪽 높이에서 뺀다.
import type { ConnectionState } from '@skinote/contract';
import { useUi } from '../context.tsx';
import { formatTime } from '../format.ts';
import { t } from '../strings.ko-KR.ts';
import { TextFit } from './TextFit.tsx';

/** 띠가 보이는지: 끊겼거나, 아직 보내지 못한 것이 있을 때. */
export function connectionStripVisible(state: ConnectionState): boolean {
  return !state.online || state.pendingCount > 0;
}

export function ConnectionStrip(state: ConnectionState) {
  const { timezone } = useUi();
  if (!connectionStripVisible(state)) return null;
  const parts = [
    ...(state.online ? [] : [{ text: t('offline'), drop: 0 }]),
    ...(state.pendingCount > 0 ? [{ text: t(state.online ? 'sendingCount' : 'pendingCount', { n: state.pendingCount }), drop: 0 }] : []),
    ...(state.lastSyncAt ? [{ text: t('lastSync', { time: formatTime(state.lastSyncAt, timezone) }), drop: 1 }] : []),
  ];
  return (
    <div className={'sn-strip' + (state.online ? '' : ' is-offline')} role="status" aria-live="polite">
      <TextFit input={{ mode: 'parts', parts }} />
    </div>
  );
}
