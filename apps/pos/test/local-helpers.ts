// 기기 저장소 시험의 도우미(work/impl-offline/plan.md §7-9): 사본 머리 · 본문(견본 하루의 1호 차량 사본).
import { defaultUiConfig } from '@skinote/contract';
import { sampleDay, vehicleScope } from '@skinote/domain';
import type { CopyBody, CopyHead } from '../src/local/local-store.ts';
import { TEST_POLICY } from './fake-server.ts';

export function copyHead(extra: Partial<CopyHead> = {}): CopyHead {
  return {
    fmt: 1, appVersion: 'test', stateVersion: 3, epoch: 'e1', rev: 10, hash: 'h'.repeat(43), configRev: 1, vehicleId: 'v1', businessDate: '2026-12-26',
    cutoff: '06:00', storedAt: 0, scrubbed: false, policy: TEST_POLICY, restoredUpToRev: null, ...extra,
  };
}

export function copyBody(): CopyBody {
  const state = vehicleScope(sampleDay({ date: '2026-12-26', epoch: 'e1', ids: 'demo' }), 'v1', { staffId: 'staff-3' });
  return { state, config: defaultUiConfig({ shopName: '시험 매장', timezone: 'Asia/Seoul' }) };
}
