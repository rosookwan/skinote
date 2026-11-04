// LocalClient(work/impl-offline/plan.md §7-3 · §5-5 · §5-8 · §5-9, §7-9 local-client.test): 사본 + 보냄 대기 겹침으로 서버와 같은 기사 읽기 모델, 기사 세션의
// 거절 표, 자기 차량으로 바꿔 읽기, 연결이 있어야 하는 명령의 한 줄, 확인 전 검사(사본을 새로 받아도 창이 실패하지 않음 · 받을 돈이 바뀌면 충돌 · 같은
// 돈 두 번), 결과 확인 중의 누름 메모, 사본 밖 항목의 수, 기기 자신의 답의 줄 메모, 저장할 곳이 없을 때.
import {
  DomainError, envelopeFor, openCommandDraft, type AnyCommandEnvelope, type ConfirmCommand, type Expect, type LedgerViewResult, type StampCell,
} from '@skinote/contract';
import { describe, expect, it } from 'vitest';
import { stampItem } from '../src/local/clock.ts';
import { LocalClient } from '../src/local/local-client.ts';
import { LocalStore, MemoryChannelHub, PageLocks } from '../src/local/local-store.ts';
import { SendQueue } from '../src/local/queue.ts';
import { MemoryRawStore } from '../src/local/raw-store.ts';
import { localWords } from '../src/app/strings.ts';
import { at, TestClocks } from './fake-server.ts';
import { copyBody, copyHead } from './local-helpers.ts';

const DEVICE = '01JF00000000000000000DEV01';

async function setup(options: { offline?: boolean; raw?: MemoryRawStore } = {}) {
  const raw = options.raw ?? new MemoryRawStore();
  const clocks = new TestClocks(at(22, 0));
  const local = new LocalStore({ raw, deviceId: DEVICE });
  const queue = new SendQueue(local);
  const body = copyBody();
  if (!options.raw) await local.writeCopy(copyHead({ epoch: body.state.epoch, rev: body.state.rev }), body);
  const client = new LocalClient({
    local, queue, device: { id: DEVICE, kind: 'driver_phone' }, staff: { id: 'staff-3', name: '문태오' }, sessionId: '01JF0SESS000000000000000AA',
    serverNow: () => clocks.wall(), stamp: () => stampItem(clocks, 'pageanchor12', 0), offline: () => options.offline ?? true, wallNow: () => clocks.wall(), words: localWords(),
  });
  await client.reload();
  return { raw, clocks, local, queue, client };
}

/** 창이 하는 것: 읽기 모델의 명령 · 바탕으로 초안 → 봉투. */
function envelopeOf(view: { basis: { epoch: string; rev: number }; command?: ConfirmCommand; expect?: Expect }): AnyCommandEnvelope {
  const draft = openCommandDraft(view.command!, view.basis, view.expect ? { expect: view.expect } : {});
  return envelopeFor(draft, view.command, view.expect)!;
}

const rowOf = (list: LedgerViewResult, taskId: string) => list.rows.find((r) => r.taskId === taskId)!;
const stampOf = (list: LedgerViewResult, taskId: string): StampCell => {
  const cell = Object.values(rowOf(list, taskId).cells).find((c) => c.renderer === 'stamp');
  return (cell as { stamp: StampCell }).stamp;
};
const metric = (list: LedgerViewResult, key: string) => {
  const m = list.metrics.find((x) => x.metricKey === key);
  return m && 'value' in m ? m.value : undefined;
};

describe('읽기(기사 세션 규칙)', () => {
  it('목록은 자기 차량으로 바꿔 읽고, deny · 다른 차량 업무 · 다른 차량 짐은 FORBIDDEN', async () => {
    const { client } = await setup();
    const list = await client.ledgerView('collection_list', { vehicleId: 'v2', deviceClass: 'driver_phone' });
    expect(list.vehicle?.id).toBe('v1');
    await expect(client.ledgerView('day_ledger', {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(client.query('orderSlip', { orderId: 'o25' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(client.query('reviewList', {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(client.query('vehicleLoad', { vehicleId: 'v2' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // 사본에 없는 업무(다른 차량): 서버처럼 범위를 모르면 거절.
    await expect(client.query('taskSheet', { taskId: 'collect:o99' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await client.query('taskSheet', { taskId: 'collect:o25' })).team).toContain('김민수');
  });

  it('전화 창은 사본의 번호: 오늘 열린 업무는 온전한 번호', async () => {
    const { client } = await setup();
    expect((await client.query('phoneReveal', { orderId: 'o25' })).number).toBe('010-0000-0025');
  });

  it('사본이 없으면 NETWORK(화면은 `… 조회 실패`)', async () => {
    const { client } = await setup({ raw: new MemoryRawStore() });
    expect(client.hasCopy()).toBe(false);
    await expect(client.ledgerView('collection_list', {})).rejects.toBeInstanceOf(DomainError);
    await expect(client.config()).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('06:00을 넘기면 오늘 영업일이 바뀐다(서버 시각 짐작 + 사본의 기준 시각)', async () => {
    const { client, clocks } = await setup();
    expect(client.today()).toBe('2026-12-26');
    clocks.wallMs = at(6, 1, 1);
    expect(client.today()).toBe('2026-12-27');
  });
});

describe('명령', () => {
  it('연결이 있어야 하는 명령은 한 줄 거절(입고 · 인계 · 후불 · 그 밖), 아무것도 넣지 않는다', async () => {
    const { client, queue } = await setup();
    const base = { commandVersion: 1, requestId: '01JF3Q8W2Z6N9XK4T7B5R1C0DM', basis: { epoch: 'e', rev: 1 } };
    const refused = async (type: string, payload: unknown) => (await client.command({ ...base, type, payload } as AnyCommandEnvelope)).error?.message;
    expect(await refused('stock.receive', { vehicleId: 'v1', taskIds: [] })).toBe('입고 불가 · 연결 끊김');
    expect(await refused('cash.transfer', { vehicleId: 'v1', amount: 1 })).toBe('인계 불가 · 연결 끊김');
    expect(await refused('payment_promise.set', { orderId: 'o25', payerOrderId: null })).toBe('후불 처리 불가 · 연결 끊김');
    expect(await refused('promise.change', { orderId: 'o25', kind: 'return', lines: [], promise: { mode: 'store' } })).toBe('연결 끊김 · 연결 후 가능');
    expect((await queue.list()).items).toHaveLength(0);
  });

  it('수거를 넣으면 queued: 목록은 점선 도장 · 전송 대기 1, 답을 잃으면 누름 메모 `결과 확인 중`', async () => {
    const { client, queue } = await setup();
    const draft = await client.query('confirmDraft', { actionKey: 'stamp.collect', taskId: 'collect:o25', orderId: 'o25' });
    const envelope = envelopeOf(draft);
    const out = await client.command(envelope);
    expect(out.outcome).toBe('queued');
    let list = await client.ledgerView('collection_list', { deviceClass: 'driver_phone' });
    const stamp = stampOf(list, 'collect:o25');
    expect(stamp.pending).toBe(true);
    expect(stamp.pressNote?.lines[0]).toBe('22:00 처리 · 전송 대기');
    expect(metric(list, 'pending_count')).toBe(1);
    const [item] = (await queue.list()).items;
    await queue.setState([item!.requestId], 'unconfirmed');
    await client.reload('queue');
    list = await client.ledgerView('collection_list', { deviceClass: 'driver_phone' });
    expect(stampOf(list, 'collect:o25').pressNote?.lines[0]).toBe('22:00 처리 · 결과 확인 중');
    expect(client.counts()).toMatchObject({ pending: 1, unconfirmed: 1 });
    // 전송 대기 목록의 줄: 팀 · 끝 4자리 · 일 이름 · 시각(체험판과 같은 말, 문구 표 3-14, §17 R3-19).
    expect(await client.pending()).toEqual([expect.objectContaining({
      type: 'stock.collect', state: 'unconfirmed', summary: '김민수 · 0025 수거 22:00', line: { who: '김민수 · 0025', what: '수거', at: '22:00' },
    })]);
    // 같은 창을 다시 눌러도(같은 요청번호) 두 번째 항목은 없다.
    expect((await client.command(envelope)).outcome).toBe('queued');
    expect((await queue.list()).items).toHaveLength(1);
    // 같은 업무의 새 창(새 요청번호)은 겹친 상태에서 이미 받은 것: 넣지 않는다.
    expect((await client.command(envelopeOf(draft))).outcome).not.toBe('queued');
    expect((await queue.list()).items).toHaveLength(1);
  });

  it('확인 전 검사: 받을 돈이 바뀌었으면 충돌(넣지 않음), 같은 돈을 두 번 넣으면 두 번째가 충돌', async () => {
    const { client, queue } = await setup();
    const sheet = await client.query('fieldPaySheet', { taskId: 'collect:o28' });
    const pay = envelopeOf(sheet);
    const stale = { ...pay, requestId: '01JF3Q8W2Z6N9XK4T7B5R1C0DN', expect: { dueAmount: (sheet.expect?.dueAmount ?? 0) + 10_000 } } as AnyCommandEnvelope;
    const conflict = await client.command(stale);
    expect(conflict.outcome).toBe('conflict');
    expect(conflict.error?.code).toBe('DUE_CHANGED');
    expect((await queue.list()).items).toHaveLength(0);
    expect((await client.command(pay)).outcome).toBe('queued');
    // 다른 창(같은 기기)이 같은 돈을 다시: 겹친 상태에서는 받을 돈이 0이라 충돌.
    const again = envelopeOf(sheet);
    expect((await client.command(again)).error?.code).toBe('DUE_CHANGED');
    expect((await queue.list()).items).toHaveLength(1);
  });

  it('창이 열린 동안 사본을 새로 받아도(새 rev · 새 epoch) 그 창의 명령은 실패하지 않는다', async () => {
    const { client, local } = await setup();
    const draft = await client.query('confirmDraft', { actionKey: 'stamp.collect', taskId: 'collect:o25', orderId: 'o25' });
    const body = copyBody();
    body.state.epoch = 'e2';
    body.state.rev = 400;
    await local.writeCopy(copyHead({ epoch: 'e2', rev: 400 }), body);
    await client.reload();
    expect((await client.command(envelopeOf(draft))).outcome).toBe('queued');
  });

  it('사본에 없는 업무의 항목은 바닥줄 `전송 대기`에 센다(조용히 버리지 않는다)', async () => {
    const { client, queue, clocks } = await setup();
    await queue.enqueue({
      type: 'task.visit', commandVersion: 1, requestId: '01JF3Q8W2Z6N9XK4T7B5R1C0DP', basis: { epoch: 'e', rev: 1 }, payload: { taskId: 'collect:o99', outcomeKey: 'customer_absent' },
      recordedBy: { staffId: 'staff-3', sessionId: 'S' },
    }, stampItem(clocks, 'pageanchor12', 0), { madeOffline: true });
    await client.reload('queue');
    const list = await client.ledgerView('collection_list', { deviceClass: 'driver_phone' });
    expect(metric(list, 'pending_count')).toBe(1);
  });

  it('기기 자신의 답: 이미 매장 반납 → `매장 반납 완료`, 받은 수 확인 → `수거 수량 확인`, 보류 → `처리 보류 · 관리자 확인 필요`', async () => {
    const { client, queue, local } = await setup();
    const draft25 = await client.query('confirmDraft', { actionKey: 'stamp.collect', taskId: 'collect:o25', orderId: 'o25' });
    const draft29 = await client.query('confirmDraft', { actionKey: 'stamp.collect', taskId: 'collect:o29', orderId: 'o29' });
    const draft31 = await client.query('confirmDraft', { actionKey: 'stamp.collect', taskId: 'collect:o31', orderId: 'o31' });
    const e25 = envelopeOf(draft25);
    const e29 = envelopeOf(draft29);
    const e31 = envelopeOf(draft31);
    for (const e of [e25, e29, e31]) await client.command(e);
    const items = (await queue.list()).items;
    await queue.answer([
      { requestId: e25.requestId, deviceSeq: items[0]!.seq, outcome: 'superseded', rev: 20, reviews: ['already_returned'] },
      { requestId: e29.requestId, deviceSeq: items[1]!.seq, outcome: 'partially_applied', rev: 21, reviews: ['collect_exceeds'] },
      { requestId: e31.requestId, deviceSeq: items[2]!.seq, outcome: 'held', rev: 21, reviews: ['command_held'] },
    ], 'e', at(22, 5), 'test');
    // 사본이 이미 매장 반납을 담은 뒤(보낸 기록으로 옮김)에도 하루 동안 줄 메모가 남는다.
    await local.touchCopy({}, (t) => queue.settleInTx(t, [{ requestId: e25.requestId, deviceSeq: items[0]!.seq, outcome: 'superseded', rev: 20, reviews: ['already_returned'] }], 'e', at(22, 6)));
    await client.reload();
    const list = await client.ledgerView('collection_list', { deviceClass: 'driver_phone' });
    expect(rowOf(list, 'collect:o25').reviewNote).toBe('매장 반납 완료');
    expect(rowOf(list, 'collect:o29').reviewNote).toBe('수거 수량 확인');
    expect(rowOf(list, 'collect:o31').reviewNote).toBe('처리 보류 · 관리자 확인 필요');
    // 답을 받은 항목은 점선이 아니다(사본이 알릴 때까지 겹쳐 그림).
    expect(stampOf(list, 'collect:o29').pending).toBeFalsy();
  });

  it('저장할 곳이 없으면 끊긴 기기는 `기록 불가 · 연결 끊김 · 종이 기록`, 연결된 기기는 `전송 실패 · 재전송 필요`와 연결 끊김 기록 끔(O2 · §17 R3-25)', async () => {
    const { client, raw } = await setup();
    const draft = await client.query('confirmDraft', { actionKey: 'stamp.collect', taskId: 'collect:o25', orderId: 'o25' });
    raw.failWrites = 'QuotaExceededError';
    const out = await client.command(envelopeOf(draft));
    expect(out.outcome).toBe('rejected');
    expect(out.error?.message).toBe('기록 불가 · 연결 끊김 · 종이 기록');
    expect(client.connection().recordingOff).toBe(true);
    expect(client.isRecordingOff()).toBe(true);
    // 다시 눌러도 같은 한 줄(보냄 대기에 넣지 않는다).
    expect((await client.command(envelopeOf(draft))).error?.message).toBe('기록 불가 · 연결 끊김 · 종이 기록');

    const online = await setup({ offline: false });
    const draft2 = await online.client.query('confirmDraft', { actionKey: 'stamp.collect', taskId: 'collect:o25', orderId: 'o25' });
    online.raw.failWrites = 'QuotaExceededError';
    const out2 = await online.client.command(envelopeOf(draft2));
    expect([out2.outcome, out2.error?.message]).toEqual(['rejected', '전송 실패 · 재전송 필요']);
    expect(online.client.isRecordingOff()).toBe(true);
  });
});

describe('한 휴대폰의 두 화면(O22)', () => {
  it('같은 저장소 · 같은 잠금: 화면 B는 잠금 안에서 다시 읽은 보냄 대기로 검사해 화면 A가 넣은 같은 돈을 받지 않고, 알림을 받아 다시 그린다', async () => {
    const raw = new MemoryRawStore();
    const hub = new MemoryChannelHub();
    const locks = new PageLocks();
    const clocks = new TestClocks(at(22, 0));
    const seed = new LocalStore({ raw, deviceId: DEVICE });
    const body = copyBody();
    await seed.writeCopy(copyHead({ epoch: body.state.epoch, rev: body.state.rev }), body);
    const pageOf = async () => {
      const local = new LocalStore({ raw, deviceId: DEVICE, channel: hub.channel(), locks });
      const queue = new SendQueue(local);
      const client = new LocalClient({
        local, queue, device: { id: DEVICE, kind: 'driver_phone' }, staff: { id: 'staff-3', name: '문태오' }, sessionId: '01JF0SESS000000000000000AA',
        serverNow: () => clocks.wall(), stamp: () => stampItem(clocks, 'pageanchor12', 0), offline: () => true, wallNow: () => clocks.wall(), words: localWords(),
      });
      await client.reload();
      return { local, queue, client };
    };
    const a = await pageOf();
    const b = await pageOf();
    const sheetA = await a.client.query('fieldPaySheet', { taskId: 'collect:o28' });
    const sheetB = await b.client.query('fieldPaySheet', { taskId: 'collect:o28' });
    expect((await a.client.command(envelopeOf(sheetA))).outcome).toBe('queued');
    // B는 아직 다시 그리지 않았어도(같은 순간의 두 창) 넣기 전 검사가 저장소의 보냄 대기를 본다.
    const second = await b.client.command(envelopeOf(sheetB));
    expect(second.error?.code).toBe('DUE_CHANGED');
    expect((await b.queue.list()).items).toHaveLength(1);
    // 알림(BroadcastChannel)을 받은 B가 다시 읽는다.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(b.client.counts().pending).toBe(1);
  });

  it('A의 돈이 이미 보내져 새 사본에 들고 보냄 대기에서 빠졌어도(B는 알림 전), B는 잠금 안에서 새 사본을 읽어 같은 돈을 받지 않고 판을 다시 물으면 새 미수', async () => {
    const raw = new MemoryRawStore();
    const locks = new PageLocks();
    const clocks = new TestClocks(at(22, 0));
    const seed = new LocalStore({ raw, deviceId: DEVICE });
    const body = copyBody();
    await seed.writeCopy(copyHead({ epoch: body.state.epoch, rev: body.state.rev }), body);
    // 알림 길이 없는 두 화면(같은 저장소 · 같은 잠금): B는 A가 쓴 것을 스스로 다시 읽지 않는다.
    const pageOf = async () => {
      const local = new LocalStore({ raw, deviceId: DEVICE, locks });
      const queue = new SendQueue(local);
      const client = new LocalClient({
        local, queue, device: { id: DEVICE, kind: 'driver_phone' }, staff: { id: 'staff-3', name: '문태오' }, sessionId: '01JF0SESS000000000000000AA',
        serverNow: () => clocks.wall(), stamp: () => stampItem(clocks, 'pageanchor12', 0), offline: () => false, wallNow: () => clocks.wall(), words: localWords(),
      });
      await client.reload();
      return { local, queue, client };
    };
    const a = await pageOf();
    const b = await pageOf();
    const sheetB = await b.client.query('fieldPaySheet', { taskId: 'collect:o28' });
    const due = sheetB.expect?.dueAmount ?? 0;
    expect(due).toBeGreaterThan(0);
    const pay = envelopeOf(await a.client.query('fieldPaySheet', { taskId: 'collect:o28' }));
    expect((await a.client.command(pay)).outcome).toBe('queued');
    // A가 보내고 답을 받아 새 사본(그 돈이 든 상태)을 쓰며 항목을 보낸 기록으로 옮긴다(사본을 쓰는 트랜잭션 안, O4).
    const paid = copyBody();
    const o28 = paid.state.orders.find((o) => o.id === 'o28')!;
    o28.payments.push({ id: pay.requestId + ':0', amount: due, methodKey: 'cash', at: clocks.wall(), groupId: pay.requestId, drawerId: 'van:v1' });
    paid.state.paymentGroups.push({ id: pay.requestId, purpose: 'driver_field', amount: due, methodKey: 'cash', at: clocks.wall(), drawerId: 'van:v1' });
    paid.state.rev = body.state.rev + 1;
    await a.local.writeCopy(copyHead({ epoch: body.state.epoch, rev: paid.state.rev, hash: 'g'.repeat(43) }), paid,
      (t) => a.queue.settleInTx(t, [{ requestId: pay.requestId, deviceSeq: 1, outcome: 'applied', rev: paid.state.rev, reviews: [] }], body.state.epoch, clocks.wall()));
    expect((await a.queue.list()).items).toHaveLength(0);
    // B는 옛 사본 · 옛 판으로 같은 돈을 누른다: 잠금 안에서 새 사본을 읽으니 충돌이고 아무것도 넣지 않는다.
    const second = await b.client.command(envelopeOf(sheetB));
    expect(second.error?.code).toBe('DUE_CHANGED');
    expect((await b.queue.list()).items).toHaveLength(0);
    // 판을 다시 물으면(창이 거절 뒤에 하는 일) 새 사본의 미수: 받을 돈 없음, 사본에 든 돈을 두 번 겹치지 않는다.
    const again = await b.client.query('fieldPaySheet', { taskId: 'collect:o28' });
    expect(again.amount.max).toBe(0);
    expect(again.primary.enabled).toBe(false);
    expect(b.client.counts().pending).toBe(0);
  });
});
