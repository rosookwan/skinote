import { describe, expect, it } from 'vitest';
import {
  availableActions, defaultUiConfig, featureVisible, menuFor, pickPrimaryAction, resolveLedgerView, uiDefaults,
  parseUiDefaults, validateUiDefaults, visibleView, type UiDefaults,
} from '../src/index.ts';

describe('ui-defaults.json', () => {
  it('모양 검사에 문제가 없다', () => {
    expect(validateUiDefaults(uiDefaults)).toEqual([]);
  });

  it('모양 검사: 빠진 필드 · 문자열로 적은 수 · true로 적은 0/1 · 모르는 필드를 잡는다(어휘 검사 앞에서)', () => {
    const broken = structuredClone(uiDefaults) as unknown as { ledger_views: { columns: Record<string, unknown>[]; tabs?: Record<string, unknown>[] }[] };
    const items = broken.ledger_views[0]!.columns[2]!;
    items['min_width'] = items['min_width_em'];
    delete items['min_width_em'];
    items['weight'] = '3';
    broken.ledger_views[0]!.tabs![0]!['shows_count'] = true;
    const problems = validateUiDefaults(broken).join('\n');
    expect(problems).toContain('빠진 필드 min_width_em');
    expect(problems).toContain('모르는 필드 min_width');
    expect(problems).toContain('weight: 0 이상의 수여야 한다');
    expect(problems).toContain('shows_count: 0 또는 1이어야 한다');
    expect(() => parseUiDefaults(broken)).toThrow('화면 기본 설정이 틀렸다');
    expect(validateUiDefaults(null)).toEqual(['ui_defaults: 객체여야 한다']);
  });

  it('검사기가 틀린 행을 잡는다(늦음 빨강 도장, 좁은 시각 도장, 없는 합칠 칸)', () => {
    const broken: UiDefaults = structuredClone(uiDefaults);
    broken.stamp_steps[0] = { ...broken.stamp_steps[0]!, tone_key: 'red' };
    const driver = broken.ledger_views.find((v) => v.key === 'collection_list' && v.device_class_key === 'driver_tablet')!;
    driver.columns[0] = { ...driver.columns[0]!, min_width_em: 4, preferred_width_em: 4 };
    const ledger = broken.ledger_views.find((v) => v.key === 'day_ledger')!;
    ledger.columns[0] = { ...ledger.columns[0]!, fold_into_column_key: 'nothing' };
    const problems = validateUiDefaults(broken).join('\n');
    expect(problems).toContain('늦음 빨강');
    expect(problems).toContain('5.5em');
    expect(problems).toContain('합칠 칸이 같은 화면에 없다');
  });

  it('6-1 오늘 대여 장부: 칸 · 탭 · 숫자 · 주 버튼', () => {
    const view = resolveLedgerView(uiDefaults.ledger_views, 'day_ledger', 'pos')!;
    expect(view.columns.map((c) => c.column_key)).toEqual(['time', 'team', 'items', 'promise', 'money', 'stamp:issue', 'stamp:return', 'stamp:pay', 'stamp:lesson_done']);
    expect(view.columns.find((c) => c.column_key === 'stamp:issue')?.step_keys).toEqual(['load', 'issue']);
    expect(view.tabs.map((t) => t.label)).toEqual(['전체', '수령', '반납', '미수', '차량', '강습']);
    expect(view.metrics.map((m) => m.metric_key)).toEqual(['team_count', 'issued_count', 'returned_count', 'due_total']);
    expect(pickPrimaryAction(view.primary_actions, [])?.action_key).toBe('new_order');
    expect(pickPrimaryAction(view.primary_actions, ['after_last_return_slot'])?.action_key).toBe('close_day');
  });

  it('기능이 꺼지면 칸 · 탭이 사라진다(회색으로 남지 않음)', () => {
    const view = resolveLedgerView(uiDefaults.ledger_views, 'day_ledger', 'pos')!;
    const off = visibleView(view, { vehicles: false, lessons: false });
    expect(off.tabs.map((t) => t.tab_key)).toEqual(['all', 'pickup', 'return', 'unpaid']);
    expect(off.columns.some((c) => c.column_key === 'stamp:lesson_done')).toBe(false);
    const on = visibleView(view, { vehicles: true, lessons: true });
    expect(on.tabs).toHaveLength(6);
    expect(on.columns.some((c) => c.column_key === 'stamp:lesson_done')).toBe(true);
  });

  it('pos_narrow는 pos 판으로, 휴대폰은 태블릿 판을 바탕으로(칸만 덮음)', () => {
    const narrow = resolveLedgerView(uiDefaults.ledger_views, 'day_ledger', 'pos_narrow')!;
    expect(narrow.device_class_key).toBe('pos');
    expect(narrow.requested_device_class_key).toBe('pos_narrow');
    const phone = resolveLedgerView(uiDefaults.ledger_views, 'collection_list', 'driver_phone')!;
    const tablet = resolveLedgerView(uiDefaults.ledger_views, 'collection_list', 'driver_tablet')!;
    expect(phone.columns.map((c) => c.column_key)).toEqual(['stamp:collect', 'team', 'items', 'action:call']);
    expect(phone.columns.find((c) => c.column_key === 'team')?.min_width_em).toBe(11.5);
    expect(phone.columns.find((c) => c.column_key === 'items')?.fold_mode_key).toBe('second_line');
    expect(phone.tabs).toEqual(tablet.tabs);
    expect(phone.metrics).toEqual(tablet.metrics);
    expect(phone.primary_actions.map((p) => p.action_key)).toEqual(['receive_to_shop']);
    const phoneMin = phone.columns.filter((c) => c.column_key !== 'items').reduce((sum, c) => sum + c.min_width_em * 16, 0);
    expect(phoneMin).toBe(328); // 88 + 184 + 56 = 360 − 32 (ui 6-3)
  });

  it('카운터 수거 목록(N3)은 기사 태블릿 판을 바탕으로 한 pos 판: 칸 · 탭 · 숫자는 물려받고 주 버튼 · 동작만 덮는다', () => {
    const counter = resolveLedgerView(uiDefaults.ledger_views, 'collection_list', 'pos')!;
    const narrow = resolveLedgerView(uiDefaults.ledger_views, 'collection_list', 'pos_narrow')!;
    const tablet = resolveLedgerView(uiDefaults.ledger_views, 'collection_list', 'driver_tablet')!;
    expect(counter.columns).toEqual(tablet.columns);
    expect(counter.tabs).toEqual(tablet.tabs);
    expect(counter.metrics.map((m) => m.metric_key)).toEqual(['collected_count', 'pending_count', 'remaining_count', 'vehicle_load']);
    expect(counter.template_key).toBe('collection_list');
    expect(pickPrimaryAction(counter.primary_actions, [])?.action_key).toBe('print');
    expect(pickPrimaryAction(tablet.primary_actions, [])?.action_key).toBe('receive_to_shop');
    expect(availableActions(counter.actions, []).map((a) => a.action_key)).toEqual(['move_up', 'move_down', 'move_top', 'pin', 'open_slip', 'call', 'route_reset']);
    expect(availableActions(tablet.actions, []).map((a) => a.action_key)).toEqual(['move_up', 'move_down', 'move_top', 'not_collected', 'call', 'route_reset']);
    expect(narrow.device_class_key).toBe('pos');
  });

  it('접수증의 긴급 요청은 열린 차량 업무가 있을 때만(has_open_tasks)', () => {
    const slip = resolveLedgerView(uiDefaults.ledger_views, 'order_slip', 'pos')!;
    expect(availableActions(slip.actions, ['has_open_tasks']).map((a) => a.action_key)).toContain('pin');
    expect(availableActions(slip.actions, []).map((a) => a.action_key)).not.toContain('pin');
    expect(visibleView(slip, { vehicles: false }).actions.map((a) => a.action_key)).not.toContain('pin');
  });

  it('6-2 접수증: 품목 표 칸의 최소 합이 504px이고 옆 동작은 능력으로 걸러진다', () => {
    const slip = resolveLedgerView(uiDefaults.ledger_views, 'order_slip', 'pos')!;
    expect(slip.columns.reduce((sum, c) => sum + c.min_width_em * 16, 0)).toBe(504);
    const actions = availableActions(slip.actions, ['exchangeable']).map((a) => a.action_key);
    expect(actions).toEqual(['change_promise', 'exchange', 'print', 'call']);
    // 수납은 받을 돈이 있을 때만(has_due), 조기 반납은 내준 장비가 돌아오지 않았을 때만(has_items_out).
    expect(availableActions(slip.actions, ['has_due', 'return_required']).map((a) => a.action_key)).toEqual(['pay', 'change_promise', 'print', 'call']);
    expect(availableActions(slip.actions, ['has_items_out']).map((a) => a.action_key)).toContain('early_return');
    expect(pickPrimaryAction(slip.primary_actions, [])?.action_key).toBe('next_step');
  });

  it('메뉴: 강습 켜짐 여부로 리프트권 이름이 바뀌고 관리는 끝에 고정', () => {
    const off = menuFor(uiDefaults.menu_entries, 'pos', 'pos', { vehicles: true, lessons: false }, null).map((m) => m.label);
    const on = menuFor(uiDefaults.menu_entries, 'pos', 'pos', { vehicles: true, lessons: true }, null).map((m) => m.label);
    expect(off).toEqual(['수거 목록', '리프트권', '확인 필요', '관리']);
    expect(on).toEqual(['수거 목록', '리프트권·강습', '확인 필요', '관리']);
    expect(featureVisible({ feature_key: null }, {})).toBe(true);
  });

  it('기본 UiConfig', () => {
    const config = defaultUiConfig({ shopName: '체험 매장' });
    expect(config.defaultsRev).toBe(uiDefaults.rev);
    expect(config.features.vehicles).toBe(true);
    expect(config.features.lessons).toBe(false);
    expect(config.timezone).toBe('Asia/Seoul');
  });

  it('화면 문구에 영어 · 말줄임표가 없다', () => {
    const texts: string[] = [];
    for (const s of uiDefaults.stamp_steps) texts.push(s.label, s.stamp_text, s.checklist_label, s.short_label ?? '');
    for (const v of uiDefaults.ledger_views) {
      texts.push(v.label);
      for (const c of v.columns) texts.push(c.header_label, c.short_header_label ?? '');
      for (const t of v.tabs ?? []) texts.push(t.label, t.short_label ?? '');
      for (const m of v.metrics ?? []) texts.push(m.label);
    }
    for (const m of uiDefaults.menu_entries) texts.push(m.label, m.short_label ?? '');
    for (const s of uiDefaults.status_terms) texts.push(s.label);
    for (const text of texts) {
      expect(text.replace('{date}', '')).not.toMatch(/[A-Za-z]/);
      expect(text).not.toContain('…');
    }
  });
});
