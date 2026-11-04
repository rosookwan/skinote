// 앱 시작 · 앱 잠금(work/impl-offline/plan.md O15 · §7-6 · §7-9 remembered · app-lock · runtime): 기억한 세션의 유효 셈(서버의 세션 끝 · 쉬는 시간 ·
// 사본 24시간 창 · 시계 톱니 · 앱 잠금 · 다섯 번 틀림), PBKDF2 확인 값(적은 반복 수), 기억한 세션으로 서버를 기다리지 않는 모드, 저장소의 봉인 칸
// (사본 열쇠 · 사본을 새로 쓰면 새 열쇠로 다시 봉인 · 로그아웃이 지움), 잠금 판 · 알림의 한 줄.
import type { SessionInfo } from '@skinote/contract';
import { describe, expect, it, vi } from 'vitest';
import { decideMode, type LocalStart, type SessionProbe } from '../src/app/runtime.ts';
import { elsewhereLine } from '../src/app/session-context.ts';
import { unlockLine } from '../src/app/session.tsx';
import { checkPin, createVerifier, isVerifier, lockDue, lockoutMinutes, MAX_PIN_FAILURES } from '../src/local/app-lock.ts';
import { rememberedDriverStart } from '../src/local/boot.ts';
import { COPY_FMT, LocalStore, STATE_VERSION, type CopyHead } from '../src/local/local-store.ts';
import { MemoryRawStore } from '../src/local/raw-store.ts';
import { isRemembered, REMEMBERED_ID, rememberedStart, VERIFIER_ID, type RememberedInput, type RememberedSession } from '../src/local/remembered.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-12-26T12:00:00.000Z'); // 21:00 KST

const SESSION: SessionInfo = {
  shop: { name: '첫 매장' },
  staff: { id: '01J00000000000000000000003', name: '문태오', roleKey: 'driver' },
  device: { id: '01J00000000000000000000004', kind: 'driver_phone', label: '기사 휴대폰 1', vehicleId: 'v1' },
  csrf: 'x'.repeat(43),
  idleTimeoutS: 14 * 24 * 3600,
  serverTime: new Date(T0).toISOString(),
  session: { id: '01J00000000000000000000005', expiresAt: new Date(T0 + 14 * 24 * HOUR).toISOString(), idleTimeoutS: 14 * 24 * 3600 },
  vehicleId: 'v1',
  policy: { localFirst: true, heartbeatMs: 20_000, piiWipeHours: 24, sentPiiHours: 24, sentLogDays: 7, appLockMinutes: 5, maxBackdateHours: 168, futureSkewMinutes: 5, clockWarnMinutes: 2 },
};

const record = (session: SessionInfo = SESSION): RememberedSession => ({ fmt: 1, session, savedAt: T0 });

const input = (patch: Partial<RememberedInput> = {}): RememberedInput => ({
  now: T0 + 2 * MIN,
  record: record(),
  copyOk: true,
  verifier: true,
  meta: { lastContactAt: T0, lastTouchAt: T0, lastUseAt: T0 + MIN, maxSeenWall: T0 + MIN, clockOffsetMs: 0 },
  policy: { piiWipeHours: 24, appLockMinutes: 5, clockWarnMinutes: 2 },
  ...patch,
});

describe('기억한 세션의 유효 셈(rememberedStart, 순수)', () => {
  it('유효하고 방금 썼으면 서버 없이 곧바로 목록(open), 5분이 지났으면 잠금(locked)', () => {
    expect(rememberedStart(input())).toEqual({ decision: 'open' });
    expect(rememberedStart(input({ now: T0 + MIN + 5 * MIN }))).toEqual({ decision: 'locked' });
    // 태블릿(30분)은 5분 뒤에도 열린다.
    expect(rememberedStart(input({ now: T0 + 10 * MIN, policy: { piiWipeHours: 24, appLockMinutes: 30, clockWarnMinutes: 2 } })).decision).toBe('open');
  });

  it('없으면 none, 사본을 읽을 수 없거나 확인 값이 없으면 expired(서버에 묻는 길)', () => {
    expect(rememberedStart(input({ record: null }))).toEqual({ decision: 'none', why: 'no_record' });
    expect(rememberedStart(input({ copyOk: false }))).toEqual({ decision: 'expired', why: 'no_copy' });
    expect(rememberedStart(input({ verifier: false }))).toEqual({ decision: 'expired', why: 'no_verifier' });
    // 세션이 끝난 까닭이 먼저다(켤 때의 지움 시계가 그때만 지운다, §17-2).
    expect(rememberedStart(input({ copyOk: false, now: T0 - 10 * MIN })).why).toBe('clock');
    expect(rememberedStart(input({ verifier: false, now: T0 + 25 * HOUR, meta: { ...input().meta, lastUseAt: T0 + 25 * HOUR, maxSeenWall: T0 + 25 * HOUR } })).why).toBe('copy_window');
  });

  it('세션의 끝(서버 시각: 벽시계 + 차이) · 쉬는 시간(사람이 한 일을 보낸 때부터) · 사본 24시간 창이 지나면 expired', () => {
    const short = { ...SESSION, session: { ...SESSION.session!, expiresAt: new Date(T0 + HOUR).toISOString() } };
    expect(rememberedStart(input({ record: record(short), now: T0 + HOUR + 1 })).why).toBe('expired');
    // 기기 시계가 서버보다 10분 늦으면(차이 +10분) 서버 시각으로 끝을 넘는다.
    expect(rememberedStart(input({ record: record(short), now: T0 + 55 * MIN, meta: { ...input().meta, clockOffsetMs: 10 * MIN } })).why).toBe('expired');
    const idle = { ...SESSION, session: { ...SESSION.session!, idleTimeoutS: 3600 } };
    expect(rememberedStart(input({ record: record(idle), now: T0 + HOUR + 1, meta: { ...input().meta, lastUseAt: T0 + HOUR } })).why).toBe('idle');
    expect(rememberedStart(input({ now: T0 + 24 * HOUR, meta: { ...input().meta, lastTouchAt: T0 + 23 * HOUR, lastUseAt: T0 + 24 * HOUR - MIN, maxSeenWall: T0 + 24 * HOUR - MIN } })).why).toBe('copy_window');
  });

  it('시계 톱니: 벽시계가 본 가장 늦은 때보다 2분 넘게 뒤면 끝난 것(시계를 돌려 창을 늘리지 못한다)', () => {
    expect(rememberedStart(input({ now: T0 - 10 * MIN })).why).toBe('clock');
    expect(rememberedStart(input({ now: T0 + MIN - MIN, meta: { ...input().meta, lastUseAt: T0 - MIN } })).decision).toBe('open');
  });

  it(`틀려서 잠긴 동안은 그 시각까지 잠김(locked_out), 지나면 비밀번호 판(${MAX_PIN_FAILURES}번 넘게 틀린 뒤에는 늘), 기억한 세션은 남는다(§17 R3-24)`, () => {
    expect(rememberedStart(input({ meta: { ...input().meta, lockFailures: MAX_PIN_FAILURES, lockUntil: T0 + 7 * MIN } }))).toEqual({ decision: 'locked', why: 'locked_out' });
    expect(rememberedStart(input({ now: T0 + 8 * MIN, meta: { ...input().meta, lockFailures: MAX_PIN_FAILURES, lockUntil: T0 + 7 * MIN, lastUseAt: T0 + 7 * MIN, maxSeenWall: T0 + 7 * MIN } }))).toEqual({ decision: 'locked' });
    expect(rememberedStart(input({ meta: { ...input().meta, lockFailures: MAX_PIN_FAILURES - 1 } })).decision).toBe('open');
  });

  it('잠김은 다섯 번마다 5 · 10 · 20 …분, 24시간까지(그 사이의 틀림은 잠그지 않는다)', () => {
    expect([1, 4, 5, 6, 9, 10, 15, 20].map(lockoutMinutes)).toEqual([0, 0, 5, 0, 0, 10, 20, 40]);
    expect(lockoutMinutes(MAX_PIN_FAILURES * 20)).toBe(24 * 60);
  });

  it('기억한 세션 모양: 기사 기기 · 세션 id가 있는 것만', () => {
    expect(isRemembered(record())).toBe(true);
    expect(isRemembered({ ...record(), session: { ...SESSION, device: { ...SESSION.device, kind: 'pos' } } })).toBe(false);
    const { session: _s, ...old } = SESSION;
    expect(isRemembered({ fmt: 1, session: old, savedAt: T0 })).toBe(false);
  });
});

describe('앱 잠금의 확인 값(PBKDF2, 적은 반복 수)', () => {
  it('맞는 비밀번호만 맞고, 소금이 달라 같은 비밀번호도 값이 다르다', async () => {
    const v = await createVerifier('4821', 'staff-1', 1_000);
    expect(isVerifier(v)).toBe(true);
    expect(v.hash).not.toContain('4821');
    expect(await checkPin(v, '4821')).toBe(true);
    expect(await checkPin(v, '4822')).toBe(false);
    expect(await checkPin(v, '')).toBe(false);
    expect(await checkPin(v, '48211234')).toBe(false);
    const again = await createVerifier('4821', 'staff-1', 1_000);
    expect(again.hash).not.toBe(v.hash);
  });

  it('잠글 때: 마지막 사용에서 분이 지났거나, 모르거나, 시계가 뒤로 갔으면', () => {
    expect(lockDue(T0 + 4 * MIN, T0, 5)).toBe(false);
    expect(lockDue(T0 + 5 * MIN, T0, 5)).toBe(true);
    expect(lockDue(T0, undefined, 5)).toBe(true);
    expect(lockDue(T0 - MIN, T0, 30)).toBe(true);
  });
});

describe('기억한 세션 · 확인 값의 봉인 칸(사본 열쇠)', () => {
  it('사본이 없어도 새 사본 열쇠로 봉인해 두고, 사본을 새로 쓰면 새 열쇠로 다시 봉인되며, 사본을 지우면 함께 지워진다', async () => {
    const raw = new MemoryRawStore();
    const local = new LocalStore({ raw, deviceId: SESSION.device.id, channel: null });
    await local.writeSessionRecord(REMEMBERED_ID, record());
    await local.writeSessionRecord(VERIFIER_ID, await createVerifier('4821', 'staff-1', 1_000));
    expect(isRemembered(await local.readSessionRecord(REMEMBERED_ID))).toBe(true);
    const before = (await local.keys.list()).filter((k) => k.kind === 'copy').map((k) => k.id);
    expect(before).toHaveLength(1);
    // 다른 화면(새 LocalStore)도 연다.
    const other = new LocalStore({ raw, deviceId: '', channel: null });
    expect(isVerifier(await other.readSessionRecord(VERIFIER_ID))).toBe(true);
    await local.dropCopy();
    expect(await local.readSessionRecord(REMEMBERED_ID)).toBeNull();
    expect(await local.readSessionRecord(VERIFIER_ID)).toBeNull();
    expect((await local.keys.list()).filter((k) => k.kind === 'copy')).toHaveLength(0);
  });

  it('기기 메모에 마지막 사용 · 틀린 수가 남는다(봉인하지 않음, 개인정보 없음)', async () => {
    const local = new LocalStore({ raw: new MemoryRawStore(), deviceId: 'd', channel: null });
    await local.patchMeta({ lastUseAt: T0, lockFailures: 2 });
    expect(await local.readMeta()).toMatchObject({ lastUseAt: T0, lockFailures: 2 });
  });
});

describe('기억한 세션으로 여는 모드(runtime decideMode)', () => {
  const start: LocalStart = { decision: 'open', session: SESSION, pending: 2 };

  it('서버 표시 + 유효한 기억한 세션: 서버에 묻지 않고 server-local(잠금 · 잠김 포함)', async () => {
    const probe = vi.fn(async (): Promise<SessionProbe> => ({ kind: 'offline' }));
    expect(await decideMode({ marker: 'server', search: '', probe, localStart: async () => start })).toEqual({ mode: 'server-local', start });
    const locked = { ...start, decision: 'locked' as const, lockUntil: T0 + 5 * MIN };
    expect(await decideMode({ marker: 'server', search: '', probe, localStart: async () => locked })).toEqual({ mode: 'server-local', start: locked });
    expect(probe).not.toHaveBeenCalled();
  });

  it('기억한 세션이 없거나 읽기가 던지면 평소처럼 서버에 묻는다. 체험판은 저장소를 읽지 않는다', async () => {
    const probe = vi.fn(async (): Promise<SessionProbe> => ({ kind: 'offline' }));
    expect(await decideMode({ marker: 'server', search: '', probe, localStart: async () => null })).toEqual({ mode: 'server-offline' });
    expect(await decideMode({ marker: 'server', search: '', probe, localStart: async () => { throw new Error('idb'); } })).toEqual({ mode: 'server-offline' });
    const local = vi.fn(async () => start);
    expect(await decideMode({ marker: null, search: '', probe, localStart: local })).toEqual({ mode: 'demo' });
    expect(local).not.toHaveBeenCalled();
  });
});

describe('잠금 판 · 알림의 한 줄(문구 표 3-17 · 3-21)', () => {
  it('맞음은 없음, 틀림은 `비밀번호 불일치 · 재입력 필요`, 틀려서 잠김은 `로그인 잠김 · {시각} 이후 가능`(시각까지 남음), 기기에서 풀 수 없으면 `로그인 잠김 · 연결 후 가능`', () => {
    const tz = 'Asia/Seoul';
    expect([unlockLine({ answer: 'ok' }, tz), unlockLine({ answer: 'wrong' }, tz), unlockLine({ answer: 'login' }, tz)]).toEqual([null, '비밀번호 불일치 · 재입력 필요', '로그인 잠김 · 연결 후 가능']);
    expect(unlockLine({ answer: 'locked', until: T0 + 5 * MIN }, tz)).toEqual({ line: '로그인 잠김 · 21:05 이후 가능', lockedUntil: new Date(T0 + 5 * MIN).toISOString() });
  });

  it('같은 차량의 다른 기기: 옛 서버는 휴대폰 · 태블릿의 줄, 서버가 기기를 알려 주면 등록 이름 · 직원 · 수(§17 R3-28)', () => {
    expect(elsewhereLine({ deviceKind: 'driver_phone', pending: null }, '1호 차량')).toBe('1호 차량 휴대폰 미전송 기록 가능 · 휴대폰 전송 필요');
    expect(elsewhereLine({ deviceKind: 'driver_tablet', pending: 2 }, '2호 차량')).toBe('2호 차량 태블릿 미전송 기록 가능 · 태블릿 전송 필요');
    expect(elsewhereLine({ deviceKind: 'driver_phone', pending: 2, label: '1호 차량 휴대폰', staffName: '박기사' }, '1호 차량'))
      .toBe('1호 차량 휴대폰 · 박기사 기록 2건 전송 대기 · 해당 기기 전송 필요');
    expect(elsewhereLine({ deviceKind: 'driver_phone', pending: null, label: '1호 차량 휴대폰', staffName: '박기사' }, '1호 차량'))
      .toBe('1호 차량 휴대폰 · 박기사 미전송 기록 가능 · 해당 기기 전송 필요');
    // 다시 띄운 서버는 직원을 모른다: 등록 이름만.
    expect(elsewhereLine({ deviceKind: 'driver_tablet', pending: 1, label: '1호 차량 태블릿' }, '1호 차량')).toBe('1호 차량 태블릿 기록 1건 전송 대기 · 해당 기기 전송 필요');
  });
});

describe('켤 때의 지움 시계(boot, §17 R3-9): 기억한 세션으로 열 수 없으면 사본 · 세션 칸을 지우고 보냄 대기는 남긴다', () => {
  const head = (over: Partial<CopyHead> = {}): CopyHead => ({
    fmt: COPY_FMT, appVersion: 'v', stateVersion: STATE_VERSION, epoch: 'E1', rev: 1, hash: 'h', configRev: 1, vehicleId: 'v1', businessDate: '2026-12-26', cutoff: '06:00',
    storedAt: T0, scrubbed: false, policy: SESSION.policy!, restoredUpToRev: null, ...over,
  });
  async function seeded(meta: Record<string, unknown>) {
    const raw = new MemoryRawStore();
    const local = new LocalStore({ raw, deviceId: SESSION.device.id, channel: null });
    await local.writeCopy(head(), { state: { orders: [] } as never, config: {} as never });
    await local.writeSessionRecord(REMEMBERED_ID, record());
    await local.writeSessionRecord(VERIFIER_ID, await createVerifier('4821', SESSION.staff.id, 1_000));
    await local.patchMeta({ lastContactAt: T0, lastTouchAt: T0, lastUseAt: T0, maxSeenWall: T0, ...meta });
    await raw.tx(['queue'], 'readwrite', (t) => t.put('queue', { requestId: 'r1', seq: 1, state: 'queued' }));
    // 켜기는 저장소를 닫는다: 시험은 닫지 않는 겉(같은 칸)을 넘긴다.
    const view = Object.assign(Object.create(raw) as MemoryRawStore, { close: () => {} });
    return { raw, local, open: async () => view };
  }

  it('유효하면 열고 아무것도 지우지 않는다', async () => {
    const { raw, open } = await seeded({});
    expect(await rememberedDriverStart(T0 + MIN, open)).toMatchObject({ decision: 'open', pending: 1 });
    expect(raw.size('snapshot')).toBe(1);
  });

  it('24시간 창이 지났거나 시계가 뒤로 갔거나 기억한 세션이 없으면: 사본 · 기억한 세션 · 확인 값 · 사본 열쇠를 지우고 null, 보냄 대기는 남는다', async () => {
    for (const [name, now, meta] of [
      ['copy window', T0 + 25 * HOUR, {}],
      ['clock back', T0 - 30 * MIN, {}],
    ] as const) {
      const { raw, local, open } = await seeded(meta);
      expect(await rememberedDriverStart(now, open), name).toBeNull();
      expect(raw.size('snapshot'), name).toBe(0);
      expect(raw.size('session'), name).toBe(0);
      expect((await local.keys.list()).filter((k) => k.kind === 'copy'), name).toHaveLength(0);
      expect(raw.size('queue'), name).toBe(1);
    }
    const { raw, local, open } = await seeded({});
    await local.deleteSessionRecord(REMEMBERED_ID);
    expect(await rememberedDriverStart(T0 + MIN, open)).toBeNull();
    expect([raw.size('snapshot'), raw.size('session'), raw.size('queue')]).toEqual([0, 0, 1]);
  });

  it('세션은 유효한데 이 빌드가 모르는 사본 형식이면 지우지 않고 서버에 묻는다(새 사본이 덮음); 24시간 창이 지났으면 지운다(§17-2)', async () => {
    const stale = await seeded({});
    await stale.local.writeCopy(head({ stateVersion: STATE_VERSION + 99 }), { state: { orders: [] } as never, config: {} as never });
    expect(await rememberedDriverStart(T0 + MIN, stale.open)).toBeNull();
    expect([stale.raw.size('snapshot') > 0, stale.raw.size('session'), stale.raw.size('queue')]).toEqual([true, 2, 1]);
    const late = await seeded({});
    await late.local.writeCopy(head({ stateVersion: STATE_VERSION + 99 }), { state: { orders: [] } as never, config: {} as never });
    expect(await rememberedDriverStart(T0 + 25 * HOUR, late.open)).toBeNull();
    expect([late.raw.size('snapshot'), late.raw.size('session'), late.raw.size('queue')]).toEqual([0, 0, 1]);
  });

  it('틀려서 잠긴 동안은 잠금 판(그 시각)으로 연다(지우지 않는다)', async () => {
    const { raw, open } = await seeded({ lockFailures: 5, lockUntil: T0 + 10 * MIN });
    expect(await rememberedDriverStart(T0 + MIN, open)).toMatchObject({ decision: 'locked', lockUntil: T0 + 10 * MIN });
    expect(raw.size('snapshot')).toBe(1);
  });
});
