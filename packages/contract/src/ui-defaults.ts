// 화면 기본 설정(ui-defaults.json, 판 번호 rev). 매장을 만들 때 시스템 행으로 넣고, 앱이 새 판을 가져오면
// ui_defaults.apply가 매장이 바꾸지 않은 행만 고친다(ui 2절). JSON은 매장 파일의 열 이름을 그대로 쓴다.
import raw from '../ui-defaults.json' with { type: 'json' };
import type { Features, UiConfig, UiDefaults } from './config.ts';
import { CONTRACT_VERSION } from './client.ts';
import { FEATURE_KEYS } from './vocab.ts';
import { parseUiDefaults } from './validate.ts';

/** 형식을 붙인 기본 설정: JSON을 모양 · 어휘로 검사한 뒤에만 UiDefaults가 된다(틀리면 불러올 때 던진다). */
export const uiDefaults: UiDefaults = parseUiDefaults(raw as unknown);

/** sys_features.default_enabled(schema 시드와 같음). 체험 · 시험에서 기본 설정을 그릴 때 쓴다. */
export const DEFAULT_FEATURES: Features = Object.fromEntries(
  FEATURE_KEYS.map((key) => [key, ['vehicles', 'prepayment', 'exchange', 'multi_order_payment', 'customer_profiles'].includes(key)]),
);

/** 기본 설정만으로 만든 UiConfig(체험판 · 시험 · 서버가 없을 때의 뼈대). */
export function defaultUiConfig(overrides: { features?: Features; shopName?: string; timezone?: string } = {}): UiConfig {
  return {
    configRev: 0,
    defaultsRev: uiDefaults.rev,
    contract: CONTRACT_VERSION,
    locale: 'ko-KR',
    timezone: overrides.timezone ?? 'Asia/Seoul',
    shopName: overrides.shopName ?? '',
    features: { ...DEFAULT_FEATURES, ...overrides.features },
    stampSteps: uiDefaults.stamp_steps,
    ledgerViews: uiDefaults.ledger_views,
    menuEntries: uiDefaults.menu_entries,
    statusTerms: uiDefaults.status_terms,
  };
}
