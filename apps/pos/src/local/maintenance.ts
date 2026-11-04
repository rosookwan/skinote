// 기기의 지움 시계(work/impl-offline/plan.md O14 · §7-6): 시작할 때와 1분마다. 보냄 대기는 어떤 시계로도 지우지 않는다(sync 8-5).
//   (a) 마지막 서버 연결 뒤 pii_wipe_hours(기사 24시간)가 지나면 사본의 이름 · 전화를 비운다(끝 4자리는 남김). 새 사본 열쇠로 다시 봉인하고 옛 열쇠를
//       지운다(O13). 다음 연결은 known 없이 사본을 통째로 받는다.
//   (b) 영업일 기준 시각(06:00)을 넘기면 사본을 새 영업일로 다시 좁힌다(도메인 vehicleScope): 끝난 업무의 접수는 빠지고, 보냄 대기 항목이 가리키는
//       접수는 남는다. 오늘 열린 업무가 아닌 접수의 번호는 가린다.
//   (f) 보낸 기록은 sent_log_days(7일) 뒤 지우고, sent_pii_hours(24시간) 뒤 개인정보 칸을 뺀다.
//   (g) 시계 톱니: 본 가장 늦은 벽시계보다 clock_warn_minutes 넘게 뒤면 벽시계가 뒤로 간 것이다: 사본의 이름 · 전화를 비운다(보냄 대기는 남김).
import { PII_KEYS, type OfflinePolicy } from '@skinote/contract';
import { vehicleScope, type ShopState } from '@skinote/domain';
import { localBusinessDate, ratchet } from './clock.ts';
import type { CopyBody, LocalStore } from './local-store.ts';
import type { SendQueue } from './queue.ts';

export interface MaintenanceResult {
  scrubbed: boolean;
  /** 06:00을 넘겨 다시 좁힌 사본의 새 영업일. */
  rolledTo?: string;
  removedSent: number;
  strippedSent: number;
  /** 벽시계가 뒤로 감(기억한 세션을 믿지 않는다). */
  wentBack: boolean;
}

/** 개인정보 칸(PII_KEYS)의 글을 비운다(깊이, 자리에서). */
function blankPii(value: unknown): void {
  if (Array.isArray(value)) {
    for (const v of value) blankPii(v);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  for (const [k, v] of Object.entries(record)) {
    if (PII_KEYS.has(k) && typeof v === 'string') record[k] = '';
    else blankPii(v);
  }
}

/** 사본의 이름 · 전화 · 메모를 비운다(끝 4자리는 남김): 새 사본(입력은 그대로). 접수 · 긴급 요청만(직원 표는 세션 자신 한 줄). */
export function scrubState(state: ShopState): ShopState {
  const next = structuredClone(state);
  blankPii(next.orders);
  blankPii(next.pins);
  return next;
}

export interface MaintenanceDeps {
  local: LocalStore;
  queue: SendQueue;
  staffId: string;
  /** 기기 벽시계(ms). */
  wallNow(): number;
  /** 서버 시각 짐작(ms). */
  serverNow(): number;
  /** 사본이 없을 때의 운영 값. */
  policy(): OfflinePolicy | null;
}

const HOUR = 3_600_000;
const MINUTE = 60_000;

export class Maintenance {
  private readonly d: MaintenanceDeps;

  constructor(deps: MaintenanceDeps) {
    this.d = deps;
  }

  async run(): Promise<MaintenanceResult> {
    const { local, queue } = this.d;
    const wall = this.d.wallNow();
    const out: MaintenanceResult = { scrubbed: false, removedSent: 0, strippedSent: 0, wentBack: false };
    const meta = await local.readMeta();
    const read = await local.readCopy();
    const policy = (read.status === 'none' ? null : read.head.policy) ?? this.d.policy();
    const warnMs = (policy?.clockWarnMinutes ?? 2) * MINUTE;
    // (g) 시계 톱니.
    const tick = ratchet(meta.maxSeenWall, wall, warnMs);
    out.wentBack = tick.wentBack;
    await local.patchMeta({ maxSeenWall: tick.maxSeenWall });
    if (read.status === 'ok') {
      let body: CopyBody = read.body;
      let head = read.head;
      let dirty = false;
      // (b) 06:00 넘기기: 새 영업일로 다시 좁힌다(보냄 대기 항목의 접수는 남긴다).
      const today = localBusinessDate(body.state, this.d.serverNow());
      if (today > head.businessDate) {
        const { items } = await queue.list();
        const pendingTaskIds = [...new Set(items.map((i) => i.taskId).filter((t): t is string => typeof t === 'string'))];
        // 가진 사본의 접수는 모두 이 기기에 온 것이다(옮겨진 업무의 대기 항목도 남긴다, §17 R3-8).
        const knownOrderIds = new Set(body.state.orders.map((o) => o.id));
        const state = vehicleScope({ ...body.state, businessDate: today }, head.vehicleId, { staffId: this.d.staffId, pendingTaskIds, knownOrderIds, today });
        body = { ...body, state: head.scrubbed ? scrubState(state) : state };
        head = { ...head, businessDate: today };
        out.rolledTo = today;
        dirty = true;
      }
      // (a) · (g) 이름 · 전화 지움.
      const wipeMs = (policy?.piiWipeHours ?? 24) * HOUR;
      const since = meta.lastContactAt ?? head.storedAt;
      if (!head.scrubbed && (wall - since >= wipeMs || tick.wentBack)) {
        body = { ...body, state: scrubState(body.state) };
        head = { ...head, scrubbed: true };
        out.scrubbed = true;
        dirty = true;
      }
      // 새 사본 열쇠로 다시 봉인(옛 열쇠를 지운다, O13). 보냄 대기는 건드리지 않는다. 그사이 새 사본이 왔으면 쓰지 않는다(다음 분에 다시 본다).
      if (dirty && !(await local.writeCopy(head, body, undefined, { ifSame: read.head }))) {
        out.scrubbed = false;
        delete out.rolledTo;
      }
    }
    // (f) 보낸 기록.
    const pruned = await queue.pruneSent(wall, policy?.sentLogDays ?? 7, policy?.sentPiiHours ?? 24);
    out.removedSent = pruned.removed;
    out.strippedSent = pruned.stripped;
    return out;
  }
}
