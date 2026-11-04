// 기기 저장소의 모양(work/impl-offline/plan.md §7-1 · O13 · O22): 사본(plain 머리 + 봉인 본문), 기기 메모, 답을 잃은 온라인 명령, 화면 사이의 알림과
// 잠금. 보냄 대기 · 보낸 기록은 queue.ts가 같은 바닥(raw)과 열쇠(keys)로 쓴다.
//   - 사본: `snapshot` 칸 'copy' = 머리(판 · 해시 · 차량 · 영업일 · 운영 값, 개인정보 없음) + 사본 열쇠로 봉인한 본문(차량 범위 ShopState · 화면
//     설정). 통째로 새로 쓸 때마다 새 사본 열쇠로 봉인하고, 기억한 세션도 새 열쇠로 다시 봉인한 뒤 옛 사본 열쇠를 같은 트랜잭션에서 지운다.
//   - 판 확인(O15): 이 빌드가 모르는 형식(fmt)이나 상태 판(stateVersion)의 사본은 그리지 않는다('format').
//   - 알림(BroadcastChannel 'skinote-local'): 'queue' · 'copy' · 'meta' · 'shred'. 다른 화면은 다시 읽고, 'shred'면 열쇠를 잊고 로그인으로 간다.
//   - 잠금(Web Locks): 'skinote-enqueue'(보냄 대기 넣기 · 지우기), 'skinote-copy'(사본 쓰기), 'skinote-flush'(보내는 쪽은 하나). 없으면(사파리
//     15.4 전) 이 화면 안의 차례로 대신한다: 트랜잭션만으로도 번호는 겹치지 않는다(O22).
import type { AnyCommandEnvelope, OfflinePolicy, UiConfig } from '@skinote/contract';
import type { ShopState } from '@skinote/domain';
import { KeyRing, queueKeyId, randomId, type KeyRecord } from './keys.ts';
import { readOne, TxAborted, type RawStore, type Rec, type TxRequests } from './raw-store.ts';
import { isSealed, seal, sealContext, unseal, Unreadable, type Sealed } from './sealed.ts';

// ── 화면 사이의 알림과 잠금 ──────────────────────────────────────────

export type NoticeKind = 'queue' | 'copy' | 'meta' | 'shred';
export interface Notice {
  kind: NoticeKind;
  /** 알린 화면(자기 알림은 듣지 않는다). */
  from: string;
}

/** BroadcastChannel에서 쓰는 만큼. */
export interface Channel {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  close(): void;
}

export interface Locks {
  request<T>(name: string, work: () => Promise<T>): Promise<T>;
}

/** 이 화면 안의 차례(Web Locks가 없는 브라우저 · 시험의 여러 화면이 함께 쓰는 잠금). */
export class PageLocks implements Locks {
  private readonly tails = new Map<string, Promise<unknown>>();
  request<T>(name: string, work: () => Promise<T>): Promise<T> {
    const before = this.tails.get(name) ?? Promise.resolve();
    const run = before.then(work, work);
    this.tails.set(name, run.catch(() => undefined));
    return run;
  }
}

/** 브라우저의 잠금: Web Locks, 없으면 이 화면 안의 차례. */
export function browserLocks(): Locks {
  const locks = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { locks?: { request(name: string, cb: () => Promise<unknown>): Promise<unknown> } }).locks;
  if (!locks) return new PageLocks();
  return { request: <T,>(name: string, work: () => Promise<T>) => locks.request(name, work) as Promise<T> };
}

export const LOCAL_CHANNEL = 'skinote-local';

/** 브라우저의 알림 길. 없으면 null(다른 화면을 모른다). */
export function browserChannel(): Channel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    return new BroadcastChannel(LOCAL_CHANNEL);
  } catch {
    return null;
  }
}

/** 시험: 여러 화면이 함께 쓰는 알림 길(BroadcastChannel처럼 자기에게는 오지 않는다, 다음 마이크로태스크에 온다). */
export class MemoryChannelHub {
  private readonly members = new Set<{ listeners: Set<(event: MessageEvent) => void> }>();
  channel(): Channel {
    const me = { listeners: new Set<(event: MessageEvent) => void>() };
    this.members.add(me);
    return {
      postMessage: (message) => {
        for (const other of this.members) {
          if (other === me) continue;
          for (const l of [...other.listeners]) queueMicrotask(() => l(new MessageEvent('message', { data: structuredClone(message) })));
        }
      },
      addEventListener: (_type, listener) => { me.listeners.add(listener); },
      removeEventListener: (_type, listener) => { me.listeners.delete(listener); },
      close: () => { this.members.delete(me); },
    };
  }
}

// ── 사본과 기기 메모 ────────────────────────────────────────────────

/** 이 빌드가 읽는 사본 형식과 상태 판. */
export const COPY_FMT = 1;
export const STATE_VERSION = 3;

/** 사본의 머리(봉인하지 않음, 개인정보 없음). */
export interface CopyHead {
  fmt: number;
  appVersion: string;
  stateVersion: number;
  epoch: string;
  rev: number;
  hash: string;
  configRev: number;
  vehicleId: string;
  /** 사본을 받은 영업일(06:00 넘기기는 maintenance가 다시 좁힌다). */
  businessDate: string;
  cutoff: string;
  /** 받은 때(기기 벽시계). */
  storedAt: number;
  /** 24시간 지움을 했는지(이름 · 전화 없음, 끝 4자리만). */
  scrubbed: boolean;
  policy: OfflinePolicy;
  /** 서버의 복구 기준(복구 뒤 다시 보내기, O20). */
  restoredUpToRev: number | null;
}

export type CopyRecord = CopyHead & Sealed & { id: 'copy' };

/** 사본 본문(봉인). */
export interface CopyBody {
  state: ShopState;
  config: UiConfig;
}

export type CopyRead =
  | { status: 'none' }
  | { status: 'format'; head: CopyHead }
  | { status: 'unreadable'; head: CopyHead }
  | { status: 'ok'; head: CopyHead; body: CopyBody };

/** 기기 메모(봉인하지 않음). */
export interface DeviceMeta {
  /** 마지막으로 서버와 주고받은 때(기기 벽시계). */
  lastContactAt?: number;
  /** 사람이 한 일을 서버에 보낸 마지막 때(서버의 쉬는 시간이 늘어난 때, O15). */
  lastTouchAt?: number;
  /** 서버 시각 − 기기 벽시계(마지막 좋은 답). */
  clockOffsetMs: number;
  offsetKnown: boolean;
  /** 본 가장 늦은 벽시계(시계 톱니, O14 g). */
  maxSeenWall?: number;
  /** 서버가 알린 가장 큰 받은 번호. */
  highWater: number;
  /** 사람이 이 기기를 마지막으로 쓴 때(누름 · 키, 1분에 한 번만 적는다: 앱 잠금, O15 d). */
  lastUseAt?: number;
  /** 앱 잠금에서 연달아 틀린 수. 맞히거나 온라인 로그인하면 0. 다섯 번마다 잠김(lockUntil, §17 R3-24). */
  lockFailures?: number;
  /** 앱 잠금이 풀리는 때(기기 벽시계): 다섯 번 틀릴 때마다 5 · 10 · 20 …분(24시간까지). */
  lockUntil?: number;
  /** 마지막으로 틀린 때(시계를 뒤로 돌려 잠김을 줄이지 못하게). */
  lastFailAt?: number;
  /**
   * 마지막으로 본 서버 epoch(§17 R3-3). 사본을 지워도(로그아웃 · 401) 남아, 다음 연결에서 복구 · 새로 만들기를 알아본다. 기기의 보낸 기록을 다시
   * 보낼지는 서버의 restoredUpToRev가 정한다(R3-1).
   */
  epoch?: string;
  /** 복구로 온 epoch와 그 기준 rev(그 epoch 동안 빠진 번호의 다시 보내기가 옛 epoch의 보낸 기록도 본다). */
  restoredEpoch?: string;
  restoredUpToRev?: number;
  /**
   * 서버에 닿지 못한 로그아웃의 세션 id(§17 R3-7): 다음 연결에서 그 세션이 살아 있으면 먼저 서버 로그아웃을 보내고 로그인 화면으로 간다(그 세션을
   * 열지 않는다).
   */
  signOutPending?: string;
  /**
   * 다시 보낸 온라인 명령이 받아들여지지 않은 것(§18 R4-15): 띠 `처리 실패 · 현금 인계 350,000원 · 매장 확인`. 일 이름 · 돈 · 그때의 영업일만(개인정보
   * 없음). 같은 일을 다시 해 받아들여지면 · 영업일이 바뀌면 · 로그아웃하면 걷는다(앱을 다시 켜도 남는다).
   */
  refusedOnline?: RefusedOnline[];
}

/** 받아들여지지 않은 온라인 명령 하나(띠의 조각). */
export interface RefusedOnline {
  requestId: string;
  type: string;
  what: string;
  money?: string;
  /** 그때의 영업일(바뀌면 띠에서 빠진다). */
  day?: string;
  at: number;
}

const META_KEY = 'meta';

const isRefused = (x: unknown): x is RefusedOnline => {
  const r = x as Partial<RefusedOnline> | null;
  return !!r && typeof r === 'object' && typeof r.requestId === 'string' && typeof r.type === 'string' && typeof r.what === 'string' && typeof r.at === 'number';
};
/** 답을 잃은 온라인 명령 한 건의 칸('online:<요청번호>', 화면마다 하나씩 더하고 빼 다른 화면의 것을 덮지 않는다, §17 R3-5). */
const ONLINE_PREFIX = 'online:';

/** 답을 잃은 온라인 명령 하나(O18). */
export interface OnlinePending {
  envelope: AnyCommandEnvelope;
  /** 보낸 때(기기 벽시계). */
  at: number;
}

const copyHeadOf = (r: Rec): CopyHead | null => {
  if (typeof r.epoch !== 'string' || typeof r.rev !== 'number' || typeof r.hash !== 'string' || typeof r.vehicleId !== 'string') return null;
  const { id: _id, keyId: _k, iv: _iv, body: _b, ...head } = r;
  return head as unknown as CopyHead;
};

export interface LocalStoreOptions {
  raw: RawStore;
  deviceId: string;
  channel?: Channel | null;
  locks?: Locks;
  subtle?: SubtleCrypto;
  now?: () => number;
}

export class LocalStore {
  readonly raw: RawStore;
  readonly keys: KeyRing;
  readonly deviceId: string;
  /** 이 화면(알림에서 자기 것을 거른다). */
  readonly pageId = randomId(9);
  readonly locks: Locks;
  private readonly channel: Channel | null;
  private readonly subtle: SubtleCrypto;
  private readonly now: () => number;
  private readonly noticeListeners = new Set<(notice: Notice) => void>();
  private readonly onMessage = (event: MessageEvent) => {
    const data = event.data as Partial<Notice> | undefined;
    if (!data || typeof data.kind !== 'string' || data.from === this.pageId) return;
    if (data.kind === 'shred') this.keys.forget();
    for (const l of [...this.noticeListeners]) l({ kind: data.kind as NoticeKind, from: String(data.from ?? '') });
  };

  constructor(options: LocalStoreOptions) {
    this.raw = options.raw;
    this.deviceId = options.deviceId;
    this.channel = options.channel ?? null;
    this.locks = options.locks ?? new PageLocks();
    this.subtle = options.subtle ?? globalThis.crypto.subtle;
    this.now = options.now ?? (() => Date.now());
    this.keys = new KeyRing(this.raw, this.subtle, this.now);
    this.channel?.addEventListener('message', this.onMessage);
  }

  close(): void {
    this.channel?.removeEventListener('message', this.onMessage);
    this.channel?.close();
    this.noticeListeners.clear();
  }

  notify(kind: NoticeKind): void {
    try {
      this.channel?.postMessage({ kind, from: this.pageId });
    } catch {
      // 닫힌 길: 다른 화면은 다음 읽기에서 안다.
    }
  }

  onNotice(listener: (notice: Notice) => void): () => void {
    this.noticeListeners.add(listener);
    return () => { this.noticeListeners.delete(listener); };
  }

  withLock<T>(name: 'skinote-enqueue' | 'skinote-copy' | 'skinote-flush' | 'skinote-snapshot' | 'skinote-epoch', work: () => Promise<T>): Promise<T> {
    return this.locks.request(name, work);
  }

  // ── 기기 메모 ─────────────────────────────────────────────────────

  async readMeta(): Promise<DeviceMeta> {
    const r = await readOne(this.raw, 'meta', META_KEY);
    return {
      clockOffsetMs: typeof r?.clockOffsetMs === 'number' ? r.clockOffsetMs : 0,
      offsetKnown: r?.offsetKnown === true,
      highWater: typeof r?.highWater === 'number' ? r.highWater : 0,
      ...(typeof r?.lastContactAt === 'number' ? { lastContactAt: r.lastContactAt } : {}),
      ...(typeof r?.lastTouchAt === 'number' ? { lastTouchAt: r.lastTouchAt } : {}),
      ...(typeof r?.maxSeenWall === 'number' ? { maxSeenWall: r.maxSeenWall } : {}),
      ...(typeof r?.lastUseAt === 'number' ? { lastUseAt: r.lastUseAt } : {}),
      ...(typeof r?.lockFailures === 'number' ? { lockFailures: r.lockFailures } : {}),
      ...(typeof r?.lockUntil === 'number' ? { lockUntil: r.lockUntil } : {}),
      ...(typeof r?.lastFailAt === 'number' ? { lastFailAt: r.lastFailAt } : {}),
      ...(typeof r?.epoch === 'string' && r.epoch !== '' ? { epoch: r.epoch } : {}),
      ...(typeof r?.restoredEpoch === 'string' && typeof r.restoredUpToRev === 'number' ? { restoredEpoch: r.restoredEpoch, restoredUpToRev: r.restoredUpToRev } : {}),
      ...(Array.isArray(r?.refusedOnline) ? { refusedOnline: (r.refusedOnline as unknown[]).filter(isRefused) } : {}),
      ...(typeof r?.signOutPending === 'string' && r.signOutPending !== '' ? { signOutPending: r.signOutPending } : {}),
    };
  }

  /** 메모 일부를 바꾼다(한 트랜잭션: 읽고 합쳐 쓴다). highWater · maxSeenWall은 줄지 않는다. */
  async patchMeta(patch: Partial<DeviceMeta>): Promise<DeviceMeta> {
    let next: DeviceMeta | undefined;
    await this.raw.tx(['meta'], 'readwrite', (t) => t.get('meta', META_KEY, (r) => {
      const prev = { clockOffsetMs: 0, offsetKnown: false, highWater: 0, ...(r ?? {}) } as DeviceMeta & Rec;
      const merged = { ...prev, ...patch } as DeviceMeta & Rec;
      if (patch.highWater !== undefined) merged.highWater = Math.max(prev.highWater ?? 0, patch.highWater);
      if (patch.maxSeenWall !== undefined) merged.maxSeenWall = Math.max(prev.maxSeenWall ?? 0, patch.maxSeenWall);
      next = merged;
      t.put('meta', { ...merged, id: META_KEY });
    }));
    const { id: _id, ...out } = next as DeviceMeta & Rec;
    return out as DeviceMeta;
  }

  // ── 사본 ──────────────────────────────────────────────────────────

  /** 사본 머리만(봉인을 열지 않는다: 부팅 · 판 확인). */
  async copyHead(): Promise<CopyHead | null> {
    const r = await readOne(this.raw, 'snapshot', 'copy');
    return r ? copyHeadOf(r) : null;
  }

  async readCopy(): Promise<CopyRead> {
    const r = await readOne(this.raw, 'snapshot', 'copy');
    if (!r) return { status: 'none' };
    const head = copyHeadOf(r);
    if (!head) return { status: 'none' };
    if (head.fmt !== COPY_FMT || head.stateVersion !== STATE_VERSION) return { status: 'format', head };
    if (!isSealed(r)) return { status: 'unreadable', head };
    const key = await this.keys.key(r.keyId);
    if (!key) return { status: 'unreadable', head };
    try {
      const body = await unseal<CopyBody>(key, r, sealContext('snapshot', 'copy', r.keyId), this.subtle);
      return { status: 'ok', head, body };
    } catch (error) {
      if (error instanceof Unreadable) return { status: 'unreadable', head };
      throw error;
    }
  }

  /**
   * 사본을 통째로 쓴다(새 사본 열쇠, O13): 본문을 새 열쇠로 봉인하고, 기억한 세션도 새 열쇠로 다시 봉인하고, 옛 사본 열쇠를 지운다 — 한
   * 트랜잭션. during은 같은 트랜잭션 안의 일(사본에 든 보냄 대기 항목을 보낸 기록으로 옮김, O4).
   */
  async writeCopy(head: CopyHead, body: CopyBody, during?: (t: TxRequests) => void, only?: { ifSame: Pick<CopyHead, 'epoch' | 'rev' | 'hash'> }): Promise<boolean> {
    let wrote = false;
    await this.withLock('skinote-copy', async () => {
      // 읽은 뒤 그사이 다른 쪽(사본 받기)이 새 사본을 썼으면 쓰지 않는다(지움 시계가 옛 본문으로 덮지 않게).
      if (only) {
        const now = await this.copyHead();
        if (!now || now.epoch !== only.ifSame.epoch || now.rev !== only.ifSame.rev || now.hash !== only.ifSame.hash) return;
      }
      const key = await this.keys.newCopyKey(this.deviceId);
      const sealed = await seal(key.key, key.id, sealContext('snapshot', 'copy', key.id), body, this.subtle);
      const sessions = await this.resealSessions(key);
      await this.raw.tx(['keys', 'snapshot', 'session', 'queue', 'sent', 'meta'], 'readwrite', (t) => {
        t.put('keys', key as unknown as Rec);
        t.put('snapshot', { ...head, id: 'copy', ...sealed });
        for (const s of sessions) t.put('session', s);
        during?.(t);
        t.all('keys', (all) => {
          for (const k of all) if (k.kind === 'copy' && k.id !== key.id) t.delete('keys', String(k.id));
        });
      }, { durability: 'strict' });
      this.keys.forget();
      this.keys.remember(key);
      wrote = true;
    });
    if (wrote) this.notify('copy');
    return wrote;
  }

  /** 사본의 머리만 바꾼다(같은 내용: 새 rev · 운영 값). 본문 · 열쇠는 그대로. during은 같은 트랜잭션의 일. */
  async touchCopy(patch: Partial<CopyHead>, during?: (t: TxRequests) => void): Promise<boolean> {
    let found = false;
    await this.withLock('skinote-copy', () => this.raw.tx(['snapshot', 'queue', 'sent'], 'readwrite', (t) => {
      t.get('snapshot', 'copy', (r) => {
        if (!r) return;
        found = true;
        t.put('snapshot', { ...r, ...patch, id: 'copy' });
        during?.(t);
      });
    }));
    if (found) this.notify('copy');
    return found;
  }

  /**
   * 사본을 지운다(로그아웃 · 401 · 끊은 기기, O14 c · d): 사본 · 기억한 세션 · 사본 열쇠를 한 트랜잭션에서 지운다. 보냄 대기 열쇠 · 보낸 기록 · 기기
   * 번호는 남는다. 다른 화면에 'shred'를 알린다.
   */
  async dropCopy(): Promise<void> {
    // 사본 쓰기 · 보냄 대기 넣기가 끝나기를 기다린다(늦게 끝난 사본 쓰기가 지운 뒤에 다시 쓰지 않게: 부르는 쪽은 받기를 먼저 멈춘다).
    await this.withLock('skinote-copy', () => this.withLock('skinote-enqueue', () => this.raw.tx(['keys', 'snapshot', 'session'], 'readwrite', (t) => {
      t.clear('snapshot');
      t.clear('session');
      t.all('keys', (all) => { for (const k of all) if (k.kind === 'copy') t.delete('keys', String(k.id)); });
    }, { durability: 'strict' })));
    this.keys.forget();
    this.notify('shred');
  }

  /**
   * 모두 지운다(끊은 기기가 기록을 모두 전달한 뒤, O14 e): 두 열쇠 · 보냄 대기 · 보낸 기록 · 번호 · 메모. 보냄 대기에 답을 받지 않은 칸이 하나라도 있으면
   * 같은 트랜잭션에서 되돌리고 false(§17 R3-4: 이 화면의 셈이 아니라 저장소를 보고 정한다 — 다른 화면이 방금 넣은 기록을 지우지 않게).
   */
  async wipeAll(): Promise<boolean> {
    let wiped = true;
    try {
      await this.withLock('skinote-copy', () => this.withLock('skinote-enqueue', () => this.raw.tx(['keys', 'counters', 'queue', 'sent', 'snapshot', 'session', 'meta'], 'readwrite', (t) => {
        t.all('queue', (rows) => {
          if (rows.some((r) => r.state !== 'answered')) {
            t.abort('pending');
            return;
          }
          for (const s of ['keys', 'counters', 'queue', 'sent', 'snapshot', 'session', 'meta'] as const) t.clear(s);
        });
      }, { durability: 'strict' })));
    } catch (error) {
      if (!(error instanceof TxAborted) || error.reason !== 'pending') throw error;
      wiped = false;
    }
    if (!wiped) return false;
    this.keys.forget();
    this.notify('shred');
    return true;
  }

  /** 기억한 세션 칸들을 새 사본 열쇠로 다시 봉인한 값(트랜잭션 전에, 열 수 없는 것은 버린다). */
  private async resealSessions(key: KeyRecord): Promise<Rec[]> {
    let rows: Rec[] = [];
    await this.raw.tx(['session'], 'readonly', (t) => t.all('session', (v) => { rows = v; }));
    const out: Rec[] = [];
    for (const r of rows) {
      if (!isSealed(r) || typeof r.id !== 'string') continue;
      const old = await this.keys.key(r.keyId);
      if (!old) continue;
      try {
        const value = await unseal<unknown>(old, r, sealContext('session', r.id, r.keyId), this.subtle);
        out.push({ ...r, ...(await seal(key.key, key.id, sealContext('session', r.id, key.id), value, this.subtle)) });
      } catch {
        // 열 수 없는 세션은 옮기지 않는다(다음 로그인에서 다시 만든다).
      }
    }
    return out;
  }

  // ── 기억한 세션 · 비밀번호 확인 값(O15, 사본 열쇠로 봉인) ───────────────────────

  /**
   * 'session' 저장소의 칸 하나를 지금 사본 열쇠로 봉인해 쓴다(없으면 새 사본 열쇠를 같은 트랜잭션에 넣는다). 사본을 새로 쓰면 writeCopy가 새 열쇠로
   * 다시 봉인하고, 로그아웃 · 401 · 끊은 기기는 사본과 함께 지운다(dropCopy).
   */
  async writeSessionRecord(id: string, value: unknown): Promise<void> {
    await this.withLock('skinote-copy', async () => {
      const head = await readOne(this.raw, 'snapshot', 'copy');
      let key = head && isSealed(head) ? await this.keys.key(head.keyId) : null;
      let keyId = head && isSealed(head) ? head.keyId : '';
      let fresh: KeyRecord | null = null;
      if (!key) {
        const current = await this.keys.currentCopyKey();
        if (current) {
          key = current.key;
          keyId = current.id;
        } else {
          fresh = await this.keys.newCopyKey(this.deviceId);
          key = fresh.key;
          keyId = fresh.id;
        }
      }
      const sealed = await seal(key, keyId, sealContext('session', id, keyId), value, this.subtle);
      await this.raw.tx(['keys', 'session'], 'readwrite', (t) => {
        if (fresh) t.put('keys', fresh as unknown as Rec);
        t.put('session', { id, ...sealed });
      }, { durability: 'strict' });
      if (fresh) this.keys.remember(fresh);
    });
  }

  /** 'session' 저장소의 칸 하나(없거나 열 수 없으면 null). */
  async readSessionRecord<T>(id: string): Promise<T | null> {
    const r = await readOne(this.raw, 'session', id);
    if (!r || !isSealed(r)) return null;
    const key = await this.keys.key(r.keyId);
    if (!key) return null;
    try {
      return await unseal<T>(key, r, sealContext('session', id, r.keyId), this.subtle);
    } catch {
      return null;
    }
  }

  /** 'session' 저장소의 칸 하나를 지운다(다섯 번 틀린 앱 잠금: 기억한 세션을 버려 온라인 로그인으로). */
  async deleteSessionRecord(id: string): Promise<void> {
    await this.raw.tx(['session'], 'readwrite', (t) => t.delete('session', id), { durability: 'strict' });
  }

  // ── 답을 잃은 온라인 명령(O18) ───────────────────────────────────────

  /** 답을 잃은 온라인 명령들(보낸 때 차례). 열 수 없는 칸은 건너뛴다. */
  async readOnline(): Promise<OnlinePending[]> {
    let rows: Rec[] = [];
    await this.raw.tx(['meta'], 'readonly', (t) => t.all('meta', (v) => { rows = v; }));
    const out: OnlinePending[] = [];
    for (const r of rows) {
      if (typeof r.id !== 'string' || !r.id.startsWith(ONLINE_PREFIX) || !isSealed(r)) continue;
      const key = await this.keys.key(r.keyId);
      if (!key) continue;
      try {
        out.push(await unseal<OnlinePending>(key, r, sealContext('online', r.id, r.keyId), this.subtle));
      } catch {
        // 열 수 없는 칸: 건너뛴다.
      }
    }
    return out.sort((a, b) => a.at - b.at);
  }

  /** 답을 잃은 온라인 명령 하나를 더한다(그 요청번호의 칸 하나만 쓴다: 다른 화면의 칸을 덮지 않는다, §17 R3-5). */
  async addOnline(entry: OnlinePending): Promise<void> {
    const id = ONLINE_PREFIX + entry.envelope.requestId;
    const key = await this.keys.queueKey(this.deviceId);
    const sealed = await seal(key.key, key.id, sealContext('online', id, key.id), entry, this.subtle);
    await this.raw.tx(['meta'], 'readwrite', (t) => t.put('meta', { id, ...sealed }), { durability: 'strict' });
    this.notify('meta');
  }

  /** 답을 잃은 온라인 명령 하나를 뺀다(그 칸만). */
  async removeOnline(requestId: string): Promise<void> {
    await this.raw.tx(['meta'], 'readwrite', (t) => t.delete('meta', ONLINE_PREFIX + requestId), { durability: 'strict' });
    this.notify('meta');
  }

  /** 이 기기의 보냄 대기 열쇠 id. */
  queueKeyId(): string {
    return queueKeyId(this.deviceId);
  }
}
