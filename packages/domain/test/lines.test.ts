// 거절 문구의 자리(D16): 도메인 소스에는 체험판의 말이 없고, 문구는 문맥(lines)에서 온다. 기본은 운영 문구.
import { readdirSync, readFileSync } from 'node:fs';
import { draftToEnvelope, openCommandDraft, type AnyCommandEnvelope, type ConfirmCommand } from '@skinote/contract';
import { describe, expect, it } from 'vitest';
import { PRODUCTION_LINES, applyCommand, confirmDraft, sampleDay, type DomainLines, type ShopState } from '../src/index.ts';
import { defaultUiConfig } from '@skinote/contract';

const SRC = new URL('../src/', import.meta.url);

/** src 아래 .ts 파일(견본 폴더 sample/ 빼고). */
function sources(dir: URL, rel = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return entry.name === 'sample' && rel === '' ? [] : sources(new URL(entry.name + '/', dir), rel + entry.name + '/');
    return entry.name.endsWith('.ts') ? [rel + entry.name] : [];
  });
}

const day = (): ShopState => sampleDay({ date: '2026-12-26', epoch: 'e', ids: 'demo' });
const envelope = (state: ShopState, command: ConfirmCommand, epoch = state.epoch): AnyCommandEnvelope =>
  draftToEnvelope(openCommandDraft(command, { epoch, rev: state.rev }));

describe('도메인 문구(D16)', () => {
  it('도메인 소스(sample 밖)에는 체험판의 말이 없다', () => {
    const files = sources(SRC);
    expect(files).toContain('commands.ts');
    expect(files.some((f) => f.startsWith('sample/'))).toBe(false);
    const found = files.filter((f) => readFileSync(new URL(f, SRC), 'utf8').includes('체험'));
    expect(found).toEqual([]);
  });

  it('도메인 소스(sample 밖)는 견본 매장(sample/)을 가져오지 않는다: 값은 매장 목록(registry)에서 읽는다', () => {
    const found = sources(SRC).filter((f) => /from '\.\/sample\//.test(readFileSync(new URL(f, SRC), 'utf8')) && f !== 'index.ts');
    expect(found).toEqual([]);
  });

  it('운영 문구가 기본이다', () => {
    expect(PRODUCTION_LINES).toEqual({
      unsupported: '미지원 기능 · 처리 불가',
      epochChanged: '자료 복구 · 재확인 필요',
      forbidden: '권한 없음 · 관리자 확인 필요',
      forbiddenScope: '이 기기에서 사용 불가',
      failed: '처리 실패 · 재시도 필요',
    });
    const state = day();
    // 모르는 반납 장소 · 수령 일정 변경은 미지원 입력(UNSUPPORTED).
    const out = applyCommand(state, envelope(state, { type: 'promise.change', payload: { orderId: 'o22', kind: 'pickup', lines: [], promise: { mode: 'store' } } }), state.rev);
    expect(out).toMatchObject({ outcome: 'rejected', error: { code: 'UNSUPPORTED', message: '미지원 기능 · 처리 불가' } });
    const old = applyCommand(state, envelope(state, { type: 'route.reset', payload: { vehicleId: 'v1', date: state.businessDate } }, 'other'), 0);
    expect(old).toMatchObject({ outcome: 'conflict', error: { code: 'EPOCH_CHANGED', message: '자료 복구 · 재확인 필요' } });
  });

  it('어댑터가 넘긴 문구를 쓴다(명령 · 읽기 모델)', () => {
    const lines: DomainLines = { ...PRODUCTION_LINES, unsupported: '가 · 나', epochChanged: '다 · 라' };
    const state = day();
    const out = applyCommand(state, envelope(state, { type: 'promise.change', payload: { orderId: 'o22', kind: 'pickup', lines: [], promise: { mode: 'store' } } }), 0, lines);
    expect(out.error).toEqual({ code: 'UNSUPPORTED', message: '가 · 나' });
    expect(applyCommand(state, envelope(state, { type: 'route.reset', payload: { vehicleId: 'v1', date: state.businessDate } }, 'x'), 0, lines).error?.message).toBe('다 · 라');
    const config = defaultUiConfig({ shopName: state.registry.shopName, timezone: 'Asia/Seoul' });
    const view = confirmDraft({ state, config, now: 0, lines }, { actionKey: 'print', orderId: 'o21' });
    expect(view.notice).toBe('가 · 나');
    expect(confirmDraft({ state, config, now: 0 }, { actionKey: 'print', orderId: 'o21' }).notice).toBe(PRODUCTION_LINES.unsupported);
  });
});
