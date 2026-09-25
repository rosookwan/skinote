// V8 매장 설정 · 운영 규칙(spec 3-9, ui 6-9): 관리 → 매장 설정 → 색인 탭 `운영 규칙`. 장부형 틀(ui 2-1 나): 제목 `매장 설정` + 색인 탭
// `매장 정보` · `장소` · `반납 타임` · `요금 · 할인` · `차량 · 직원` · `운영 규칙`(등급의 탭 칸 수를 넘으면 더 보기), 본문은 카드 목록(위에서
// 아래로 채우고 모자라면 오른쪽 칸, 칸이 다 차면 다음 쪽 — 카드는 자르지 않는다), 바닥줄 `‹ 관리` · 굵은 요약(`변경 3건 · 다음 기록부터
// 적용`) · 쪽 넘김 · 주황 `저장 · 3건`. 운영 규칙 밖의 탭은 아직 `준비 중인 화면`이다.
// 화면은 계산하지 않는다: 누른 고르기 · 숫자판 값을 바꿈으로 모아(app/settings-draft.ts) shopRules를 다시 묻고, 카드 · 바뀐 곳 · 바닥줄 ·
// 주 버튼 · 저장 명령(setting.set) · 거절 까닭을 받는다. 저장은 확인 창(`변경 3건`: 전 → 후 목록, `다음 기록부터 적용 · 지난 기록 · 접수
// 유지`)에서 보낸다. 저장하지 않은 바꿈이 있는데 `‹ 관리` · 다른 탭 · 머리줄로 떠나면 `미저장 변경 3건` 창(`저장 안 함` · `저장 · 3건`).
import {
  envelopeFor, offlineAllowed, type ChoiceOption, type ConfirmCommand, type LedgerTabRow, type RuleCard as RuleCardView, type RuleChange, type RuleInput, type RuleRow,
  type ShopRulesView, type Basis,
} from '@skinote/contract';
import { cardColumns, confirmWindow, packCards } from '@skinote/layout';
import {
  DialogFrame, FooterBar, Icon, IndexTabs, NumberPad, Pager, PrimaryButton, RuleCard, TextFit, ruleCardHeight, t, useCommandDraft, useElementSize,
  useUi, type DeviceProfile, type FooterBarProps, type Size,
} from '@skinote/ui';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useClient, useConnection, useLive } from '../app/client.tsx';
import { go, SETTINGS_TABS, type SettingsTab } from '../app/router.ts';
import { inputAccepts, optionPress, padValue, withChange } from '../app/settings-draft.ts';
import { APP_STRINGS_KO, say } from '../app/strings.ts';
import { ChoiceSheet, NoticeDialog } from '../components/NoticeDialog.tsx';
import { usePosHeader, type LeaveGuard } from '../components/PosHeader.tsx';

const NO_BASIS: Basis = { epoch: '', rev: 0 };
const NO_COUNTS: Record<string, number> = {};
const SAVE_SHAPE: ConfirmCommand = { type: 'setting.set', payload: { changes: [] } };

/** 색인 탭(차례 · 넘칠 때 남는 차례: 만든 탭 `운영 규칙`이 가장 나중에 더 보기로 간다). */
const TAB_LABEL = {
  info: 'tabInfo', places: 'tabPlaces', slots: 'tabSlots', pricing: 'tabPricing', fleet: 'tabFleet', rules: 'tabRules',
} as const satisfies Record<SettingsTab, keyof typeof APP_STRINGS_KO>;
const TAB_PRIORITY: Record<SettingsTab, number> = { rules: 90, info: 80, places: 70, slots: 60, pricing: 50, fleet: 40 };

export function settingsTabs(): LedgerTabRow[] {
  return SETTINGS_TABS.map((key, i) => ({
    tab_key: key, label: say(TAB_LABEL[key]), short_label: null, filter_key: 'all', params: null, seq: i + 1, priority: TAB_PRIORITY[key],
    overflow_key: 'more_sheet', shows_count: 0, feature_key: null,
  }));
}

/** 탭 행(한 번 만든다: 색인 탭은 같은 배열이면 칸 맞춤을 다시 하지 않는다). */
const SETTINGS_TAB_ROWS = settingsTabs();


export interface RulesLayout {
  columns: number;
  /** 쪽 → 칸 → 카드 색인. */
  pages: number[][][];
}

/**
 * 카드의 칸 · 쪽(spec 3-9): 칸 수는 잰 본문 폭으로(두 칸 사이 16), 칸 높이는 잰 본문 높이 − 위 여백 12, 카드 높이는 ruleCardHeight(부품과 같은
 * 값), 카드 사이 8. 1024×600은 한 쪽(반납 · 보증금 | 결제 · 환불 · 영업일 기준 시각), 1024×569 · 529는 두 쪽, 좁은 포스는 한 칸 두 쪽.
 */
export function rulesLayout(profile: DeviceProfile, box: Size | null, cards: readonly Pick<RuleCardView, 'inline' | 'rows' | 'notes'>[]): RulesLayout {
  if (!box) return { columns: 1, pages: [[[]]] };
  // 카드 한 장의 가장 작은 폭(DeviceProfile pages: 누르는 곳 9칸 = 468px, 시안 카드 474): 칸 폭이 이보다 좁으면 한 칸(좁은 포스 875 · 907).
  const columns = cardColumns(box.width, profile.minTargetPx * profile.pages.ruleCardMinTargets, profile.space.l);
  const heights = cards.map((card) => ruleCardHeight(card, profile));
  return { columns, pages: packCards(heights, box.height - profile.space.m, profile.space.s, columns) };
}

/** 저장 확인 창의 바뀐 곳 한 쪽 줄 수: 창 높이(confirmWindow) − 제목 · 바닥 − 본문 여백 − 안내 한 줄을 줄 높이로(넘치면 창 안에서 쪽). */
export function saveRowsPerPage(profile: DeviceProfile, viewport: Size): number {
  const box = confirmWindow(viewport, profile.confirm, 1, 0);
  const body = box.heightPx - profile.confirm.titlePx - profile.confirm.primaryRowPx - 2 * profile.space.m;
  const note = Math.ceil(profile.bodyFontPx * profile.bodyLineHeight) + profile.space.s;
  return Math.max(1, Math.floor((body - note) / profile.rowPx));
}

type Dialog = { kind: 'save'; then?: () => void } | { kind: 'unsaved'; proceed: () => void };

/** 매장 설정의 탭 하나. 운영 규칙(V8)만 만들었고, 다른 탭은 `준비 중인 화면`이다. */
export function ShopSettingsScreen({ tab }: { tab: SettingsTab }) {
  return tab === 'rules' ? <RulesScreen /> : <SoonScreen tab={tab} />;
}

interface FrameProps {
  tab: SettingsTab;
  header: ReturnType<typeof usePosHeader>;
  guard: LeaveGuard;
  body: ReactNode;
  summary?: string | undefined;
  pager?: ReactNode;
  primary?: FooterBarProps['primary'];
  overlays?: ReactNode;
}

/** 머리줄 · 제목과 색인 탭 · 본문 · 바닥줄(`‹ 관리` · 요약 · 쪽 넘김 · 주 버튼). 탭 · `‹ 관리`는 떠나기 전에 묻는다(guard). */
function SettingsFrame({ tab, header, guard, body, summary, pager, primary = null, overlays }: FrameProps) {
  const [tabSheet, setTabSheet] = useState<LedgerTabRow[] | null>(null);
  const toTab = (key: string) => {
    setTabSheet(null);
    if (key === tab) return;
    guard(() => go({ name: 'shopSettings', tab: key as SettingsTab }));
  };
  return (
    <div className="sn-screen">
      {header.element}
      <div className="sn-desk">
        <main className="sn-sheet pos-rules" aria-label={say('shopSettings') + ' · ' + say(TAB_LABEL[tab])}>
          <IndexTabs title={say('shopSettings')} tabs={SETTINGS_TAB_ROWS} counts={NO_COUNTS} active={tab} onSelect={toTab} onMore={setTabSheet} />
          {body}
        </main>
      </div>
      <FooterBar metrics={[]} pager={pager} primary={primary}>
        <div className="pos-footer-back">
          <button type="button" className="sn-button" aria-label={say('toManage')} onClick={() => guard(() => go({ name: 'manage' }))}>
            <Icon name="left" />
            <span>{say('toManage')}</span>
          </button>
          {summary ? <TextFit input={{ mode: 'words', text: summary }} /> : null}
        </div>
      </FooterBar>
      {overlays}
      {tabSheet ? (
        <ChoiceSheet title={t('more')} choices={tabSheet.map((row) => ({ key: row.tab_key, label: row.label }))} onPick={toTab} onClose={() => setTabSheet(null)} />
      ) : null}
      {header.overlays}
    </div>
  );
}

/** 아직 만들지 않은 탭(매장 정보 · 장소 · 반납 타임 · 요금 · 할인 · 차량 · 직원). */
function SoonScreen({ tab }: { tab: SettingsTab }) {
  const guard: LeaveGuard = (proceed) => proceed();
  const header = usePosHeader('other', 'management');
  return (
    <SettingsFrame
      tab={tab}
      header={header}
      guard={guard}
      body={<div className="pos-rules-body is-soon"><p className="pos-sheet-note" role="status">{say('screenSoon')}</p></div>}
    />
  );
}

/** 운영 규칙(V8): 카드 목록 · 숫자판 · 저장 확인 창 · 떠날 때 창. */
function RulesScreen() {
  const client = useClient();
  const { profile } = useUi();
  const connection = useConnection();
  // 운영 규칙 저장은 연결이 필요한 결정이다(sync 8-2, 계약 offlineAllowed): 끊겼으면 창 대신 한 줄.
  const needsLink = !connection.online && !offlineAllowed(profile.key, 'setting.set');
  const [changes, setChanges] = useState<RuleChange[]>([]);
  const [page, setPage] = useState(0);
  const [pad, setPad] = useState<{ input: RuleInput; digits: string } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<{ title: string; lines: string[] } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<ShopRulesView | null>(null);
  const hold = pad !== null || dialog !== null || notice !== null || busy;
  const live = useLive<ShopRulesView>('rules:' + JSON.stringify(changes), (c) => c.query('shopRules', { changes }), hold);
  // 다시 묻는 동안에도 앞 답을 그린다(누를 때마다 카드가 비었다가 다시 서지 않게).
  useEffect(() => { if (live.data) setLast(live.data); }, [live.data]);
  const view = live.data ?? last;
  const dirty = (view?.changes.length ?? 0) > 0;
  const guard: LeaveGuard = (proceed) => {
    if (dirty && view?.unsavedTitle) setDialog({ kind: 'unsaved', proceed });
    else proceed();
  };
  const header = usePosHeader('other', 'management', guard);

  // 저장의 요청번호: 확인 창(저장 · 떠날 때)을 연 때 하나(시도마다). 보낼 때 본문은 지금 답의 명령이다.
  const saveKey = dialog && view?.command ? 'settings:rules:' + attempt : null;
  const { draft, markSent } = useCommandDraft(saveKey, saveKey ? SAVE_SHAPE : null, view?.basis ?? NO_BASIS);

  const bodyRef = useRef<HTMLDivElement>(null);
  const box = useElementSize(bodyRef);
  const cards = view?.cards ?? [];
  const layout = rulesLayout(profile, box, cards);
  const at = Math.min(page, layout.pages.length - 1);
  const shown = layout.pages[at] ?? [[]];

  const save = (then?: () => void) => {
    if (!view?.command || !draft || busy) return;
    if (needsLink) { setDialog(null); setNotice({ title: say('tabRules'), lines: [say('settingsOffline')] }); return; }
    const envelope = envelopeFor(draft, view.command, undefined);
    if (!envelope) return;
    setBusy(true);
    markSent();
    client.command(envelope).then((outcome) => {
      setBusy(false);
      setDialog(null);
      setAttempt((n) => n + 1);
      if (outcome.outcome === 'applied' || outcome.outcome === 'superseded') {
        setChanges([]);
        then?.();
        return;
      }
      setNotice({ title: say('tabRules'), lines: [outcome.error?.message ?? say('commandFailed')] });
    }, () => {
      setBusy(false);
      setNotice({ title: say('tabRules'), lines: [say('sendFailed')] });
    });
  };
  const onOption = (row: RuleRow, option: ChoiceOption) => {
    const press = optionPress(row, option);
    if ('input' in press) setPad({ input: press.input, digits: '' });
    else setChanges((prev) => withChange(prev, press.change));
  };
  const onValue = (row: RuleRow) => { if (row.value) setPad({ input: row.value.input, digits: '' }); };
  const onPrimary = () => {
    if (!view?.primary.enabled) return;
    if (needsLink) { setNotice({ title: say('tabRules'), lines: [say('settingsOffline')] }); return; }
    setDialog({ kind: 'save' });
  };

  const colStyle = { '--pos-rules-cols': layout.columns } as CSSProperties;
  const body = (
    <div ref={bodyRef} className="pos-rules-body" style={colStyle}>
      {!view && live.error ? <p className="pos-sheet-note" role="status">{say('settingsUnreadable')}</p> : null}
      {view && box ? Array.from({ length: layout.columns }, (_, c) => (
        <div key={c} className="pos-rules-col">
          {(shown[c] ?? []).map((i) => {
            const card = cards[i];
            return card ? <RuleCard key={card.key} card={card} onOption={onOption} onValue={onValue} /> : null;
          })}
        </div>
      )) : null}
    </div>
  );
  const overlays = (
    <>
      {pad ? (
        <NumberPad
          mode={pad.input.mode}
          title={pad.input.title}
          value={pad.digits}
          onChange={(digits) => setPad((prev) => (prev ? { ...prev, digits } : prev))}
          accept={(digits) => inputAccepts(pad.input, digits)}
          onSubmit={(digits) => {
            const input = pad.input;
            setPad(null);
            setChanges((prev) => withChange(prev, { key: input.key, value: padValue(input, digits) }));
          }}
          onClose={() => setPad(null)}
          {...(pad.input.note ? { note: pad.input.note } : {})}
        />
      ) : null}
      {dialog?.kind === 'save' && view?.saveTitle ? (
        <SaveDialog view={view} busy={busy} ready={Boolean(draft)} onClose={() => setDialog(null)} onSave={() => save(dialog.then)} />
      ) : null}
      {dialog?.kind === 'unsaved' && view?.unsavedTitle ? (
        <NoticeDialog
          title={view.unsavedTitle}
          lines={[view.rejection ?? say('saveNote')]}
          actions={[
            { label: say('dontSave'), onPress: () => { const proceed = dialog.proceed; setDialog(null); setChanges([]); proceed(); } },
            ...(view.rejection ? [] : [{ label: view.primary.label, primary: true, onPress: () => save(dialog.proceed) }]),
          ]}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {notice ? <NoticeDialog title={notice.title} lines={notice.lines} onClose={() => setNotice(null)} /> : null}
    </>
  );
  return (
    <SettingsFrame
      tab="rules"
      header={header}
      guard={guard}
      body={body}
      summary={view?.footer}
      pager={<Pager page={at} pageCount={layout.pages.length} onChange={setPage} />}
      primary={view ? {
        label: busy ? t('processing') : view.primary.label,
        ...(busy ? {} : { alts: view.primary.alts }),
        disabled: !view.primary.enabled || busy,
        busy,
        onPress: onPrimary,
      } : null}
      overlays={overlays}
    />
  );
}

/**
 * 저장 확인 창(spec 3-9): 제목 `변경 3건`, 바뀐 곳 목록(이름 · 전 → 후, 넘치면 창 안에서 쪽), 한 줄 `다음 기록부터 적용 · 지난 기록 · 접수 유지`
 * (거절되면 그 자리에 까닭 `변경 불가 · 06:00 이후 가능`), 주 버튼 `저장 · 3건`. 목록 자리는 한 쪽 줄 수만큼 늘 두어 쪽을 넘겨도 창 높이가 같다.
 */
function SaveDialog({ view, busy, ready, onClose, onSave }: { view: ShopRulesView; busy: boolean; ready: boolean; onClose: () => void; onSave: () => void }) {
  const { profile, viewport } = useUi();
  const [page, setPage] = useState(0);
  const perPage = saveRowsPerPage(profile, viewport);
  const pages = Math.max(1, Math.ceil(view.changes.length / perPage));
  const at = Math.min(page, pages - 1);
  const rows = view.changes.slice(at * perPage, (at + 1) * perPage);
  const style = { '--pos-rules-save-rows': Math.min(perPage, view.changes.length) } as CSSProperties;
  return (
    <DialogFrame
      title={view.saveTitle ?? ''}
      onClose={onClose}
      className="pos-rules-save"
      pager={<Pager page={at} pageCount={pages} onChange={setPage} />}
      primary={
        <PrimaryButton
          label={busy ? t('processing') : view.primary.label}
          {...(busy ? {} : { alts: view.primary.alts })}
          disabled={busy || !ready || view.rejection !== undefined}
          busy={busy}
          onPress={onSave}
        />
      }
    >
      <ul className="pos-rules-save-list" style={style}>
        {rows.map((c) => (
          <li key={c.key} className="pos-rules-save-row">
            <span className="pos-rules-save-label">{c.label}</span>
            <span className="pos-rules-save-value">{c.before + ' → ' + c.after}</span>
          </li>
        ))}
      </ul>
      <p className={'pos-rules-save-note' + (view.rejection ? ' is-refused' : '')} role="status">{view.rejection ?? say('saveNote')}</p>
    </DialogFrame>
  );
}
