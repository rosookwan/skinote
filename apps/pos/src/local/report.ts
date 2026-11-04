// 기기가 서버에 알리는 것(work/impl-offline/plan.md §4-1 DeviceReport, O11): 심장 박동 · 사본 받기 · 묶음 · 전달마다 싣는다. 개인정보는 없다(수 ·
// 번호 · 시각 · 판만). 카운터는 이것으로 차량의 연결(끊김 · 전송 대기 · 조용함)을 보고, 마감은 전송 대기가 남은 차량을 막는다.
import { BATCH_LIMITS, type DeviceReport } from '@skinote/contract';
import type { QueueItem } from './queue.ts';

export interface ReportInput {
  items: readonly QueueItem[];
  /** 이 기기가 준 가장 큰 번호. */
  lastSeq: number;
  clockOffsetMs: number;
  appVersion: string;
  offlineCapable: boolean;
  localFirst: boolean;
  visibility: 'visible' | 'hidden';
  unreadable: number;
  /** 이 앱 판에서 혼자 보내도 거절되는 항목이 있는지 볼 판. */
  currentVersion?: string;
  copy?: { epoch: string; rev: number };
  /**
   * 보낸 뒤 답을 잃은 온라인 명령(매장 입고 · 현금 인계 · 후불 처리 …, 기기 벽시계의 때): 결과 확인 중인 기록이라 카운터의 차량 표시 · 마감의
   * 전송 대기에 센다(§18 R4-4).
   */
  onlinePending?: readonly { at: number }[];
}

/** 앱 판(40자, [A-Za-z0-9._-]): 서버의 검사와 같은 모양으로 줄인다. */
export function appVersionOf(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40) || 'dev';
}

/** 알리는 시계 차이의 한도(선의 모양 ±366일): 더 틀린 시계도 알림이 거절되지 않게 자른다. 서버는 여전히 시계 확인으로 본다(§18 R4-8). */
const OFFSET_MAX = BATCH_LIMITS.ageMsMax;

export function deviceReport(input: ReportInput): DeviceReport {
  const waiting = input.items.filter((i) => i.state !== 'answered');
  const online = input.onlinePending ?? [];
  const offset = Number.isFinite(input.clockOffsetMs) ? Math.max(-OFFSET_MAX, Math.min(OFFSET_MAX, Math.round(input.clockOffsetMs))) : 0;
  const oldest = [...waiting.map((i) => i.createdWall + i.offsetAtCreate), ...online.map((p) => p.at + offset)]
    .reduce<number | undefined>((min, at) => (min === undefined ? at : Math.min(min, at)), undefined);
  const stuck = waiting.filter((i) => i.stuckVersion !== undefined && i.stuckVersion === (input.currentVersion ?? input.appVersion)).map((i) => i.seq).sort((a, b) => a - b)[0];
  return {
    pendingCount: waiting.length + online.length,
    unconfirmedCount: waiting.filter((i) => i.state === 'unconfirmed').length + online.length,
    ...(oldest !== undefined && Number.isFinite(oldest) ? { oldestPendingAt: new Date(oldest).toISOString() } : {}),
    lastSeq: Math.max(0, Math.floor(input.lastSeq)),
    clockOffsetMs: offset,
    appVersion: appVersionOf(input.appVersion),
    offlineCapable: input.offlineCapable,
    localFirst: input.localFirst,
    visibility: input.visibility,
    unreadable: input.unreadable,
    ...(stuck !== undefined ? { stuckSeq: stuck } : {}),
    ...(input.copy ? { copy: input.copy } : {}),
  };
}
