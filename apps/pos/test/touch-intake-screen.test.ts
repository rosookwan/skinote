// 새 접수의 이름 필수와 기본 일정 통과 경로를 실제 읽기 모델로 확인한다.
import { describe, expect, it } from 'vitest';
import { FixtureClient } from '../src/fixture/fixture-client.ts';
import { nextIntakeStep } from '../src/screens/NewOrderScreen.tsx';
import type { OrderDraftInput } from '@skinote/contract';

const draft = (name: string): OrderDraftInput => ({ channel: 'walk_in', leader: { name, phone: '', party: 0 }, items: [{ productKey: 'ski', quantity: 1 }], pickup: { mode: 'store', immediate: true }, giveBack: { mode: 'store' } });
describe('기본 일정의 결제 바로가기', () => {
  it('이름이 없으면 일정 기본값이 있어도 진행할 수 없다', async () => {
    const client = new FixtureClient({ realNow: () => 1_800_000_000_000, story: false });
    const view = await client.query('orderDraft', { draft: draft('') });
    expect(nextIntakeStep(view.ready)).toBeNull();
  });
  it('이름·품목·기본 일정이 있으면 확인된 일정과 함께 결제로 간다', async () => {
    const client = new FixtureClient({ realNow: () => 1_800_000_000_000, story: false });
    const view = await client.query('orderDraft', { draft: draft('시험손님') });
    expect(nextIntakeStep(view.ready)).toBe('pay');
    expect(view.summary.filter((row) => row.key === 'pickup' || row.key === 'return')).toHaveLength(2);
  });
  it('일정 미완성은 일정 화면으로 남겨둔다', () => {
    expect(nextIntakeStep({ items: true, schedule: false })).toBe('schedule');
  });
});
