// 사본 받기(work/impl-offline/plan.md O4 · §4-2): POST api/v2/snapshot. 한 화면에 하나씩(그리고 기기에 하나씩: Web Lock 'skinote-snapshot').
//   - 도는 동안 온 요청은 하나로 묶어 끝난 뒤 적어도 2초 뒤에 한 번 더(SNAPSHOT_LIMITS.minGapMs). 이 기기의 묶음 · 온라인 명령 바로 뒤의 새로 받기는
//     (urgent) 도는 것이 없으면 곧바로.
//   - 저장은 (epoch, rev)가 가진 것보다 새것일 때만: epoch는 ULID 글자 차례, 같으면 rev. 새 epoch는 부르는 쪽(onEpoch)이 기기 메모의 epoch와 견준
//     뒤에만(복구면 보낸 기록 되돌리기 O20, 새로 만들기면 옛 답 정리, §17 R3-1 · R3-3). 사본이 없어도 견준다.
//   - recorded(이 기기 번호 ≥ fromSeq, 사본과 같은 읽기)에 든 보냄 대기 항목은 사본을 쓰는 트랜잭션에서 보낸 기록으로 옮긴다: 그 사본이 이미 담았다.
//     rev를 비교하지 않으므로 늦게 온 · 복구 뒤의 rev가 항목을 떨어뜨리지 않는다.
//   - 같은 해시(unchanged)면 머리의 rev · 운영 값만 바꾼다. 24시간 지움을 한 사본은 known을 보내지 않아 통째로 다시 받는다.
import {
  SNAPSHOT_LIMITS, type DeviceReport, type SnapshotRequest, type SnapshotResponse, type UiConfig,
} from '@skinote/contract';
import type { ShopState } from '@skinote/domain';
import type { PostAnswer } from '../app/http-client.ts';
import { COPY_FMT, STATE_VERSION, type CopyHead, type LocalStore } from './local-store.ts';
import type { SendQueue } from './queue.ts';

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** 사본 판의 차례: 음수면 a가 옛것. epoch는 ULID 글자 차례, 같으면 rev. */
export function compareCopy(a: { epoch: string; rev: number }, b: { epoch: string; rev: number }): number {
  if (a.epoch !== b.epoch) return a.epoch < b.epoch ? -1 : 1;
  return a.rev - b.rev;
}

export interface StoredInfo {
  response: SnapshotResponse;
  /** 본문이 새로 쓰였는지(목록이 다시 그려질 것). */
  changed: boolean;
  /** epoch가 바뀌었는지(복구). */
  epochChanged: boolean;
}

export interface SnapshotDeps {
  local: LocalStore;
  queue: SendQueue;
  appVersion: string;
  post(body: SnapshotRequest, timeoutMs: number): Promise<PostAnswer<SnapshotResponse>>;
  report(): Promise<DeviceReport>;
  /** 답을 잃은 온라인 명령의 요청번호(O18). */
  onlinePending(): Promise<string[]>;
  onStored(info: StoredInfo): Promise<void> | void;
  /**
   * 받은 사본의 epoch를 쓰기 전에(사본이 없어도 늘, §17 R3-3): 부르는 쪽이 기기 메모의 epoch와 견주어 복구면 옛 epoch의 기록을 되돌리고(O20),
   * 복구가 아니면 옛 답만 보낸 기록으로 옮긴다(R3-1).
   */
  onEpoch(epoch: string, restoredUpToRev: number | null): Promise<void>;
  onFailure?(answer: PostAnswer<SnapshotResponse>): void;
  timers?: Timers;
  wallNow?: () => number;
  minGapMs?: number;
  timeoutMs?: number;
}

export class SnapshotSync {
  private readonly d: SnapshotDeps;
  private readonly timers: Timers;
  private readonly wallNow: () => number;
  private readonly minGapMs: number;
  private current: Promise<void> | null = null;
  private next: { promise: Promise<void>; resolve: () => void; urgent: boolean } | null = null;
  private timer: unknown = null;
  private lastEnded = Number.NEGATIVE_INFINITY;
  private stopped = false;
  /** 받은 사본 수(시험 · 띠). */
  fetched = 0;

  constructor(deps: SnapshotDeps) {
    this.d = deps;
    this.timers = deps.timers ?? realTimers;
    this.wallNow = deps.wallNow ?? (() => Date.now());
    this.minGapMs = deps.minGapMs ?? SNAPSHOT_LIMITS.minGapMs;
  }

  /** 새로 받기를 청한다. 끝나면(묶인 요청이 끝나면) 풀리는 약속. */
  request(urgent = false): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.next) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => { resolve = r; });
      this.next = { promise, resolve, urgent };
    } else if (urgent) {
      this.next.urgent = true;
    }
    const waiting = this.next.promise;
    this.pump();
    return waiting;
  }

  /** 돌고 있는지(띠 · 새 판 바꾸기). */
  busy(): boolean {
    return this.current !== null;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.next?.resolve();
    this.next = null;
  }

  private pump(): void {
    if (this.stopped || this.current || !this.next) return;
    const wait = this.next.urgent ? 0 : Math.max(0, this.lastEnded + this.minGapMs - this.wallNow());
    if (wait > 0) {
      if (this.timer === null) this.timer = this.timers.setTimeout(() => { this.timer = null; this.pump(); }, wait);
      return;
    }
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
    const job = this.next;
    this.next = null;
    this.current = this.d.local.withLock('skinote-snapshot', () => this.fetchOnce())
      .catch(() => { /* 다음 계기가 다시 받는다 */ })
      .finally(() => {
        this.current = null;
        this.lastEnded = this.wallNow();
        job.resolve();
        this.pump();
      });
  }

  private async fetchOnce(): Promise<void> {
    const { local, queue } = this.d;
    const read = await local.readCopy();
    const head = read.status === 'none' ? null : read.head;
    const readable = read.status === 'ok' ? read : null;
    const { items } = await queue.list();
    const counter = await queue.counter();
    const fromSeq = Math.max(1, items.length ? Math.min(...items.map((i) => i.seq)) : counter.lastSeq + 1);
    // 답을 받지 않은 항목의 업무가 먼저(서버는 알린 대기 수 — 답을 받지 않은 수 — 까지만 남긴다, §17 R3-8): 답을 받은 항목(이 사본의 recorded가
    // 정리한다)이 앞에 서서 아직 보내지 못한 기록의 팀을 사본 밖으로 밀어내지 않게(§18 R4-5).
    const waitingFirst = [...items.filter((i) => i.state !== 'answered'), ...items.filter((i) => i.state === 'answered')];
    const pendingTaskIds = [...new Set(waitingFirst.map((i) => i.taskId).filter((t): t is string => typeof t === 'string'))].slice(0, SNAPSHOT_LIMITS.pendingTaskIds);
    const onlinePending = (await this.d.onlinePending()).slice(0, SNAPSHOT_LIMITS.onlinePending);
    // 열 수 있고 지우지 않은 사본만 known으로 알린다: 24시간 지움을 한 사본(내용이 서버의 해시와 다름) · 열 수 없는 사본 · 모르는 형식은 통째로
    // (화면 설정까지) 다시 받는다.
    const known = readable && !readable.head.scrubbed
      ? { epoch: readable.head.epoch, rev: readable.head.rev, hash: readable.head.hash, configRev: readable.head.configRev } : undefined;
    const body: SnapshotRequest = { ...(known ? { known } : {}), fromSeq, pendingTaskIds, onlinePending, report: await this.d.report() };
    const answer = await this.d.post(body, this.d.timeoutMs ?? 20_000);
    if (answer.kind !== 'ok') {
      this.d.onFailure?.(answer);
      return;
    }
    const r = answer.body;
    this.fetched += 1;
    // 멈춘 뒤에 온 답(로그아웃 · 세션 끝)은 쓰지 않는다: 지운 사본을 되살리지 않게.
    if (this.stopped) return;
    // 가진 것보다 옛 사본(늦게 온 답 · 다른 화면이 더 새것을 씀)은 버린다. 다른 화면이 그사이 쓴 것도 본다.
    const latest = await local.copyHead();
    const mine = latest ?? head;
    if (mine && compareCopy(r, mine) < 0) return;
    const epochChanged = mine !== null && mine.epoch !== r.epoch;
    await this.d.onEpoch(r.epoch, r.restoredUpToRev);
    const now = this.wallNow();
    const settle = (t: Parameters<SendQueue['settleInTx']>[0]) => queue.settleInTx(t, r.recorded, r.epoch, now);
    const nextHead: CopyHead = {
      fmt: COPY_FMT, appVersion: this.d.appVersion, stateVersion: STATE_VERSION, epoch: r.epoch, rev: r.rev, hash: r.hash, configRev: r.configRev,
      vehicleId: r.scope.vehicleId, businessDate: r.scope.businessDate, cutoff: r.scope.cutoff, storedAt: now, scrubbed: false, policy: r.policy,
      restoredUpToRev: r.restoredUpToRev,
    };
    let changed = false;
    if (r.unchanged && readable && !epochChanged) {
      if (r.config !== undefined) {
        // 같은 사본 · 새 화면 설정: 본문을 새 설정으로 다시 쓴다.
        await local.writeCopy({ ...nextHead, rev: Math.max(readable.head.rev, r.rev) }, { state: readable.body.state, config: r.config as UiConfig }, settle);
        changed = true;
      } else {
        await local.touchCopy({ rev: Math.max(readable.head.rev, r.rev), configRev: r.configRev, policy: r.policy, restoredUpToRev: r.restoredUpToRev, storedAt: now }, settle);
      }
    } else if (r.state) {
      const config = (r.config as UiConfig | undefined) ?? readable?.body.config;
      // 설정이 없으면(옛 서버 · 가진 설정을 열 수 없음) 받은 사본을 쓰지 않는다: 다음 받기가 known 없이 설정까지 받는다.
      if (config === undefined) return;
      await local.writeCopy(nextHead, { state: r.state as unknown as ShopState, config }, settle);
      changed = true;
    } else {
      return;
    }
    await queue.noteHighWater(r.device.highWater);
    if (r.device.missing.length) await queue.resendMissing(r.device.missing, r.epoch);
    await this.d.onStored({ response: r, changed, epochChanged });
    if (r.recordedMore) void this.request(true);
  }
}
