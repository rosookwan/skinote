// 보내기(work/impl-offline/plan.md §7-5 · O6 · O18 · O22): 보냄 대기를 묶음(POST api/v2/commands:batch)으로 기기 번호 차례로 보낸다. 산속의 약한
// 신호를 견디는 법:
//   - 연결마다 차례: 심장 박동(epoch 확인, 복구면 되돌리기) → 묶음들 → (다 보내면) 사본 새로 받기. 한 기기에 보내는 쪽은 하나(Web Lock
//     'skinote-flush'), 한 번에 한 묶음. 묶음의 답도 epoch를 먼저 본다(연결이 이어진 채 매장이 바뀜, §17-4).
//   - 묶음 크기: 5에서 시작, 2초 안에 답이 오면 두 배(50까지), 답을 잃으면 반(1까지). 400 · 413이면 하나씩, 하나도 400이면 그 항목은 이 앱 판에서
//     건너뛰고(stuckSeq로 알림) 뒤의 것을 보낸다.
//   - 보냈는지 모를 실패(시간 초과 · 끊긴 연결 · 5xx): 그 묶음의 항목은 결과 확인 중(unconfirmed)이 되고 다음 보내기가 같은 요청번호 · 같은 번호로
//     다시 서명해 보낸다(서버는 요청번호로 첫 결과를 준다). 보내기 전부터 네트워크가 없음 · 409 BUSY · 429 · 401은 앞 상태로 되돌린다.
//   - 실패 뒤 기다림: 2 · 4 · 8 · 16 · 30초(±20%), 되면 처음으로. 429는 retry-after.
//   - 답은 왔는데 나아간 것이 없음(항목마다 INTERNAL · BUSY 같은 다시 보낼 결과뿐, §18 R4-2): 실패로 보고 기다린다(같은 항목을 쉬지 않고 다시 보내지
//     않는다). 다시 보낼 결과를 받은 항목은 이번 보내기에서 건너뛰고 뒤의 것을 보낸다.
//   - 이 화면이 보내는 쪽이 된 때(잠금 안) 보내는 중으로 남은 칸은 닫힌 화면이 남긴 것이다: 결과 확인 중으로 바꿔 같은 번호로 다시 보낸다(§18 R4-6).
import type { BatchRequest, BatchResponse, DeviceReport, HeartbeatResponse, QueuedEnvelope } from '@skinote/contract';
import type { PostAnswer } from '../app/http-client.ts';
import { isRetryableResult, type AnswerSummary, type QueueItem, type QueueState, type SendQueue } from './queue.ts';
import { realTimers, type Timers } from './snapshots.ts';

export const FLUSH = Object.freeze({
  startSize: 5,
  maxSize: 50,
  /** 이보다 빨리 답이 오면 묶음을 키운다. */
  fastMs: 2_000,
  batchTimeoutMs: 15_000,
  backoffMs: [2_000, 4_000, 8_000, 16_000, 30_000] as readonly number[],
  jitter: 0.2,
});

export interface FlushResult {
  /** 보낸 항목 수(답을 받은 것). */
  sent: number;
  /** 끊긴 채 만든 · 결과 확인 중이던 항목이 있었는지(띠의 결과 줄). */
  offlineMade: boolean;
  /** applied가 아닌 결과 수. */
  notApplied: number;
}

export interface FlushDeps {
  queue: SendQueue;
  appVersion: string;
  /** 보낼 때의 나이 · 시계 기준으로 서명한 봉투. */
  sign(item: QueueItem): Promise<QueuedEnvelope>;
  report(): Promise<DeviceReport>;
  postBatch(body: BatchRequest, timeoutMs: number): Promise<PostAnswer<BatchResponse>>;
  /** 연결마다 첫 묶음 전의 심장 박동(epoch 확인). */
  heartbeat(): Promise<PostAnswer<HeartbeatResponse>>;
  onHeartbeat(answer: HeartbeatResponse): Promise<void>;
  /**
   * 묶음 답의 epoch를 결과 · 빈 번호보다 먼저 본다(§17-4): 연결이 이어진 채 시험 매장을 새로 만들면 심장 박동 없이 묶음이 새 매장에 닿는다. 옛 epoch의
   * 답을 받은 항목을 먼저 정리해야 새 매장이 알린 빈 번호가 그것을 다시 보내지 않는다(복구면 기준 뒤의 것을 먼저 되돌린다).
   */
  onAnswerEpoch?(answer: BatchResponse): Promise<void>;
  onBatch(answer: BatchResponse, summary: AnswerSummary, sentAt: number, receivedAt: number): Promise<void>;
  /** 보낼 것을 다 보냈다(사본 새로 받기 · 결과 줄). */
  onDrained(result: FlushResult): Promise<void> | void;
  /** 보내는 중 · 남은 수가 바뀜(띠). */
  onChange(): void;
  /** 보내는 쪽은 하나(Web Lock 'skinote-flush'). */
  exclusive?<T>(work: () => Promise<T>): Promise<T>;
  timers?: Timers;
  random?: () => number;
  now?: () => number;
}

/** 실패 뒤 기다림(n번째 실패, ±20%). */
export function backoffDelay(failures: number, random: () => number = Math.random): number {
  const base = FLUSH.backoffMs[Math.min(Math.max(0, failures - 1), FLUSH.backoffMs.length - 1)]!;
  return Math.round(base * (1 + (random() * 2 - 1) * FLUSH.jitter));
}

export class Flusher {
  private readonly d: FlushDeps;
  private readonly timers: Timers;
  private readonly random: () => number;
  private readonly now: () => number;
  private current: Promise<void> | null = null;
  private again = false;
  private timer: unknown = null;
  private stopped = false;
  private epochChecked = false;
  /** 묶음 크기(§7-5). */
  size: number = FLUSH.startSize;
  /** 이어진 실패 수. */
  failures = 0;
  /** 보내기를 시작한 때(도는 동안). */
  private since: number | null = null;
  private offlineMade = false;
  private retryAfterMs: number | null = null;

  constructor(deps: FlushDeps) {
    this.d = deps;
    this.timers = deps.timers ?? realTimers;
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? (() => Date.now());
  }

  /** 보내기를 청한다(도는 중이면 끝난 뒤 한 번 더). 기다림(backoff) 타이머가 있으면 지금 보낸다. */
  kick(): void {
    if (this.stopped) return;
    if (this.current) {
      this.again = true;
      return;
    }
    this.clearTimer();
    const work = () => this.loop();
    const run = this.d.exclusive ? this.d.exclusive(work) : work();
    this.current = run.catch(() => { /* loop가 스스로 적었다 */ }).finally(() => {
      this.current = null;
      if (this.again && !this.stopped) {
        this.again = false;
        this.kick();
      }
    });
  }

  /** 연결이 새로 되었다: 다음 보내기는 심장 박동(epoch 확인)부터. */
  reconnected(): void {
    this.epochChecked = false;
  }

  /** 도는 보내기가 끝날 때까지(묶인 한 번 더 포함). */
  async settle(): Promise<void> {
    while (this.current) await this.current;
  }

  /**
   * 다 보낼 때까지(매장 입고 · 현금 인계 · 로그아웃 전, sync 8-4): timeoutMs 안에서 보내고 남은 대기 수(답을 받은 항목은 세지 않는다)를 돌려준다.
   */
  async drain(timeoutMs: number): Promise<number> {
    // 사람이 기다리는 시간이라 실제 시계로 잰다(기다림 타이머와 따로).
    const deadline = Date.now() + timeoutMs;
    const waitingNow = async () => (await this.d.queue.list()).items.filter((i) => i.state !== 'answered');
    let first = true;
    for (;;) {
      // 처음에는 기다림(backoff)을 건너뛰고 곧바로 보낸다(사람이 눌렀다). 그 뒤에는 실패 뒤 기다림을 지킨다(§18 R4-2: 서버를 쉬지 않고 두드리지 않게).
      if (first || this.timer === null) this.kick();
      first = false;
      // 도는 보내기를 기다리되 남은 시간까지만(§18 R4-2: 보내기가 끝나지 않아도 입고 · 인계 · 로그아웃은 답한다).
      const left0 = deadline - Date.now();
      if (left0 > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          this.settle(),
          new Promise<void>((resolve) => { timer = globalThis.setTimeout(resolve, left0); }),
        ]);
        if (timer !== undefined) globalThis.clearTimeout(timer);
      }
      const waiting = await waitingNow();
      if (waiting.length === 0) return 0;
      const sendable = waiting.some((i) => i.stuckVersion !== this.d.appVersion);
      const left = deadline - Date.now();
      if (!sendable || left <= 0 || this.stopped) return waiting.length;
      await new Promise<void>((resolve) => { globalThis.setTimeout(resolve, Math.min(250, left)); });
    }
  }

  /** 도는 중인지(새 판 바꾸기 · 띠). */
  busy(): boolean {
    return this.current !== null;
  }

  /** 띠: 보내기가 2초 넘게 돌거나 끊긴 채 만든 항목을 보내는 중이면 그때부터. */
  sendingSince(): { since: number; offlineMade: boolean } | null {
    return this.since === null ? null : { since: this.since, offlineMade: this.offlineMade };
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.stopped) return;
    const delay = this.retryAfterMs ?? backoffDelay(this.failures, this.random);
    this.retryAfterMs = null;
    this.clearTimer();
    this.timer = this.timers.setTimeout(() => { this.timer = null; this.kick(); }, delay);
  }

  private async loop(): Promise<void> {
    const { queue } = this.d;
    let failed = false;
    let sent = 0;
    let notApplied = 0;
    let oneByOne = false;
    this.offlineMade = false;
    /** 보내는 중으로 바꾼 묶음(던지면 되돌린다, §17 R3-6): 앞 상태와 보내기를 시작했는지. */
    let inFlight: { previous: Map<string, QueueState>; posted: boolean } | null = null;
    /** 이번 보내기에서 다시 보낼 결과(INTERNAL · BUSY …)를 받은 항목: 이번에는 건너뛰고 기다림 뒤에 다시(§18 R4-2). */
    const deferred = new Set<string>();
    try {
      // 이 화면이 보내는 쪽이다(잠금 안): 보내는 중으로 남은 칸은 보내다 닫힌 화면의 것이다(§18 R4-6).
      await queue.recoverSending();
      for (;;) {
        if (this.stopped) return;
        const { items } = await queue.list();
        const sendable = items.filter((i) => (i.state === 'queued' || i.state === 'unconfirmed') && i.stuckVersion !== this.d.appVersion && !deferred.has(i.requestId));
        if (sendable.length === 0) {
          if (deferred.size > 0) failed = true;
          break;
        }
        if (!this.epochChecked) {
          const beat = await this.d.heartbeat();
          if (beat.kind !== 'ok') {
            failed = true;
            if (beat.kind === 'status' && beat.retryAfterMs) this.retryAfterMs = beat.retryAfterMs;
            break;
          }
          await this.d.onHeartbeat(beat.body);
          this.epochChecked = true;
          continue;
        }
        const batch = sendable.slice(0, oneByOne ? 1 : this.size);
        if (batch.some((i) => i.madeOffline || i.state === 'unconfirmed')) this.offlineMade = true;
        if (this.since === null) {
          this.since = this.now();
          this.d.onChange();
        }
        const previous = new Map<string, QueueState>(batch.map((i) => [i.requestId, i.state]));
        // 서명과 기기 알림은 보내는 중으로 바꾸기 전에 만든다(던지면 아무것도 바뀌지 않는다, §17 R3-6).
        const commands: QueuedEnvelope[] = [];
        for (const item of batch) commands.push(await this.d.sign(item));
        const report = await this.d.report();
        inFlight = { previous, posted: false };
        await queue.setState(batch.map((i) => i.requestId), 'sending');
        const sentAt = this.now();
        inFlight.posted = true;
        const answer = await this.d.postBatch({ report, commands }, FLUSH.batchTimeoutMs);
        const receivedAt = this.now();
        if (answer.kind === 'ok') {
          // 답의 epoch가 먼저다(§17-4): 새로 만든 매장이면 옛 답을 보낸 기록으로 옮긴 뒤에 결과 · 빈 번호를 본다.
          await this.d.onAnswerEpoch?.(answer.body);
          // 서버가 받은 가장 큰 번호를 먼저 적는다: SEQ_REUSED의 새 번호가 그 위에서 시작하게.
          await queue.noteHighWater(answer.body.device.highWater);
          const summary = await queue.answer(answer.body.results, answer.body.epoch, receivedAt, this.d.appVersion);
          // 답에 없는 항목(있으면 안 되지만): 앞 상태로.
          const answered = new Set(answer.body.results.map((r) => r.requestId));
          await queue.revert(new Map([...previous].filter(([id]) => !answered.has(id))));
          if (answer.body.device.missing.length) await queue.resendMissing(answer.body.device.missing, answer.body.epoch);
          inFlight = null;
          await this.d.onBatch(answer.body, summary, sentAt, receivedAt);
          sent += summary.answered + summary.held + summary.settled;
          notApplied += summary.notApplied;
          for (const r of answer.body.results) if (isRetryableResult(r)) deferred.add(r.requestId);
          this.d.onChange();
          // 답은 왔는데 나아간 것이 없다(다시 보낼 결과뿐 · 답에 항목이 없음): 실패로 보고 기다린다(§18 R4-2).
          if (summary.answered + summary.held + summary.settled + summary.restamped + summary.stuck === 0) {
            failed = true;
            break;
          }
          this.failures = 0;
          if (receivedAt - sentAt < FLUSH.fastMs) this.size = Math.min(FLUSH.maxSize, this.size * 2);
          continue;
        }
        if (answer.kind === 'status' && (answer.status === 400 || answer.status === 413)) {
          // 서버가 묶음을 받지 않았다: 하나씩, 혼자서도 안 되는 항목은 건너뛴다(O6).
          await queue.revert(previous);
          inFlight = null;
          if (batch.length > 1) oneByOne = true;
          else await queue.markStuck(batch[0]!.requestId, 'BAD_INPUT', this.d.appVersion);
          continue;
        }
        failed = true;
        if ((answer.kind === 'failed' && !answer.offline) || (answer.kind === 'status' && answer.status >= 500)) {
          // 서버에 닿았을 수 있다: 결과 확인 중(같은 요청번호 · 번호로 다시, O18).
          await queue.setState(batch.map((i) => i.requestId), 'unconfirmed');
          inFlight = null;
          this.size = Math.max(1, Math.floor(this.size / 2));
          this.epochChecked = false;
        } else {
          // 닿지 않았다(네트워크 없음 · BUSY · 429 · 401 · 403): 앞 상태로.
          await queue.revert(previous);
          inFlight = null;
          if (answer.kind === 'status' && answer.retryAfterMs) this.retryAfterMs = answer.retryAfterMs;
          if (answer.kind === 'status' && (answer.status === 401 || answer.status === 403)) this.stopped = answer.status === 401 ? true : this.stopped;
        }
        break;
      }
    } catch {
      // 저장소 · 서명 · 알림 실패: 보내는 중으로 둔 칸을 돌려놓는다(§17 R3-6: 이 화면이 열린 동안 다시 보내게). 보내기를 시작했으면 서버에 닿았을 수
      // 있어 결과 확인 중, 아니면 앞 상태. 돌려놓지도 못하면 다음 시작이 결과 확인 중으로 바꾼다(recoverSending). 기다렸다 다시.
      failed = true;
      const stuck = inFlight as { previous: Map<string, QueueState>; posted: boolean } | null;
      if (stuck) {
        await (stuck.posted ? queue.unconfirmSending([...stuck.previous.keys()]) : queue.revert(stuck.previous)).catch(() => undefined);
      }
    } finally {
      this.since = null;
      this.d.onChange();
    }
    if (failed) {
      this.failures += 1;
      this.schedule();
      return;
    }
    this.failures = 0;
    if (sent > 0) await this.d.onDrained({ sent, offlineMade: this.offlineMade, notApplied });
  }
}
