// 매장 하나를 처음 만들 때의 명세(ShopSpec, plan §4-6). 서버의 매장 만들기(provision)가 이 모양의 JSON을 받아 매장 파일의 표를 채운다.
// 견본 매장의 명세는 sample/spec.ts의 sampleSpec()이다. 비밀번호 · 등록 번호 같은 비밀은 여기에 없다(CLI가 만들어 한 번 보여 준다).
import type { FxDrawer, FxShopRules, ShopRegistry } from './model.ts';

/** 직원의 역할(roles): 관리자 · 카운터 · 기사(기사는 차량 하나). */
export type StaffRole = 'manager' | 'counter' | 'driver';

export interface StaffSpec {
  name: string;
  role: StaffRole;
  /** 기사의 차량(registry.vehicles의 id). */
  vehicleKey?: string;
}

export interface ShopSpec {
  shop: { code: string; name: string; cutoff: string; timezone: 'Asia/Seoul' };
  staff: StaffSpec[];
  registry: ShopRegistry;
  settings: FxShopRules;
  drawers: FxDrawer[];
  stock: {
    /** 번호로 세는 상품의 번호 범위(상품 key → [처음, 끝]). */
    numbers: Record<string, readonly [number, number]>;
    /** 수량으로 세는 상품(상품 key → 규격 key → 수)의 처음 매장 재고. 규격 없는 상품은 빈 key ''(sample NO_VARIANT). */
    counts: Record<string, Record<string, number>>;
    /** 차량에 둔 예비 번호(번호로 세는 차량 예비권). */
    vehicleSpares: { vehicleId: string; productKey: string; numbers: string[] }[];
    /** 차량에 둔 예비 수량(수량으로 세는 차량 예비권, 규격 없는 권): ShopState.vanSpares의 처음 값. 옛 명세에는 없다. */
    vehicleCounts?: { vehicleId: string; productKey: string; quantity: number }[];
  };
  /** 시즌(리프트권 번호의 유효 기간). */
  season: { from: string; to: string };
}
