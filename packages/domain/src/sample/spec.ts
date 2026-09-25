// 견본 매장의 명세(sampleSpec)와 직원 예시(SAMPLE_STAFF). 서버의 `provision --sample`과 시험이 쓴다. 직원 이름은 예시이고 실제
// 사람이 아니다(실제 매장의 직원 이름은 저장소에 두지 않고 서버로 보내는 JSON에만 둔다, plan §13).
import type { ShopSpec, StaffSpec } from '../spec.ts';
import { sampleRegistry, SHOP_NAME } from './registry.ts';
import { DRAWERS, STOCK_NUMBERS, VAN_SPARE, sampleRules } from './seed.ts';

/**
 * 시험 매장의 번호 재고: 견본 하루의 번호(STOCK_NUMBERS)를 모두 담고, 장비와 야간권이 아닌 권은 더 넉넉하다(견본 하루를 여러 날짜로 넣어도
 * 앞 날짜의 팀이 가진 번호와 겹치지 않게, load-sample). 야간권은 1호 차량 예비권(51 ~ 56번) 앞에서 끝난다.
 */
const SPEC_STOCK_NUMBERS: Readonly<Record<string, readonly [number, number]>> = {
  ...STOCK_NUMBERS,
  ski: [1, 120], board: [1, 60], boots: [1, 120], helmet: [1, 90], clothes: [1, 120],
  morning_adult: [101, 160], afternoon_adult: [201, 260], day_adult: [301, 360], full_adult: [401, 460],
};

/** 직원 예시(관리자 · 카운터 · 1호 차량 기사). 체험판의 미리 보기 화면(로그인 타일)도 이 이름을 쓴다. */
export const SAMPLE_STAFF: readonly StaffSpec[] = [
  { name: '한가람', role: 'manager' },
  { name: '오세린', role: 'counter' },
  { name: '문태오', role: 'driver', vehicleKey: 'v1' },
];

/** 견본 매장의 명세(새 사본). 시즌은 견본 값이다. */
export function sampleSpec(): ShopSpec {
  const settings = sampleRules();
  return {
    shop: { code: 'sample', name: SHOP_NAME, cutoff: settings.businessDayCutoff, timezone: 'Asia/Seoul' },
    staff: SAMPLE_STAFF.map((s) => ({ ...s })),
    registry: sampleRegistry(),
    settings,
    drawers: DRAWERS.map((d) => ({ ...d })),
    stock: {
      numbers: Object.fromEntries(Object.entries(SPEC_STOCK_NUMBERS).map(([key, [from, to]]) => [key, [from, to] as const])),
      // 고글(수량으로 세는 상품)의 처음 재고: 규격마다 견본 값.
      counts: { goggles: { 어른: 30, 어린이: 20 } },
      vehicleSpares: [{ vehicleId: VAN_SPARE.vehicleId, productKey: VAN_SPARE.kind, numbers: [...VAN_SPARE.numbers] }],
    },
    season: { from: '2026-12-01', to: '2027-03-31' },
  };
}
