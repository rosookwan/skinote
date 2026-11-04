// FixtureClient: 체험판(GitHub Pages)에서 서버 대신 쓰는 DomainClient — @skinote/domain의 메모리 어댑터(work/impl-server/plan.md D1).
// 규칙 · 명령 처리기 · 읽기 모델은 모두 도메인 패키지에 있고(서버와 같은 코드), 여기에는 체험판만의 것(시계 · 이야기 · 기사 기기의
// 보냄 대기 · localStorage · 체험 문구)만 있다. 화면은 규칙을 모른다(읽기 모델만 받는다). 자료는 브라우저 localStorage에 남고(없어도
// 돈다), '나가기' 화면에서 처음으로 되돌린다.
// 체험 시계는 12월 26일 15:40에서 시작해 페이지를 연 동안 실제 시간과 함께 가고, 닫혀 있던 동안은 멈춘다. 앞으로 돌릴 수 있다.
// 기기 역할(setDevice): 기사 화면을 여는 동안 이 클라이언트는 기사 기기(운영의 LocalClient 몫)다. 그 기기의 연결을 끊으면
// (setOffline) 허용된 명령은 보냄 대기에 쌓이고, 목록은 대기를 겹쳐 그려 받음 도장을 점선으로 보인다(sync 8-1).
// 다시 연결하면 쌓인 순서대로 보낸다. 카운터는 매장 네트워크라 늘 연결되어 있고, 기사 기기의 대기는 카운터에 보이지 않는다.
// 운영과 같은 모양(work/impl-offline/plan.md O19): 겹쳐 그리기는 도메인의 overlayQueue(서버 모드 기사 기기와 같은 코드), 카운터는 끊긴 기사 기기를
// 서버처럼 차량 연결 사실(대기 수 모름)로 본다(수거 목록 표시 · 일정 변경 · 긴급 요청 경고 · 마감 막는 단계, 마감 명령의 links). 다시 붙어 보낸 뒤
// 2분(또는 다음 확인 창까지) 띠가 `전송 대기 0`이다. 체험 주소의 뜻: ?flush=hold 다시 붙어도 보내기를 잠시 붙잡아 `전송 중 · 전송 대기 n`(보내는 중의
// 매장 입고는 `입고 불가 · 전송 대기 n`), ?lost=1 그동안 첫 항목은 답을 잃은 것(`결과 확인 중`), ?van=stuck · asleep 카운터가 보는 모양(기록을
// 알렸으나 보내지 못함 · 주머니 속 휴대폰). 마감 넘기기의 관리자 승인은 넘길 권한이 있는 보는 사람이면 4 ~ 6자리 아무 숫자다.
import {
  defaultUiConfig, type AnyCommandEnvelope, type CommandOutcome, type CommandType, type ConnectionState, type DomainClient,
  type LedgerViewResult, type PendingCommand, type QueryName, type QueryParams, type QueryResult, type SettingsOp, type SettingsTabKey, type ShopSettingsView,
  type SyncHead, type UiConfig, type VehicleLink, type VehicleLinkFact, type ViewParams,
} from '@skinote/contract';
import {
  MINUTE, OFFLINE_ALLOWED, SAMPLE_STAFF, iso, ledgerView, outcomeNoteCounts, outcomeNoteKey, overlayQueue, pendingLine, pendingSummary, recordTeam, runQuery, sampleRegistry, type DeviceOutcome, type OutcomeNote,
  type FxState, type OverlayItem, type ReadContext, type SampleShop,
} from '@skinote/domain';
import { ServerRefusal } from '../app/server-refusal.ts';
import { say } from '../app/strings.ts';
import { DEMO_LINES, DEMO_START_MS, applyCommand, createSeed } from './demo.ts';
import { applyStory } from './story.ts';

/** localStorage와 같은 모양(시험은 메모리 저장소를 넣는다). */
export interface FixtureStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface FixtureClientOptions {
  /** 없거나 막히면 메모리에만 둔다(사생활 보호 창). */
  storage?: FixtureStorage | null;
  storageKey?: string;
  /** 실제 시계(시험에서 고정). */
  realNow?: () => number;
  /** 다른 탭(기사 화면 등)이 같은 자료를 바꾸면 따라 읽는다. */
  listenToOtherTabs?: boolean;
  /**
   * 뒷이야기(story.ts): 체험 시계를 앞으로 돌리면 그 사이의 사건을 적는다. 체험판은 켜고(main.tsx), 시험은 기본으로 끈다
   * (이야기를 보는 시험만 켠다).
   */
  story?: boolean;
  /** 견본 매장 모양: 체험판은 첫 매장(기본), 번호 · 권 보증금을 켠 매장(numbered)은 시험이 쓴다. */
  shop?: SampleShop;
  /**
   * 보는 사람(체험판 주소 ?viewer=counter): 카운터 역할의 권한으로 읽기 모델을 그린다(매장 설정의 `권한 없음 · 관리자 확인 필요`를 규칙 검사기가
   * 잰다, features-1 E11). 없으면 모두 허락.
   */
  viewer?: 'counter';
  /** 체험 주소 ?flush=hold: 다시 붙어도 보내기를 FLUSH_HOLD_MS 동안 붙잡는다(띠 `전송 중 · 전송 대기 n`, 규칙 검사기가 잰다). */
  flushHold?: boolean;
  /**
   * 체험 주소 ?flush=stuck: 다시 붙어도 보내지 못한 채 둔다(서버 오류 뒤 기다림 · 혼자도 못 보내는 항목: 띠 `전송 대기 n`). 연결을 다시 끊었다 이으면
   * (뜻 없이) 보낸다.
   */
  flushStuck?: boolean;
  /** 체험 주소 ?recording=off: 이 기기에 저장할 곳이 없는 모양(띠 `이 기기 연결 끊김 기록 불가`). */
  recordingOff?: boolean;
  /** 체험 주소 ?lost=1: 붙잡은 동안 첫 항목은 보낸 뒤 답을 잃은 것(`{시각} 처리 · 결과 확인 중`). */
  lostFirst?: boolean;
  /**
   * 체험 주소 ?resend=refused: 답을 잃었다가 다시 보낸 온라인 명령 하나가 받아들여지지 않은 모양(띠 `전송 실패 · 재전송 필요`, 다음 확인 창까지:
   * 운영 DriverClient의 refusedCount와 같음, 검토 1회 data-loss 4). 규칙 검사기가 잰다.
   */
  resendRefused?: boolean;
  /**
   * 체험 주소 ?van=stuck · asleep · two: 끊긴 기사 기기를 카운터가 보는 모양. 없으면 끊김(대기 수 모름, 서버와 같음). two는 두 차량이 함께 끊긴 밤
   * (장부 제목 줄의 표시가 차량마다, §18 R4-16).
   */
  vanLink?: 'offline' | 'stuck' | 'asleep' | 'two';
}

/** 붙잡은 보내기(?flush=hold)를 놓는 때(실제 ms). */
export const FLUSH_HOLD_MS = 15_000;
/** 다시 붙어 보낸 뒤 띠 `전송 대기 0`을 두는 때(체험 시계 ms, 운영 DriverClient와 같은 2분). */
export const SETTLED_MS = 2 * 60_000;

/** 체험 주소의 연결 끊김 기록 뜻(main.tsx가 읽는다). */
export function demoOfflineFlags(search: string): Pick<FixtureClientOptions, 'flushHold' | 'flushStuck' | 'lostFirst' | 'vanLink' | 'recordingOff' | 'resendRefused'> {
  const q = new URLSearchParams(search);
  const van = q.get('van');
  return {
    ...(q.get('flush') === 'hold' ? { flushHold: true } : {}),
    ...(q.get('flush') === 'stuck' ? { flushStuck: true } : {}),
    ...(q.get('recording') === 'off' ? { recordingOff: true } : {}),
    ...(q.get('lost') === '1' ? { lostFirst: true } : {}),
    ...(q.get('resend') === 'refused' ? { resendRefused: true } : {}),
    ...(van === 'stuck' || van === 'asleep' || van === 'two' ? { vanLink: van } : {}),
  };
}

/** 체험판의 카운터 역할 권한(서버 provision의 카운터: 매장 설정 · 직원 · 기기 · 마감 해제 빼고 모두, 여기는 화면이 보는 것만). */
export const DEMO_COUNTER_PERMISSIONS: readonly string[] = [
  'stock.move', 'stock.receive', 'payment.take', 'payment.refund', 'order.create', 'order.add', 'order.promise.change', 'deposit.take', 'deposit.return',
  'closing.close', 'cash.transfer.confirm', 'task.pin', 'route.reorder', 'price_list.publish', 'discount.apply', 'discount.manual', 'order.cancel',
  'exchange.manage', 'stock.correct', 'review.resolve',
];

/** 체험판 카운터의 직접 입력 할인 한도(견본 값 10,000원, 규칙 검사기가 한도 밖의 숫자판을 잰다, features-1 §3-3). */
export const DEMO_COUNTER_LIMITS = Object.freeze({ maxDiscountAmount: 10_000 });

export const FIXTURE_STORAGE_KEY = 'skinote.demo.v1';

interface Saved {
  version: 3;
  state: FxState;
  /** 저장할 때의 체험 시계(ms). */
  clock: number;
  /** 매장 설정을 바꾼 수(체험판의 config_rev: 머리줄의 매장 이름이 따라 바뀐다). */
  configRev?: number;
  /** 견본 판(SAMPLE_REV)과 매장 모양. 다르면(옛 번호 · 보증금 견본으로 저장한 자료) 버리고 처음 자료로 시작한다. */
  sample?: string;
  /** 다시 붙어 보낸 뒤 띠 `전송 대기 0`을 두는 끝(체험 시계 ms). 다음 확인 창을 열면 걷는다. */
  settledUntil?: number;
  /** 기사 기기가 받은 답의 줄 메모(업무 id → 종류 · 때, §5-9): 보낸 뒤 하루 동안 기사 목록 · 업무 판에 보인다. */
  deviceNotes?: Record<string, DeviceOutcome>;
  /** 마지막으로 보낸 묶음의 줄 메모 종류 · 팀(띠 `전송 대기 0 · 매장 반납 완료 1팀`, work/impl-offline/plan.md §17 R3-26 · §18 R4-17). 옛 판은 종류만. */
  settledNotes?: (OutcomeNote | DeviceOutcome['key'])[];
}

/** 줄 메모를 두는 때(체험 시계, 운영 기기의 보낸 기록 24시간과 같음). */
const NOTE_KEEP_MS = 24 * 60 * MINUTE;

/** 저장한 띠의 줄 메모(옛 판은 종류만: 하나씩 다른 팀으로 센다). */
const notesOf = (saved: Saved['settledNotes']): OutcomeNote[] =>
  (saved ?? []).map((n, i) => (typeof n === 'string' ? { key: n, team: 'saved-' + i } : n));

/**
 * 견본 판: 견본 매장이 바뀌면 올린다(2026-09-26 첫 매장 답: 수량 · 보증금 없음 · 기사 현금 · 계좌이체; 같은 날 검토 반영: 규격 줄의 규격 ·
 * 밤 수거 늦음 90분 · 견본 매장의 돈 수단; 2026-09-27 매장 설정: 저장한 자료가 매장 목록 · 직원을 가진다; 같은 날 즉시 교환: 줄의 교환 기록;
 * 같은 날 리프트권: 줄의 분실 처리 · 회수 수, 차량 예비권 행; 같은 날 확인 필요: 저장된 확인 필요(견본 한 건 · 보냄 대기 수거의 기록); 2026-09-28
 * 기사 연결 끊김 기록: 마감이 차량 연결 사실로 막히고(옛 막힘으로 저장한 자료는 버림), 띠의 `전송 대기 0`을 저장).
 */
export const SAMPLE_REV = 'offline-2026-09-28';

/** 이 클라이언트가 맡은 기기: 카운터(포스) 또는 기사 기기. */
export type FixtureDevice = 'counter' | 'driver';

/** 되돌릴 때마다 새 epoch(같은 ms에 두 번 되돌려도 다르게). */
const newEpoch = (realMs: number) => 'demo-' + realMs.toString(36) + '-' + Math.random().toString(36).slice(2, 8);
const clone = <T,>(value: T): T => structuredClone(value);

export class FixtureClient implements DomainClient {
  private state: FxState;
  private anchorDemo: number;
  private anchorReal: number;
  private readonly settings: UiConfig;
  private readonly storage: FixtureStorage | null;
  private readonly key: string;
  private readonly realNow: () => number;
  private readonly listeners = new Set<(head: SyncHead) => void>();
  private readonly story: boolean;
  private readonly shop: SampleShop;
  private readonly viewer: ReadContext['viewer'];
  private configRev = 0;
  private device: FixtureDevice = 'counter';
  private readonly flushHold: boolean;
  private readonly flushStuck: boolean;
  private readonly recordingOff: boolean;
  private readonly lostFirst: boolean;
  /** ?resend=refused의 띠(운영 DriverClient처럼 다른 확인 창을 열어도 남는다, §18 R4-15). */
  private refused: { what: string; money?: string }[];
  private readonly vanLink: 'offline' | 'stuck' | 'asleep' | 'two';
  private settledUntil = 0;
  private deviceNotes: Record<string, DeviceOutcome> = {};
  private settledNotes: OutcomeNote[] = [];
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private settledTimer: ReturnType<typeof setTimeout> | null = null;
  /** 마감 넘기기 승인(체험): 승인 id → 날짜 · 처음 쓴 요청번호. */
  private readonly approvals = new Map<string, { date: string; requestId?: string }>();

  constructor(options: FixtureClientOptions = {}) {
    this.storage = options.storage ?? null;
    this.key = options.storageKey ?? FIXTURE_STORAGE_KEY;
    this.realNow = options.realNow ?? (() => Date.now());
    this.story = options.story ?? false;
    this.shop = options.shop ?? 'first';
    this.viewer = options.viewer === 'counter' ? { roleKey: 'counter', permissions: DEMO_COUNTER_PERMISSIONS, limits: DEMO_COUNTER_LIMITS } : undefined;
    this.flushHold = options.flushHold ?? false;
    this.flushStuck = options.flushStuck ?? false;
    this.recordingOff = options.recordingOff ?? false;
    this.lostFirst = options.lostFirst ?? false;
    // 체험의 받아들여지지 않은 현금 인계 350,000원(일 이름 · 돈은 운영 기기처럼 domain pendingLine의 말).
    const refusedLine = pendingLine(undefined, { type: 'cash.transfer', payload: { amount: 350_000 } } as unknown as AnyCommandEnvelope, 0);
    this.refused = options.resendRefused ? [{ what: refusedLine.what, ...(refusedLine.money ? { money: refusedLine.money } : {}) }] : [];
    this.vanLink = options.vanLink ?? 'offline';
    this.settings = defaultUiConfig({ shopName: sampleRegistry(this.shop).shopName, timezone: 'Asia/Seoul' });
    const saved = this.read();
    this.state = saved?.state ?? createSeed(newEpoch(this.realNow()), this.shop);
    this.configRev = saved?.configRev ?? 0;
    this.anchorDemo = saved?.clock ?? DEMO_START_MS;
    this.anchorReal = this.realNow();
    this.settledUntil = saved?.settledUntil ?? 0;
    this.deviceNotes = saved?.deviceNotes ?? {};
    this.settledNotes = notesOf(saved?.settledNotes);
    if (!saved) this.save();
    // 다시 붙었는데 보내지 않은 대기(붙잡은 채 새로 고침): 붙잡는 주소면 다시 붙잡고, 아니면 곧바로 보낸다.
    if (this.holding()) {
      if (this.flushHold) this.startHold();
      else if (!this.flushStuck) this.replay();
    }
    this.armSettled();
    if (options.listenToOtherTabs && typeof window !== 'undefined') {
      window.addEventListener('storage', (event) => {
        if (event.key !== this.key) return;
        const next = this.read();
        if (!next) return;
        this.state = next.state;
        this.configRev = next.configRev ?? 0;
        this.anchorDemo = next.clock;
        this.anchorReal = this.realNow();
        this.settledUntil = next.settledUntil ?? 0;
        this.deviceNotes = next.deviceNotes ?? {};
        this.settledNotes = notesOf(next.settledNotes);
        this.emit();
      });
    }
  }

  // ── 체험 전용(화면의 '나가기'가 부른다) ───────────────────────────────

  /** 체험 시계(ms). */
  now(): number {
    return this.anchorDemo + (this.realNow() - this.anchorReal);
  }

  /** 시계를 앞으로. 뒷이야기가 켜져 있으면 그 사이의 사건을 그 시각으로 적는다. */
  advanceClock(minutes: number): void {
    this.anchorDemo += minutes * MINUTE;
    // 사건의 명령은 applyCommand가 적용할 때 rev를 올린다(아래 emit이 화면에 알린다).
    if (this.story) applyStory(this.state, this.now(), applyCommand);
    this.save();
    this.emit();
  }

  /** 도장 · 수납을 모두 지우고 처음 자료 · 15:40으로. 열린 창의 명령은 epoch가 달라 거절된다. */
  reset(): void {
    this.state = createSeed(newEpoch(this.realNow()), this.shop);
    this.deviceNotes = {};
    this.settledUntil = 0;
    // 매장 설정도 처음으로(매장 이름 · 목록): 머리줄이 설정을 다시 받게 config_rev를 올린다.
    this.configRev += 1;
    this.anchorDemo = DEMO_START_MS;
    this.anchorReal = this.realNow();
    this.save();
    this.emit();
  }

  /** 시계를 저장한다(페이지를 닫을 때). */
  persist(): void {
    this.save();
  }

  /** 지금 화면이 어느 기기의 것인지(기사 화면을 열면 기사 기기). 같은 값이면 아무 일도 없다. */
  setDevice(device: FixtureDevice): void {
    this.device = device;
  }

  /**
   * 기사 기기의 연결을 끊거나 잇는다. 이으면 보냄 대기를 쌓인 순서대로 보낸다(각 명령은 기기에서 확인한 시각으로). ?flush=hold면 잠시 붙잡은 뒤
   * 보낸다(그동안 띠 `전송 중 · 전송 대기 n`). 보낸 뒤 2분(또는 다음 확인 창까지) 띠가 `전송 대기 0`이다.
   */
  setOffline(offline: boolean): void {
    const d = this.state.driverDevice;
    if (d.offline === offline) return;
    if (offline) {
      this.stopHold();
      this.state.driverDevice = { ...d, offline: true, since: this.now() };
      this.settledUntil = 0;
    } else if ((this.flushHold || this.flushStuck) && d.queue.length > 0) {
      this.state.driverDevice = { ...d, offline: false };
      if (this.flushHold) this.startHold();
    } else {
      this.state.driverDevice = { ...d, offline: false };
      this.replay();
      return;
    }
    this.save();
    this.emit();
  }

  /** 이 기기의 연결 상태. 카운터는 늘 연결되어 있다. */
  connection(): ConnectionState {
    const d = this.state.driverDevice;
    if (this.device !== 'driver') return { online: true, pendingCount: 0 };
    const holding = this.holding();
    const settled = !d.offline && !holding && this.settledUntil > this.now();
    return {
      online: !d.offline, pendingCount: d.queue.length, ...(d.since !== undefined ? { lastSyncAt: iso(d.since) } : {}),
      ...(holding && !this.flushStuck ? { sending: { remaining: d.queue.length } } : {}),
      ...(holding && this.lostFirst ? { unconfirmedCount: 1 } : {}),
      ...(settled ? { settled: true as const } : {}),
      ...(settled && this.settledNotes.length ? { settledNotes: outcomeNoteCounts(this.settledNotes) } : {}),
      ...(this.recordingOff ? { recordingOff: true as const } : {}),
      ...(this.refused.length > 0 ? { refusedCount: this.refused.length, refused: this.refused.map((r) => ({ ...r })) } : {}),
    };
  }

  /** 다음 확인 창을 열 때: 띠의 `전송 대기 0`을 걷는다(`처리 실패 · …`는 남는다, 운영 DriverClient.dismissResults와 같음, §18 R4-15). */
  dismissResults(): void {
    if (this.settledUntil === 0) return;
    this.settledUntil = 0;
    this.settledNotes = [];
    this.save();
    this.emit();
  }

  /**
   * 마감 넘기기의 관리자 승인(체험, O12): 넘길 권한(closing.reopen)이 있는 보는 사람이면 4 ~ 6자리 아무 숫자로 5분짜리 승인 id를 준다. 카운터
   * 역할(?viewer=counter)은 FORBIDDEN.
   */
  async closingApprove(date: string, ownPin: string): Promise<{ approvalId: string }> {
    if (this.viewer && !this.viewer.permissions.includes('closing.reopen')) throw new ServerRefusal('FORBIDDEN');
    if (!/^\d{4,6}$/.test(ownPin)) throw new ServerRefusal('PIN_MISMATCH');
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    const approvalId = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    this.approvals.set(approvalId, { date });
    return { approvalId };
  }

  /** 기사 기기의 연결이 끊겨 있는지(나가기 화면의 체험 단추). */
  driverOffline(): boolean {
    return this.state.driverDevice.offline;
  }

  /** 미리 보기 화면(로그인 타일)의 직원 이름: 견본 직원(SAMPLE_STAFF). 화면이 도메인을 가져오지 않게 체험판이 넘긴다(plan §6-3). */
  previewStaff(): string[] {
    return SAMPLE_STAFF.map((s) => s.name);
  }

  /**
   * 미리 보기(#/preview/settings-many): 체험 자료의 사본에 권종 다섯(청소년권)과 한 구역의 장소 열둘을 더한 매장으로 매장 설정 탭을 그린다
   * (쪽보다 긴 카드가 `(계속)`으로 이어지는지 규칙 검사기가 잰다). 체험 자료는 바꾸지 않는다.
   */
  async previewSettings(tab: SettingsTabKey, changes: SettingsOp[]): Promise<ShopSettingsView> {
    const { state, ctx } = this.context();
    const many = structuredClone(state);
    const lift = many.registry.kinds.find((k) => k.placement === 'grouped');
    const products = many.registry.products as Record<string, FxState['registry']['products'][string]>;
    if (lift) {
      const extra = lift.products.map((key) => products[key]!).map((p) => ({ ...p, key: p.key.replace('_adult', '_youth'), label: p.label.replace('성인', '청소년'), price: p.price - 5_000 }));
      for (const p of extra) products[p.key] = p;
      (lift as { products: string[] }).products = [...lift.products, ...extra.map((p) => p.key)];
    }
    const area = many.registry.areas.filter((a) => a.lodging).at(-1);
    if (area) {
      const more = ['은행나무', '소나무', '단풍나무', '느티나무', '자작나무', '벚나무'].map((label, i) => ({ id: 'preview-place-' + i, label }));
      (area as { places: { id: string; label: string }[] }).places = [...area.places, ...more];
    }
    return clone(runQuery(many, 'shopSettings', { tab, changes }, ctx));
  }

  /** 미리 보기 화면(기기 선택의 차량 타일): 체험 매장의 차량(id와 이름). */
  previewVehicles(): { id: string; name: string }[] {
    return this.state.registry.vehicles.filter((v) => !v.ended).map((v) => ({ id: v.id, name: v.label }));
  }

  // ── DomainClient ──────────────────────────────────────────────────

  async config(): Promise<UiConfig> {
    // 매장 이름은 저장한 자료의 것(매장 설정 `매장 정보`에서 바꾼다), config_rev는 매장 설정을 바꾼 수.
    return clone({ ...this.settings, shopName: this.state.registry.shopName, configRev: this.settings.configRev + this.configRev });
  }

  async ledgerView(viewKey: string, params: ViewParams): Promise<LedgerViewResult> {
    const { state, ctx } = this.context();
    return clone(ledgerView(state, viewKey, params, ctx));
  }

  async query<Q extends QueryName>(name: Q, params: QueryParams[Q]): Promise<QueryResult[Q]> {
    const { state, ctx } = this.context();
    return clone(runQuery(state, name, params, ctx));
  }

  async command(input: AnyCommandEnvelope): Promise<CommandOutcome> {
    if (this.device === 'driver' && (this.state.driverDevice.offline || this.holding())) return clone(this.enqueue(input));
    // 마감: 서버처럼 그때의 차량 연결 사실(links)과 승인(override)을 정규 본문에 적는다(O12). 승인이 맞지 않으면 거절.
    const canonical = input.type === 'closing.close' ? this.closingCanonical(input) : input;
    if ('outcome' in canonical) return clone(canonical);
    const envelope = canonical;
    const before = this.state.rev;
    const config = JSON.stringify([this.state.registry, this.state.settings, this.state.staff ?? []]);
    // 보는 사람(?viewer=counter)의 권한 · 한도로 할인을 다시 본다(서버의 세션 역할과 같은 길, features-1 E10).
    const outcome = applyCommand(this.state, envelope, this.now(), this.viewer ? { viewer: this.viewer } : {});
    // 매장 설정이 바뀌었으면 config_rev를 올린다(서버의 shops.config_rev: 명령마다 한 번).
    if (JSON.stringify([this.state.registry, this.state.settings, this.state.staff ?? []]) !== config) this.configRev += 1;
    this.save();
    if (this.state.rev !== before) this.emit();
    return clone(outcome);
  }

  subscribe(onChange: (head: SyncHead) => void): () => void {
    this.listeners.add(onChange);
    return () => this.listeners.delete(onChange);
  }

  async pending(): Promise<PendingCommand[]> {
    if (this.device !== 'driver') return [];
    // 붙잡은 보내기(?flush=hold)에서 답을 잃은 첫 항목(?lost=1)은 `결과 확인 중`(띠 · 점선 도장과 같은 상태).
    const holding = this.holding();
    return this.state.driverDevice.queue.map((q, i) => ({
      requestId: q.envelope.requestId, type: q.envelope.type, state: holding ? (this.lostFirst && i === 0 ? 'unconfirmed' : 'sending') : 'queued', createdAt: iso(q.at),
      summary: q.summary, line: pendingLine(this.state, q.envelope, q.at),
    }));
  }

  // ── 안쪽 ──────────────────────────────────────────────────────────

  /**
   * 오프라인 기사 기기: 허용된 명령은 보냄 대기에(같은 요청번호는 한 번만), 나머지는 한 줄로 돌려보낸다(운영 DriverClient와 같은 말: 끊겼으면
   * `입고 불가 · 연결 끊김` …, 붙잡은 보내기 중이면 `입고 불가 · 전송 대기 n`).
   */
  private enqueue(envelope: AnyCommandEnvelope): CommandOutcome {
    const base = { requestId: envelope.requestId, rev: this.state.rev, asOfRev: envelope.basis.rev, epoch: this.state.epoch, rebased: false, changes: [] };
    if (!OFFLINE_ALLOWED.has(envelope.type)) {
      const waiting = this.state.driverDevice.queue.length;
      if (!this.state.driverDevice.offline && (envelope.type === 'stock.receive' || envelope.type === 'cash.transfer')) {
        const message = envelope.type === 'stock.receive' ? say('receiveWaiting', { n: waiting }) : say('handoverWaiting', { n: waiting });
        return { ...base, outcome: 'rejected', error: { code: 'PENDING', message } };
      }
      return { ...base, outcome: 'rejected', error: { code: 'OFFLINE', message: offlineLine(envelope.type) } };
    }
    const queue = this.state.driverDevice.queue;
    if (!queue.some((q) => q.envelope.requestId === envelope.requestId)) {
      const at = this.now();
      // 보냄 대기의 명령은 기기 번호(deviceSeq)를 가진다: 서버는 돈의 바탕(expect)을 참고 값으로 적는다(sync 8-12).
      const seq = queue.reduce((max, q) => Math.max(max, q.envelope.deviceSeq ?? 0), 0) + 1;
      queue.push({ envelope: { ...envelope, deviceSeq: seq }, at, summary: this.summary(envelope, at) });
      this.save();
      this.emit();
    }
    return { ...base, outcome: 'queued' };
  }

  /** 전송 대기 목록의 한 줄('김민수 · 0025 수거 21:42', 기사 기기와 같은 말: domain pendingLine, §17 R3-19). */
  private summary(envelope: AnyCommandEnvelope, at: number): string {
    return pendingSummary(pendingLine(this.state, envelope, at));
  }

  /** 읽기 문맥: 지금 자료(기사 기기면 보냄 대기를 겹친 사본)와 화면 설정 · 체험 시계 · 체험 문구 · 차량 연결 사실(카운터가 본다). */
  private context(): { state: FxState; ctx: ReadContext } {
    const notes = this.device === 'driver' ? this.notes() : undefined;
    const base = {
      config: this.settings, now: this.now(), lines: DEMO_LINES, vehicleLinks: this.vehicleLinks(), ...(this.viewer ? { viewer: this.viewer } : {}),
      ...(notes?.size ? { deviceOutcomes: notes } : {}),
    };
    const queue = this.state.driverDevice.queue;
    if (this.device !== 'driver') return { state: this.state, ctx: base };
    // 바닥줄 · 업무 판의 `전송 대기`: 띠 · 더 보기와 같은 수(보냄 대기의 기록 수, §18 R4-11).
    if (queue.length === 0) return { state: this.state, ctx: { ...base, pendingRecordCount: 0 } };
    // 보냄 대기 겹치기(sync 8-1, plan §5-5): 서버 모드 기사 기기와 같은 overlayQueue. 수거 · 배달이 대기인 업무는 점선, 붙잡은 보내기에서 답을 잃은
    // 첫 항목(?lost=1)은 `결과 확인 중`.
    const holding = this.holding();
    const items: OverlayItem[] = queue.map((q, i) => ({
      envelope: q.envelope, at: q.at, state: holding ? (this.lostFirst && i === 0 ? 'unconfirmed' : 'sending') : 'queued',
    }));
    const overlay = overlayQueue(this.state, items, { lines: DEMO_LINES });
    return {
      state: overlay.state as FxState,
      ctx: {
        ...base, pendingTasks: overlay.pendingTasks, unconfirmedTasks: overlay.unconfirmedTasks, unplacedCount: overlay.unplaced.length, pendingMoney: overlay.pendingMoney,
        pendingRecordCount: queue.length,
      },
    };
  }

  /** 기사 기기의 줄 메모(하루 안의 것). */
  private notes(): Map<string, DeviceOutcome> {
    const now = this.now();
    return new Map(Object.entries(this.deviceNotes).filter(([, n]) => now - n.at < NOTE_KEEP_MS));
  }

  /** 다시 붙었는데 아직 보내지 않은 대기가 있음(?flush=hold가 붙잡은 동안). */
  private holding(): boolean {
    const d = this.state.driverDevice;
    return !d.offline && d.queue.length > 0;
  }

  private startHold(): void {
    this.stopHold();
    this.holdTimer = setTimeout(() => { this.holdTimer = null; this.replay(); }, FLUSH_HOLD_MS);
  }

  private stopHold(): void {
    if (this.holdTimer !== null) clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }

  /** 보냄 대기를 쌓인 순서대로 적용한다(각 명령은 기기에서 확인한 시각으로). 보낸 것이 있으면 2분 동안 띠 `전송 대기 0`. */
  private replay(): void {
    this.stopHold();
    const d = this.state.driverDevice;
    if (d.offline) return;
    const notes: OutcomeNote[] = [];
    for (const q of d.queue) {
      // 그 명령이 더한 확인 필요 종류로 줄 메모(서버 답의 reviews와 같은 셈): 그사이 매장 반납 · 받은 수 확인 · 같은 돈 두 번. 할 일이 없어 적지 않은
      // 순서 변경 · 긴급 확인 · 끝난 도장은 메모가 없다(§18 R4-14). 띠는 팀마다 한 번(§18 R4-17).
      const before = (this.state.reviews ?? []).length;
      const outcome = applyCommand(this.state, q.envelope, q.at);
      const kinds = (this.state.reviews ?? []).slice(before).map((r) => r.kindKey);
      const key = outcomeNoteKey(outcome.outcome, kinds, { type: q.envelope.type, ...(outcome.error ? { errorCode: outcome.error.code } : {}) });
      const taskId = (q.envelope.payload as { taskId?: string }).taskId;
      if (key) {
        if (taskId) this.deviceNotes[taskId] = { key, at: this.now() };
        notes.push({ key, team: recordTeam(q.envelope.payload) ?? q.envelope.requestId });
      }
    }
    const sent = d.queue.length;
    if (sent > 0) this.settledNotes = notes;
    this.state.driverDevice = { offline: false, queue: [], ...(d.vehicleId ? { vehicleId: d.vehicleId } : {}) };
    if (sent > 0) this.settledUntil = this.now() + SETTLED_MS;
    this.armSettled();
    this.save();
    this.emit();
  }

  /** 띠의 `전송 대기 0`이 끝나는 때에 다시 그린다. */
  private armSettled(): void {
    if (this.settledTimer !== null) clearTimeout(this.settledTimer);
    this.settledTimer = null;
    const left = this.settledUntil - this.now();
    if (left > 0) this.settledTimer = setTimeout(() => { this.settledTimer = null; this.emit(); }, left + 50);
  }

  /**
   * 카운터가 보는 차량 연결 사실(O11 · O19): 끊긴 기사 기기의 차량은 서버처럼 대기 수를 모르는 끊김(?van=stuck이면 알린 대기 수 · 보내지 못함,
   * ?van=asleep이면 주머니 속 휴대폰), 붙잡은 보내기 중에는 알린 대기 수 · 보내지 못함. 연결된 기기는 없음.
   */
  private vehicleLinks(): VehicleLink[] {
    const d = this.state.driverDevice;
    if (!d.offline && !this.holding()) return [];
    const vehicleId = d.vehicleId ?? 'v1';
    const since = d.since !== undefined ? iso(d.since) : undefined;
    const at = since ? { since, lastContactAt: since } : {};
    const kind = { deviceKind: 'driver_tablet' as const };
    // 두 차량이 함께 산에(?van=two, §18 R4-16): 기사 기기의 차량은 보내지 못함(알린 대기 수), 다른 차량은 끊김.
    if (this.vanLink === 'two') {
      const other = this.state.registry.vehicles.find((v) => v.id !== vehicleId)?.id;
      return [
        { vehicleId, state: 'stuck', ...at, reportedPending: Math.max(1, d.queue.length), ...kind },
        ...(other ? [{ vehicleId: other, state: 'offline' as const, ...at, reportedPending: null, deviceKind: 'driver_phone' as const }] : []),
      ];
    }
    if (!d.offline || this.vanLink === 'stuck') return [{ vehicleId, state: 'stuck', ...at, reportedPending: d.queue.length, ...kind }];
    if (this.vanLink === 'asleep') return [{ vehicleId, state: 'asleep', ...at, reportedPending: 0, ...kind }];
    return [{ vehicleId, state: 'offline', ...at, reportedPending: null, ...kind }];
  }

  /** 마감 명령의 정규 본문(서버 api.js closingPrepare와 같은 일): 승인(unsynced)은 빼고 links · override를 적는다. */
  private closingCanonical(envelope: Extract<AnyCommandEnvelope, { type: 'closing.close' }>): AnyCommandEnvelope | CommandOutcome {
    const { unsynced, links: _links, override: _override, ...rest } = envelope.payload;
    const links: VehicleLinkFact[] = this.vehicleLinks().map((l) => ({
      vehicleId: l.vehicleId, state: l.state, reportedPending: l.reportedPending, ...(l.since !== undefined ? { since: l.since } : {}), ...(l.state === 'stuck' ? { stuck: true } : {}),
    }));
    if (!unsynced) return { ...envelope, payload: { ...rest, links } };
    const approval = this.approvals.get(unsynced.approvalId);
    if (!approval || approval.date !== rest.date || (approval.requestId !== undefined && approval.requestId !== envelope.requestId)) {
      return {
        outcome: 'rejected', requestId: envelope.requestId, rev: this.state.rev, asOfRev: envelope.basis.rev, epoch: this.state.epoch, rebased: false, changes: [],
        error: { code: 'APPROVAL_INVALID', message: say('commandFailed') },
      };
    }
    approval.requestId = envelope.requestId;
    return { ...envelope, payload: { ...rest, links, override: { approvalId: unsynced.approvalId, reason: unsynced.reason, approvedBy: 'demo' } } };
  }

  private emit(): void {
    const head: SyncHead = { epoch: this.state.epoch, rev: this.state.rev, configRev: this.settings.configRev + this.configRev };
    for (const listener of [...this.listeners]) listener(head);
  }

  private read(): Saved | null {
    try {
      const raw = this.storage?.getItem(this.key);
      if (!raw) return null;
      const saved = JSON.parse(raw) as Saved;
      // 옛 판(2 이하)으로 저장된 체험 자료는 버리고 처음 자료로 시작한다(판 3: 운영 규칙 · 번호 · 보증금 · 돈통).
      if (saved.version !== 3 || saved.state?.version !== 3 || !Array.isArray(saved.state.orders) || !saved.state.driverDevice || !saved.state.settings
        || typeof saved.clock !== 'number') return null;
      // 다른 견본(옛 번호 · 보증금 견본, 다른 매장 모양)으로 저장한 자료는 버린다: 줄의 재고 방식 · 운영 규칙이 지금 목록과 맞지 않는다.
      if (saved.sample !== this.sampleKey()) return null;
      // 매장 목록(registry) · 직원은 저장한 자료의 것이다(매장 설정에서 바꾼다, features-1). 없는 옛 자료는 버린다(견본 판이 다르다).
      if (!saved.state.registry || !Array.isArray(saved.state.staff)) return null;
      return saved;
    } catch {
      return null;
    }
  }

  /** 저장 자료의 견본 표시(판 · 모양). */
  private sampleKey(): string {
    return SAMPLE_REV + ':' + this.shop;
  }

  private save(): void {
    try {
      const saved: Saved = {
        version: 3, state: this.state, clock: this.now(), configRev: this.configRev, sample: this.sampleKey(), ...(this.settledUntil > 0 ? { settledUntil: this.settledUntil } : {}),
        ...(Object.keys(this.deviceNotes).length ? { deviceNotes: this.deviceNotes } : {}), ...(this.settledNotes.length ? { settledNotes: this.settledNotes } : {}),
      };
      this.storage?.setItem(this.key, JSON.stringify(saved));
    } catch {
      // 저장이 막힌 브라우저에서도 체험은 돈다(새로 고치면 처음 자료).
    }
  }
}

/** 끊긴 기사 기기의 연결이 있어야 하는 일(운영 local-client offlineRefusalLine과 같은 말, 문구 표 3-10 · 3-21). */
function offlineLine(type: CommandType): string {
  if (type === 'stock.receive') return say('receiveNeedsLink');
  if (type === 'cash.transfer') return say('handoverNeedsLink');
  if (type === 'payment_promise.set') return say('deferNeedsLink');
  return say('offlineLater');
}
