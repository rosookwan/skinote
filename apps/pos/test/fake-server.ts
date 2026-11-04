// 시험용 가짜 서버(work/impl-offline/plan.md §7-9): 도메인 execute를 전체 상태에 돌리고, 요청번호 멱등 · 기기 번호 · 기록(recorded)을 가진 작은
// command_log를 메모리에 둔다. DriverClient가 부르는 길(머리 · 조회 · 명령 · 사본 · 묶음 · 심장 박동 · 로그아웃 · 한 번 값 · 전달)을 fetch 모양으로
// 받는다. 서명은 등록한 공개 열쇠로 WebCrypto로 본다(받은 그대로의 항목을 검사 전에 해시). 운영 서버(packages/server/src/offline.js)의 규칙 중
// 기기 쪽이 보는 것만 흉내 낸다.
import {
  API_V2, CSRF_HEADER, canonicalJson, commandMessage, defaultUiConfig, deliverMessage, driverQueryKey, driverQueryRule, itemHash, newRequestId, parseEnvelope,
  parseQueuedEnvelope, base64Url,
  type AnyCommandEnvelope, type BatchResponse, type CommandOutcome, type DeviceReport, type OfflinePolicy, type QueuedEnvelope, type QueuedItemResult,
  type RecordedItem, type SessionInfo, type SnapshotRequest, type SnapshotResponse, type UiConfig,
} from '@skinote/contract';
import {
  PRODUCTION_LINES, execute, kstAt, ledgerView, queryScope, runQuery, sampleDay, vehicleScope, type ShopState,
} from '@skinote/domain';

export const DATE = '2026-12-26';
export const at = (h: number, m: number, day = 0) => kstAt(DATE, day, h, m);
export const ORIGIN = 'https://pos.example';
export const BASE = 'https://pos.example/app/';

export const TEST_POLICY: OfflinePolicy = {
  localFirst: true, heartbeatMs: 3_600_000, piiWipeHours: 24, sentPiiHours: 24, sentLogDays: 7, appLockMinutes: 5, maxBackdateHours: 168,
  futureSkewMinutes: 5, clockWarnMinutes: 2,
};

interface LogRow {
  requestId: string;
  deviceId: string;
  seq: number | null;
  outcome: CommandOutcome;
  reviews: string[];
  occurredAt: number;
  receivedAt: number;
  timeSource?: string;
}

interface DeviceRow {
  id: string;
  kind: 'driver_phone' | 'driver_tablet';
  vehicleId: string;
  publicKey: CryptoKey;
  revoked: boolean;
  lastReport?: DeviceReport;
}

interface SessionRow {
  id: string;
  csrf: string;
  deviceId: string;
  staffId: string;
  open: boolean;
  endCode?: string;
}

/** 한 번의 가짜 응답 방식: 정상 · 네트워크 없음(던짐, 서버에 닿지 않음) · 적용한 뒤 답을 잃음 · 상태 코드. */
export type Fault = 'down' | 'lose-answer' | { status: number; code: string };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const apiError = (status: number, code: string) => json(status, { ok: false, service: 'skinote', code });

async function sha256(text: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

export class FakeServer {
  state: ShopState;
  readonly config: UiConfig;
  readonly log = new Map<string, LogRow>();
  readonly devices = new Map<string, DeviceRow>();
  readonly sessions = new Map<string, SessionRow>();
  readonly calls: { path: string; body: unknown; keepalive?: boolean }[] = [];
  /** 길마다 다음 응답의 가짜 방식(차례로 쓴다). */
  readonly faults = new Map<string, Fault[]>();
  /** 모든 요청을 끊음(산속). */
  down = false;
  policy: OfflinePolicy = TEST_POLICY;
  restoredUpToRev: number | null = null;
  /**
   * 번호 빈 곳을 진짜 서버처럼 알린다(packages/store/src/devices.ts gaps: 이어진 끝 뒤에서 받은 가장 큰 번호 아래의 빈 번호, 50개까지). 끄면(기본)
   * 늘 빈 목록.
   */
  gaps = false;
  /** 기기마다 이어진 끝(device_sync_cursors.last_device_seq). */
  readonly cursors = new Map<string, number>();
  /** 시험 매장 새로 만들기가 이어 간 기기의 가장 큰 번호(devices.last_device_seq). */
  private readonly carriedHigh = new Map<string, number>();
  linkRev = 1;
  private nonces = new Set<string>();
  readonly now: () => number;

  constructor(now: () => number, state: ShopState = sampleDay({ date: DATE, epoch: '01JF000000000000000000EPOC', ids: 'demo' })) {
    this.now = now;
    this.state = state;
    this.config = defaultUiConfig({ shopName: state.registry.shopName, timezone: 'Asia/Seoul' });
  }

  /** 기기 등록(열쇠 쌍은 시험이 만든다). */
  enroll(kind: DeviceRow['kind'], vehicleId: string, publicKey: CryptoKey): string {
    const id = newRequestId(this.now());
    this.devices.set(id, { id, kind, vehicleId, publicKey, revoked: false });
    return id;
  }

  /** 로그인(세션 답). */
  login(deviceId: string, staffId: string): SessionInfo {
    const device = this.devices.get(deviceId)!;
    const staff = this.state.staff!.find((s) => s.id === staffId)!;
    const id = newRequestId(this.now());
    const csrf = 'c'.repeat(40) + Math.random().toString(36).slice(2, 5);
    this.sessions.set(csrf, { id, csrf, deviceId, staffId, open: true });
    return {
      shop: { name: this.state.registry.shopName }, staff: { id: staff.id, name: staff.name, roleKey: staff.roleKey },
      device: { id: deviceId, kind: device.kind, label: '1호 차량 휴대폰', vehicleId: device.vehicleId }, csrf, idleTimeoutS: 1_209_600,
      serverTime: new Date(this.now()).toISOString(), session: { id, expiresAt: new Date(this.now() + 14 * 86_400_000).toISOString(), idleTimeoutS: 1_209_600 },
      vehicleId: device.vehicleId, policy: this.policy,
    };
  }

  /** 세션을 끝낸다(다음 요청은 401). */
  endSession(csrf: string, code = 'SESSION_EXPIRED'): void {
    const s = this.sessions.get(csrf);
    if (s) {
      s.open = false;
      s.endCode = code;
    }
  }

  fault(path: string, ...faults: Fault[]): void {
    this.faults.set(path, [...(this.faults.get(path) ?? []), ...faults]);
  }

  /** 이 길의 요청을 release까지 붙잡는다(보내는 중 · 띠). */
  private readonly gates = new Map<string, { wait: Promise<void>; open: () => void }>();
  hold(path: string): void {
    let open = () => {};
    const wait = new Promise<void>((resolve) => { open = resolve; });
    this.gates.set(path, { wait, open });
  }
  release(path: string): void {
    this.gates.get(path)?.open();
    this.gates.delete(path);
  }

  /** 카운터(다른 기기)가 온라인으로 한 명령. */
  counter(command: { type: string; payload: unknown; expect?: unknown }): CommandOutcome {
    const envelope = { type: command.type, commandVersion: 1, requestId: newRequestId(this.now()), basis: { epoch: this.state.epoch, rev: this.state.rev }, payload: command.payload, ...(command.expect ? { expect: command.expect } : {}) } as AnyCommandEnvelope;
    const out = execute(this.state, envelope, { now: this.now(), actor: { key: 'staff:staff-2', name: '오세린' }, outcomeOf: () => undefined, lines: PRODUCTION_LINES, orderIds: 'dated' });
    this.state = out.state;
    return out.outcome;
  }

  /** 이 기기의 기록(번호 차례). */
  rows(deviceId: string): LogRow[] {
    return [...this.log.values()].filter((r) => r.deviceId === deviceId).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  }

  highWater(deviceId: string): number {
    return this.rows(deviceId).reduce((max, r) => Math.max(max, r.seq ?? 0), this.carriedHigh.get(deviceId) ?? 0);
  }

  /**
   * 시험 매장 새로 만들기(bin/shop.js reset-test-shop): 새 epoch의 빈 장부(state), 기록 · 서버 기억을 비우고, 기기 · 열쇠 · 세션과 기기의 가장 큰
   * 번호는 이어 간다. 되살린 기준은 없다(null). keepCursor: 이어진 끝도 이어 가는지(지금 서버, §17-4). false는 이어진 끝이 없는 서버(고치기 전 ·
   * 커서를 잃음): 새 매장이 옛 번호를 빈 번호로 알린다.
   */
  resetShop(state: ShopState, { keepCursor = true }: { keepCursor?: boolean } = {}): void {
    for (const id of this.devices.keys()) this.carriedHigh.set(id, this.highWater(id));
    this.state = state;
    this.log.clear();
    this.known.clear();
    this.cursors.clear();
    if (keepCursor) for (const [id, high] of this.carriedHigh) this.cursors.set(id, high);
    this.restoredUpToRev = null;
  }

  /** 번호 빈 곳(gaps가 켜졌을 때만): 이어진 끝을 앞으로 옮긴다. */
  private missing(deviceId: string): number[] {
    if (!this.gaps) return [];
    let contiguous = this.cursors.get(deviceId) ?? 0;
    const missing: number[] = [];
    let expected = contiguous + 1;
    let gapped = false;
    for (const r of this.rows(deviceId)) {
      if (r.seq === null || r.seq <= contiguous) continue;
      if (r.seq > expected) {
        for (let k = expected; k < r.seq && missing.length < 50; k += 1) missing.push(k);
        gapped = true;
      }
      if (!gapped) contiguous = r.seq;
      expected = r.seq + 1;
    }
    this.cursors.set(deviceId, contiguous);
    return missing;
  }

  // ── fetch ─────────────────────────────────────────────────────────

  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/app\//, '');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    this.calls.push({ path, body, ...(init?.keepalive ? { keepalive: true } : {}) });
    const gate = this.gates.get(path);
    if (gate) await gate.wait;
    const fault = this.faults.get(path)?.shift();
    if (this.down || fault === 'down') throw new TypeError('Failed to fetch');
    if (fault && typeof fault === 'object') return apiError(fault.status, fault.code);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const answer = await this.route(path, init?.method ?? 'GET', body, headers[CSRF_HEADER]);
    if (fault === 'lose-answer') throw new TypeError('connection reset');
    return answer;
  }) as typeof fetch;

  private sessionOf(csrf: string | undefined): SessionRow | Response {
    const s = csrf ? this.sessions.get(csrf) : undefined;
    if (!s) return apiError(401, 'SIGNED_OUT');
    if (!s.open) return apiError(401, s.endCode ?? 'SIGNED_OUT');
    const d = this.devices.get(s.deviceId);
    if (d?.revoked) return apiError(401, 'DEVICE_REVOKED');
    return s;
  }

  private head() {
    return { epoch: this.state.epoch, rev: this.state.rev, configRev: this.config.configRev, linkRev: this.linkRev, serverTime: new Date(this.now()).toISOString(), currentBusinessDate: this.state.businessDate };
  }

  private async route(path: string, method: string, body: unknown, csrf: string | undefined): Promise<Response> {
    if (path === API_V2.challenge) {
      const nonce = base64Url(crypto.getRandomValues(new Uint8Array(32)));
      this.nonces.add(nonce);
      return json(200, { nonce, expiresAt: new Date(this.now() + 60_000).toISOString() });
    }
    if (path === API_V2.deliver) return this.deliver(body as Record<string, unknown>);
    const s = this.sessionOf(csrf ?? (method === 'GET' ? [...this.sessions.values()].find((x) => x.open)?.csrf : undefined));
    if (s instanceof Response) return s;
    const device = this.devices.get(s.deviceId)!;
    switch (path) {
      case API_V2.head: return json(200, this.head());
      case API_V2.logout: s.open = false; s.endCode = 'SIGNED_OUT'; return new Response(null, { status: 204 });
      case API_V2.heartbeat: {
        device.lastReport = (body as { report: DeviceReport }).report;
        return json(200, { ...this.head(), heartbeatMs: this.policy.heartbeatMs, restoredUpToRev: this.restoredUpToRev, policy: this.policy });
      }
      case API_V2.query: return this.query(body as { name: string; params: Record<string, unknown> }, device);
      case API_V2.command: {
        const parsed = parseEnvelope(body, { maxQuantity: 99 });
        if (!parsed.ok) return apiError(400, parsed.code);
        return json(200, this.apply(parsed.envelope, s, device, null, this.now(), this.now()).outcome);
      }
      case API_V2.snapshot: return json(200, await this.snapshot(body as SnapshotRequest, s, device));
      case API_V2.commandsBatch: {
        const b = body as { report: DeviceReport; commands: unknown[] };
        device.lastReport = b.report;
        const results = await this.runItems(b.commands, device, s);
        const out: BatchResponse = {
          ...this.head(), restoredUpToRev: this.restoredUpToRev, heartbeatMs: this.policy.heartbeatMs, results, device: { highWater: this.highWater(device.id), missing: this.missing(device.id) },
        };
        return json(200, out);
      }
      default: return apiError(404, 'NOT_FOUND');
    }
  }

  private query(q: { name: string; params: Record<string, unknown> }, device: DeviceRow): Response {
    const params = q.params ?? {};
    const key = driverQueryKey(q.name, params.viewKey as string | undefined);
    const rule = driverQueryRule(key);
    const ctx = { config: this.config, now: this.now(), lines: PRODUCTION_LINES };
    if (rule === 'deny') return apiError(403, 'FORBIDDEN');
    if (rule === 'task_scope') {
      const scope = queryScope(this.state, q.name as never, params);
      if (!scope || scope.kind !== 'vehicle' || !scope.vehicleIds.includes(device.vehicleId)) return apiError(403, 'FORBIDDEN');
    }
    if (q.name === 'config') return json(200, this.config);
    if (q.name === 'ledgerView') {
      const { viewKey, ...rest } = params;
      return json(200, ledgerView(this.state, String(viewKey), { ...rest, vehicleId: device.vehicleId }, ctx));
    }
    return json(200, runQuery(this.state, q.name as never, params as never, ctx));
  }

  /** 명령 하나를 적용한다(요청번호 멱등 · 기기 번호 · 기록). */
  private apply(envelope: AnyCommandEnvelope, s: SessionRow, device: DeviceRow, seq: number | null, occurredAt: number, receivedAt: number): LogRow {
    const seen = this.log.get(envelope.requestId);
    if (seen) {
      // 스위치를 끈 길(O9): 온라인으로 보낸 뒤 답을 잃어 같은 요청번호로 보냄 대기에 든 명령 → 비어 있던 기기 번호를 채운다.
      const fill = seen.seq === null && seq !== null && seen.deviceId === device.id && !this.rows(device.id).some((r) => r.seq === seq);
      if (fill) seen.seq = seq;
      // 그 온라인 시도가 거절 · 충돌이었으면 보냄 대기의 사실로 다시 판단한다(서버 store runCommand와 같다, §18 R4-1).
      if (fill && (seen.outcome.outcome === 'rejected' || seen.outcome.outcome === 'conflict')) {
        const again = this.run(envelope, s, device, seq, occurredAt, receivedAt);
        Object.assign(seen, { outcome: again.outcome, reviews: again.reviews, occurredAt, receivedAt });
      }
      return seen;
    }
    const row = this.run(envelope, s, device, seq, occurredAt, receivedAt);
    this.log.set(envelope.requestId, row);
    return row;
  }

  private run(envelope: AnyCommandEnvelope, s: SessionRow, device: DeviceRow, seq: number | null, occurredAt: number, receivedAt: number): LogRow {
    const staff = this.state.staff!.find((x) => x.id === s.staffId)!;
    const before = this.state.reviews?.length ?? 0;
    const out = execute(this.state, envelope, {
      now: occurredAt, ...(seq !== null ? { recordedAt: receivedAt } : {}), actor: { key: 'staff:' + staff.id, name: staff.name, deviceId: device.id, vehicleId: device.vehicleId },
      outcomeOf: (id) => this.log.get(id)?.outcome, lines: PRODUCTION_LINES, orderIds: 'dated',
    });
    this.state = out.state;
    const reviews = (this.state.reviews ?? []).slice(before).map((r) => r.kindKey);
    return { requestId: envelope.requestId, deviceId: device.id, seq, outcome: out.outcome, reviews, occurredAt, receivedAt };
  }

  private async runItems(items: unknown[], device: DeviceRow, s: SessionRow): Promise<QueuedItemResult[]> {
    const results: QueuedItemResult[] = [];
    const sorted = [...items].sort((a, b) => ((a as { deviceSeq?: number }).deviceSeq ?? 0) - ((b as { deviceSeq?: number }).deviceSeq ?? 0));
    for (const item of sorted) {
      const raw = item as Record<string, unknown>;
      const signature = (raw.recordedBy as { signature?: string } | undefined)?.signature ?? '';
      const hash = await itemHash(item);
      const message = new TextEncoder().encode(commandMessage(ORIGIN, device.id, Number(raw.deviceSeq), hash));
      const sig = Uint8Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
      const signed = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, device.publicKey, sig, message);
      const parsed = parseQueuedEnvelope(item, { maxQuantity: 99, deviceKind: device.kind });
      if (!parsed.ok || !signed) {
        results.push({ requestId: String(raw.requestId), deviceSeq: Number(raw.deviceSeq), outcome: 'held', rev: this.state.rev, reviews: ['command_held'] });
        continue;
      }
      const env: QueuedEnvelope = parsed.envelope;
      const existingSeq = this.rows(device.id).find((r) => r.seq === env.deviceSeq && r.requestId !== env.requestId);
      if (existingSeq) {
        results.push({ requestId: env.requestId, deviceSeq: env.deviceSeq, outcome: 'rejected', rev: this.state.rev, error: { code: 'SEQ_REUSED', message: '처리 실패 · 재시도 필요' }, reviews: [] });
        continue;
      }
      const receivedAt = this.now();
      const row = this.apply(env, s, device, env.deviceSeq, receivedAt - env.ageMs, receivedAt);
      row.timeSource = env.clockAnchor.startsWith('wall-') ? 'wall_clock' : 'monotonic';
      // 서버(offline.js runItem)처럼 결과의 오류를 그대로 싣는다(§18 R4-1: 빼면 거절 · 충돌이 INTERNAL로 읽혀 쉬지 않고 다시 보낸다).
      results.push({
        requestId: env.requestId, deviceSeq: env.deviceSeq, outcome: row.outcome.outcome, rev: row.outcome.rev, reviews: row.reviews,
        ...(row.outcome.error ? { error: { code: row.outcome.error.code, message: row.outcome.error.message } } : {}),
      });
    }
    return results;
  }

  /** 기기마다 앞서 보낸 사본의 접수(서버처럼: 옮겨진 업무의 대기 항목만 사본에 남기는 근거, §17 R3-8). */
  readonly known = new Map<string, Set<string>>();

  private async snapshot(req: SnapshotRequest, s: SessionRow, device: DeviceRow): Promise<SnapshotResponse> {
    device.lastReport = req.report;
    const known = this.known.get(device.id) ?? new Set<string>();
    const scoped = { ...vehicleScope(this.state, device.vehicleId, { pendingTaskIds: req.pendingTaskIds, knownOrderIds: known, staffId: s.staffId }) };
    this.known.set(device.id, new Set([...known, ...scoped.orders.map((o) => o.id)]));
    const hash = await sha256(canonicalJson({ ...scoped, rev: 0 }));
    const unchanged = req.known?.epoch === this.state.epoch && req.known.hash === hash;
    const recorded: RecordedItem[] = this.rows(device.id).filter((r) => r.seq !== null && r.seq >= req.fromSeq)
      .map((r) => ({ requestId: r.requestId, deviceSeq: r.seq!, outcome: r.outcome.outcome, rev: r.outcome.rev, reviews: r.reviews, ...(r.outcome.error ? { errorCode: r.outcome.error.code } : {}) }));
    const onlineRecorded = req.onlinePending.filter((id) => this.log.get(id)?.deviceId === device.id)
      .map((id) => ({ requestId: id, outcome: this.log.get(id)!.outcome.outcome, rev: this.log.get(id)!.outcome.rev }));
    return {
      ...this.head(), restoredUpToRev: this.restoredUpToRev, policy: this.policy,
      scope: { vehicleId: device.vehicleId, businessDate: this.state.businessDate, cutoff: this.state.settings.businessDayCutoff }, hash, unchanged,
      ...(unchanged ? {} : { state: scoped as unknown as Record<string, unknown> }),
      ...(req.known?.configRev === this.config.configRev ? {} : { config: this.config }),
      recorded, recordedMore: false, onlineRecorded, device: { highWater: this.highWater(device.id), missing: this.missing(device.id) },
    };
  }

  private async deliver(body: Record<string, unknown>): Promise<Response> {
    const device = this.devices.get(String(body.deviceId));
    if (!device || !this.nonces.delete(String(body.nonce))) return apiError(401, 'BAD_SIGNATURE');
    const sig = Uint8Array.from(atob(String(body.signature).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, device.publicKey, sig, new TextEncoder().encode(deliverMessage(ORIGIN, device.id, String(body.nonce))));
    if (!ok) return apiError(401, 'BAD_SIGNATURE');
    const session = [...this.sessions.values()].find((x) => x.deviceId === device.id)!;
    const results = device.revoked
      ? (body.commands as Record<string, unknown>[]).map((c) => ({ requestId: String(c.requestId), deviceSeq: Number(c.deviceSeq), outcome: 'held' as const, rev: this.state.rev, reviews: ['revoked_device_record'] }))
      : await this.runItems(body.commands as unknown[], device, session);
    return json(200, {
      ...this.head(), heartbeatMs: this.policy.heartbeatMs, results,
      device: { highWater: this.highWater(device.id), missing: [], status: device.revoked ? 'revoked' : 'active', wipe: device.revoked },
    });
  }
}

/** 손으로 돌리는 시계(벽시계 · 단조 시계). */
export class TestClocks {
  wallMs: number;
  monoMs = 1_000;
  constructor(start: number) {
    this.wallMs = start;
  }
  wall = (): number => this.wallMs;
  mono = (): number => this.monoMs;
  /** 둘 다 앞으로(깨어 있는 기기). */
  advance(ms: number): void {
    this.wallMs += ms;
    this.monoMs += ms;
  }
}

/** 손으로 돌리는 타이머(DriverClient · 보내기 · 사본의 기다림). */
export class ManualTimers {
  private next = 1;
  private readonly pending = new Map<number, { at: number; fn: () => void }>();
  now = 0;
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.next++;
    this.pending.set(id, { at: this.now + ms, fn });
    return id;
  };
  clearTimeout = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };
  /** ms만큼 앞으로: 때가 된 것을 차례로 부른다. */
  advance(ms: number): void {
    this.now += ms;
    for (;;) {
      const due = [...this.pending.entries()].filter(([, t]) => t.at <= this.now).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) return;
      this.pending.delete(due[0]);
      due[1].fn();
    }
  }
  size(): number {
    return this.pending.size;
  }
}

/** 약속들이 모두 풀릴 때까지(마이크로태스크 · WebCrypto) 조금 기다린다. */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}
