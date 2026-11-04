// 새 추가 처리 창도 기존 권한·다음 동작 규칙을 보존한다.
import { ACTION_COMMAND, defaultUiConfig, resolveLedgerView } from '@skinote/contract';
import { describe, expect, it } from 'vitest';
import { FixtureClient } from '../src/fixture/fixture-client.ts';
import { slipExtraActions } from '../src/screens/OrderSlipScreen.tsx';
const config = defaultUiConfig({ shopName: '시험 매장', timezone: 'Asia/Seoul' });
const view = resolveLedgerView(config.ledgerViews, 'order_slip', 'pos')!;
describe('팀 상세 추가 처리', () => {
  it('볼 권한이 없는 동작은 추가 처리 목록에서도 빠진다', async () => {
    const client = new FixtureClient({ realNow: () => 1_800_000_000_000, story: false });
    const slip = await client.query('orderSlip', { orderId: 'o22', deviceClass: 'pos' });
    const before = slipExtraActions(view, slip);
    const guarded = before.filter((a) => a.required_permission_key);
    expect(guarded.length).toBeGreaterThan(0);
    const after = slipExtraActions(view, { ...slip, deniedPermissions: guarded.map((a) => a.required_permission_key!) });
    expect(after.some((a) => guarded.some((g) => g.action_key === a.action_key))).toBe(false);
  });
  it('대표 동작과 같은 명령을 추가 처리에 중복 표시하지 않는다', async () => {
    const client = new FixtureClient({ realNow: () => 1_800_000_000_000, story: false });
    const slip = await client.query('orderSlip', { orderId: 'o22', deviceClass: 'pos' });
    expect(slip.nextStep).not.toBeNull();
    const primary = ACTION_COMMAND[slip.nextStep!.actionKey];
    expect(slipExtraActions(view, slip).some((a) => ACTION_COMMAND[a.action_key] === primary)).toBe(false);
  });
});
