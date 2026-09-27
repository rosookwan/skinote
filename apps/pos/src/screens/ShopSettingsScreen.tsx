// 관리 → 매장 설정(spec 3-9, ui 6-9, features-1 plan §4-4): 장부형 틀(ui 2-1 나): 제목 `매장 설정` + 색인 탭 `매장 정보` · `장소` · `반납 타임` ·
// `요금 · 할인` · `차량 · 직원` · `운영 규칙`(등급의 탭 칸 수를 넘으면 더 보기), 본문은 카드 목록(위에서 아래로 채우고 모자라면 오른쪽 칸, 칸이
// 다 차면 다음 쪽 — 카드는 자르지 않고, 목록이 한 쪽보다 긴 카드만 목록 줄을 끊어 다음 카드 `{title} (계속)`로 잇는다), 바닥줄 `‹ 관리` · 굵은
// 요약(`변경 3건 · 다음 기록부터 적용`) · 쪽 넘김 · 주황 `저장 · 3건`.
// 운영 규칙(V8)은 shopRules(바꿈 = RuleChange), 다른 탭은 shopSettings(바꿈 = 목록 바꿈 · 직원 바꿈의 op 목록)다. 화면은 계산하지 않는다: 누른
// 고르기 · 값 버튼 · 목록 칸 · 항목 판의 버튼이 읽기 모델이 준 op와 값을 받을 단계(화면 키보드 · 숫자판 · 고르기 판)를 들고 있고, 화면은 단계를
// 차례로 열어 값을 채운 op를 초안에 붙여 다시 묻는다(app/settings-draft.ts). 카드 · 바뀐 곳 · 바닥줄 · 주 버튼 · 저장 명령 · 거절 까닭은 읽기 모델이
// 준다. 저장은 확인 창(`변경 3건`: 전 → 후 목록, `다음 기록부터 적용 · 지난 기록 · 접수 유지`)에서 보낸다(차량 · 직원 탭은 목록 바꿈 뒤에 직원
// 바꿈을 이어서). 저장하지 않은 바꿈이 있는데 `‹ 관리` · 다른 탭 · 머리줄로 떠나면 `미저장 변경 3건` 창(`저장 안 함` · `저장 · 3건`).
// 비밀번호 재발급 · 기기 막기는 서버 모드에만 있는 길이다(체험판은 `체험판 미지원`).
import {
  chainDrafts, envelopeFor, isAccepted, offlineAllowed, type AnyCommandDraft, type ChoiceOption, type ConfirmCommand, type LedgerTabRow, type RuleCard as RuleCardView,
  type RuleChange, type RuleChangeLine, type RuleInput, type RuleRow, type SettingsAction, type SettingsListItem, type SettingsOp, type SettingsRun,
  type SettingsSheet, type SettingsTabKey, type ShopRulesView, type ShopSettingsView, type Basis, type PrimaryLabel,
} from '@skinote/contract';
import { cardColumns, confirmWindow, listColumns, packCards, splitListRows } from '@skinote/layout';
import {
  DialogFrame, FooterBar, Icon, IndexTabs, NumberPad, Pager, PrimaryButton, RuleCard, TextFit, ruleCardHeight, ruleListCells, t, useCommandDraft, useElementSize,
  useUi, type DeviceProfile, type FooterBarProps, type NumberPadMode, type Size,
} from '@skinote/ui';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useClient, useConnection, useLive } from '../app/client.tsx';
import { go, SETTINGS_TABS, type SettingsTab } from '../app/router.ts';
import {
  dropFrom, inputAccepts, inputRun, optionPress, padValue, stepValue, withChange, withOp, type StepRun,
} from '../app/settings-draft.ts';
import { APP_STRINGS_KO, say } from '../app/strings.ts';
import { sendChain } from '../components/ConfirmFlow.tsx';
import { ChoiceSheet, NoticeDialog } from '../components/NoticeDialog.tsx';
import { PinDialog } from '../components/PinDialog.tsx';
import { usePosHeader, type LeaveGuard } from '../components/PosHeader.tsx';
import { TextSheet } from '../components/TextSheet.tsx';

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

/** 매장 설정의 탭 하나: 운영 규칙(V8)과 다른 탭(매장 정보 · 장소 · 반납 타임 · 요금 · 할인 · 차량 · 직원). */
export function ShopSettingsScreen({ tab }: { tab: SettingsTab }) {
  return tab === 'rules' ? <RulesScreen /> : <TabScreen key={tab} tab={tab} />;
}

/**
 * 미리 보기(#/preview/settings-many, 체험판 전용): 읽기 모델을 부르는 쪽이 넘긴 것(체험판이 만든 많은 권종 · 장소의 매장)으로 한 탭을 그린다(규칙
 * 검사기가 긴 카드의 `(계속)`을 잰다).
 */
export function SettingsTabPreview({ tab, load }: { tab: SettingsTabKey; load: (ops: SettingsOp[]) => Promise<ShopSettingsView> }) {
  return <TabScreen key={tab} tab={tab} load={load} />;
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
          mode={pad.input.mode === 'text' ? 'amount' : PAD_MODE[pad.input.mode]}
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
interface SaveView {
  saveTitle?: string;
  changes: RuleChangeLine[];
  primary: PrimaryLabel;
  rejection?: string;
}

function SaveDialog({ view, busy, ready, onClose, onSave }: { view: SaveView; busy: boolean; ready: boolean; onClose: () => void; onSave: () => void }) {
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
            <span className="pos-rules-save-value">{c.before !== undefined ? c.before + ' → ' + c.after : c.after}</span>
          </li>
        ))}
      </ul>
      <p className={'pos-rules-save-note' + (view.rejection ? ' is-refused' : '')} role="status">{view.rejection ?? say('saveNote')}</p>
    </DialogFrame>
  );
}

// ── 매장 설정의 다른 탭(매장 정보 · 장소 · 반납 타임 · 요금 · 할인 · 차량 · 직원, features-1 §4-4) ─────────────────────

/** 카드 조각(그리기 모양 · 목록의 한 줄 칸 수 · 높이). 쪽보다 긴 목록 카드는 조각 여럿(`(계속)`). */
export interface SettingsPiece {
  card: RuleCardView;
  listColumns: number;
  height: number;
}

export interface SettingsLayout {
  columns: number;
  pieces: SettingsPiece[];
  /** 쪽 → 칸 → 조각 색인. */
  pages: number[][][];
}

/**
 * 매장 설정 탭의 카드 칸 · 쪽: 칸 수 · 칸 높이는 운영 규칙과 같고(rulesLayout), 목록 카드의 한 줄 칸 수는 카드 안 폭과 가장 긴 글(이름 · 둘째 줄)로
 * 고르고(listColumns, 끝은 DeviceProfile의 settingsListColumns), 쪽보다 긴 카드는 목록 줄을 끊어 다음 카드 `{title} (계속)`로 잇는다(E26: 첫 조각이
 * 이름표 줄 · 안내를 가진다).
 */
export function settingsLayout(profile: DeviceProfile, box: Size | null, cards: readonly RuleCardView[]): SettingsLayout {
  if (!box) return { columns: 1, pieces: [], pages: [[[]]] };
  const columns = cardColumns(box.width, profile.minTargetPx * profile.pages.ruleCardMinTargets, profile.space.l);
  const cardWidth = (box.width - (columns - 1) * profile.space.l) / columns;
  const inner = cardWidth - 2 * profile.space.m - 2 * profile.line.strong;
  const room = box.height - profile.space.m;
  const pieces: SettingsPiece[] = [];
  for (const card of cards) {
    const cells = ruleListCells(card.list);
    const cols = cells.length
      ? listColumns(inner, cells.flatMap((c) => [c.label, c.tag ?? '']), profile.minFontPx, profile.space.s + profile.line.strong, profile.space.s, profile.pages.settingsListColumns)
      : 1;
    const full = ruleCardHeight(card, profile, cols);
    if (!cells.length || full <= room) {
      pieces.push({ card, listColumns: cols, height: full });
      continue;
    }
    const total = Math.ceil(cells.length / cols);
    const sized = (rows: number, first: boolean) =>
      ruleCardHeight({ ...(first ? card : { ...card, rows: [], notes: [] }), list: { items: cells.slice(0, rows * cols) } }, profile, cols);
    const fit = (first: boolean) => {
      let rows = total;
      while (rows > 1 && sized(rows, first) > room) rows -= 1;
      return rows;
    };
    splitListRows(total, fit(true), fit(false)).forEach(([from, to], i) => {
      const slice = cells.slice(from * cols, to * cols);
      const add = card.list?.add && slice.includes(card.list.add) ? card.list.add : undefined;
      const view: RuleCardView = {
        ...card,
        key: card.key + (i ? '#' + i : ''),
        ...(i ? { rows: [], notes: [], continued: true } : {}),
        list: { items: slice.filter((c) => c !== add), ...(add ? { add } : {}) },
      };
      pieces.push({ card: view, listColumns: cols, height: ruleCardHeight(view, profile, cols) });
    });
  }
  return { columns, pieces, pages: packCards(pieces.map((p) => p.height), room, profile.space.s, columns) };
}

/** 읽기 모델의 입력 모드 → 숫자판 모드(글자 text는 화면 키보드). */
const PAD_MODE: Record<Exclude<RuleInput['mode'], 'text'>, NumberPadMode> = { amount: 'amount', time: 'time', phone: 'phone', minutes: 'minutes', percent: 'percent' };

type Step = StepRun & { digits: string };

/** 매장 설정의 다른 탭 하나(읽기 모델 shopSettings): 카드 · 목록 칸 · 항목 판 · 값 단계 · 저장 확인 창 · 떠날 때 창 · 비밀번호 재발급 · 기기 막기. */
function TabScreen({ tab, load }: { tab: SettingsTabKey; load?: (ops: SettingsOp[]) => Promise<ShopSettingsView> }) {
  const client = useClient();
  const { profile } = useUi();
  const connection = useConnection();
  const title = say(TAB_LABEL[tab]);
  // 매장 설정은 연결이 필요한 결정이다(sync 8-2): 끊겼으면 저장 창 대신 한 줄.
  const needsLink = !connection.online && !offlineAllowed(profile.key, 'registry.update');
  const [ops, setOps] = useState<SettingsOp[]>([]);
  const [page, setPage] = useState(0);
  const [sheet, setSheet] = useState<SettingsSheet | null>(null);
  const [step, setStep] = useState<Step | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<{ title: string; lines: string[] } | null>(null);
  const [pin, setPin] = useState<{ staffId: string; name: string } | null>(null);
  const [block, setBlock] = useState<{ deviceId: string; label: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<ShopSettingsView | null>(null);
  const hold = sheet !== null || step !== null || dialog !== null || notice !== null || pin !== null || block !== null || busy;
  const live = useLive<ShopSettingsView>('settings:' + tab + ':' + JSON.stringify(ops), (c) => (load ? load(ops) : c.query('shopSettings', { tab, changes: ops })), hold);
  useEffect(() => { if (live.data) setLast(live.data); }, [live.data]);
  const view = live.data ?? last;
  // 초안의 한 건이 거절되면(이름 겹침 · 숨김 막힘 …) 그 까닭 한 줄을 보이고 그 건부터 뺀다(읽기 모델의 refused).
  useEffect(() => {
    const refused = live.data?.refused;
    if (!refused) return;
    setNotice({ title, lines: [refused.message] });
    setOps((prev) => dropFrom(prev, refused.at));
  }, [live.data, title]);
  const dirty = (view?.changes.length ?? 0) > 0;
  const guard: LeaveGuard = (proceed) => {
    if (dirty && view?.unsavedTitle) setDialog({ kind: 'unsaved', proceed });
    else proceed();
  };
  const header = usePosHeader('other', 'management', guard);

  // 저장의 요청번호: 확인 창(저장 · 떠날 때)을 연 때 하나(시도마다), 이어 보낼 직원 바꿈도 그때 요청번호를 만든다(앞 명령에 dependsOn).
  const saveKey = dialog && view?.command ? 'settings:' + tab + ':' + attempt : null;
  const { draft, markSent } = useCommandDraft(saveKey, saveKey && view?.command ? view.command : null, view?.basis ?? NO_BASIS);
  const chain = useRef<AnyCommandDraft[]>([]);
  useEffect(() => { chain.current = draft && view?.then ? chainDrafts(draft, view.then) : []; }, [draft?.requestId]);

  const bodyRef = useRef<HTMLDivElement>(null);
  const box = useElementSize(bodyRef);
  const layout = settingsLayout(profile, box, view?.cards ?? []);
  const at = Math.min(page, layout.pages.length - 1);
  const shown = layout.pages[at] ?? [[]];

  const addOp = (op: SettingsOp) => setOps((prev) => withOp(prev, op));
  const start = (run: StepRun | null) => {
    if (!run) return;
    if (run.steps.length === 0) addOp(run.op);
    else setStep({ ...run, digits: '' });
  };
  const unsupported = () => setNotice({ title, lines: [say('demoUnsupported')] });
  const act = (run: SettingsRun) => {
    setSheet(null);
    switch (run.kind) {
      case 'op': start({ op: run.op, steps: run.steps ?? [], index: 0 }); return;
      case 'sheet': setSheet(run.sheet); return;
      // `수거 목록 ›`은 그 차량의 목록으로(2026-09-27 점검: 1호 차량 목록만 열렸다).
      case 'go': guard(() => go(run.to === 'rules' ? { name: 'shopSettings', tab: 'rules' } : { name: 'collection', date: null, ...(run.vehicleId ? { vehicleId: run.vehicleId } : {}) })); return;
      case 'pin': if (client.staffPin) setPin({ staffId: run.staffId, name: run.name }); else unsupported(); return;
      case 'block': if (client.blockDevice) setBlock({ deviceId: run.deviceId, label: run.label }); else unsupported(); return;
    }
  };
  const onStepValue = (value: Parameters<typeof stepValue>[1]) => {
    if (!step) return;
    const out = stepValue(step, value);
    if ('next' in out) setStep({ ...out.next, digits: '' });
    else {
      setStep(null);
      addOp(out.done);
    }
  };
  const onOption = (row: RuleRow, option: ChoiceOption) => {
    const input = row.inputs?.[option.key];
    if (input) start(inputRun(input));
    else if (row.ops?.[option.key]) addOp(row.ops[option.key]!);
  };
  const onValue = (row: RuleRow) => { if (row.value) start(inputRun(row.value.input)); };
  const onLink = (row: RuleRow) => { if (row.link) act({ kind: 'go', to: row.link.to }); };
  const onItem = (item: SettingsListItem) => act(item.run);

  const fail = (line: string) => {
    setBusy(false);
    setNotice({ title, lines: [line] });
  };
  const save = (then?: () => void) => {
    if (!view?.command || !draft || busy) return;
    if (needsLink) { setDialog(null); setNotice({ title, lines: [say('settingsOffline')] }); return; }
    const envelope = envelopeFor(draft, view.command, undefined);
    if (!envelope) return;
    const added = ops.filter((op): op is Extract<SettingsOp, { op: 'staff.add' }> => op.op === 'staff.add');
    setBusy(true);
    markSent();
    (async () => {
      const first = await client.command(envelope);
      if (!isAccepted(first) && first.outcome !== 'superseded') {
        setDialog(null);
        setAttempt((n) => n + 1);
        fail(first.error?.message ?? say('commandFailed'));
        return;
      }
      // 이어 보낼 직원 바꿈(차량 · 직원 탭): 하나라도 안 되면 그 까닭 한 줄(앞 목록 바꿈은 이미 저장됨).
      const firstIds = first.result && (first.result as { staffIds?: unknown }).staffIds;
      let staffIds: string[] = Array.isArray(firstIds) ? firstIds.filter((id): id is string => typeof id === 'string') : [];
      const stopped = await sendChain(async (next) => {
        const outcome = await client.command(next);
        const ids = outcome.result && (outcome.result as { staffIds?: unknown }).staffIds;
        if (Array.isArray(ids)) staffIds = ids.filter((id): id is string => typeof id === 'string');
        return outcome;
      }, chain.current);
      setBusy(false);
      setDialog(null);
      setAttempt((n) => n + 1);
      setOps([]);
      if (stopped) { setNotice({ title, lines: [stopped.error?.message ?? say('commandFailed')] }); return; }
      then?.();
      // 새로 더한 직원 한 사람: 서버 모드면 곧바로 비밀번호 재발급(새 비밀번호를 한 번 보인다, E15).
      const newId = staffIds[0];
      if (!then && client.staffPin && added.length === 1 && newId) setPin({ staffId: newId, name: added[0]!.name });
    })().catch(() => {
      setBusy(false);
      setNotice({ title, lines: [say('sendFailed')] });
    });
  };
  const onPrimary = () => {
    if (!view?.primary.enabled) return;
    if (needsLink) { setNotice({ title, lines: [say('settingsOffline')] }); return; }
    setDialog({ kind: 'save' });
  };
  const doBlock = () => {
    if (!block || !client.blockDevice) return;
    const target = block;
    setBlock(null);
    client.blockDevice(target.deviceId).then(() => setOps((prev) => [...prev]), () => setNotice({ title, lines: [say('commandFailed')] }));
  };

  const colStyle = { '--pos-rules-cols': layout.columns } as CSSProperties;
  const body = (
    <div ref={bodyRef} className="pos-rules-body" style={colStyle}>
      {!view && live.error ? <p className="pos-sheet-note" role="status">{say('settingsUnreadable')}</p> : null}
      {view && box ? Array.from({ length: layout.columns }, (_, c) => (
        <div key={c} className="pos-rules-col">
          {(shown[c] ?? []).map((i) => {
            const piece = layout.pieces[i];
            return piece ? (
              <RuleCard key={piece.card.key} card={piece.card} listColumns={piece.listColumns} onOption={onOption} onValue={onValue} onLink={onLink} onItem={onItem} />
            ) : null;
          })}
        </div>
      )) : null}
    </div>
  );

  const current = step ? step.steps[step.index] : undefined;
  let stepUi: ReactNode = null;
  if (step && current?.kind === 'input' && current.input.mode === 'text') {
    stepUi = (
      <TextSheet
        title={current.input.title}
        value={current.input.value ?? ''}
        placeholder={current.input.title}
        maxLength={current.input.maxLength ?? current.input.max}
        required
        onSubmit={(text) => onStepValue(text)}
        onClose={() => setStep(null)}
      />
    );
  } else if (step && current?.kind === 'input' && current.input.mode !== 'text') {
    const input = current.input;
    stepUi = (
      <NumberPad
        mode={PAD_MODE[input.mode as Exclude<RuleInput['mode'], 'text'>]}
        title={input.title}
        value={step.digits}
        onChange={(digits) => setStep((prev) => (prev ? { ...prev, digits } : prev))}
        accept={(digits) => inputAccepts(input, digits)}
        onSubmit={(digits) => onStepValue(padValue(input, digits))}
        onClose={() => setStep(null)}
        {...(input.note ? { note: input.note } : {})}
      />
    );
  } else if (step && current?.kind === 'choose') {
    stepUi = (
      <ChoiceSheet
        title={current.title}
        choices={current.options.map((o) => ({ key: o.key, label: o.label, ...(o.secondLine ? { note: o.secondLine } : {}) }))}
        onPick={(key) => { const o = current.options.find((x) => x.key === key); if (o) onStepValue(o.value); }}
        onClose={() => setStep(null)}
      />
    );
  }
  const sheetUi = sheet ? (
    <ChoiceSheet
      title={sheet.title}
      lines={sheet.lines}
      choices={sheet.actions.map((a: SettingsAction) => ({
        key: a.key, label: a.label, ...(a.secondLine ? { note: a.secondLine } : {}), ...(a.enabled ? {} : { disabled: true }),
        ...(a.selected !== undefined ? { selected: a.selected } : {}),
      }))}
      onPick={(key) => { const a = sheet.actions.find((x) => x.key === key); if (a?.enabled && !a.selected) act(a.run); }}
      onClose={() => setSheet(null)}
    />
  ) : null;
  const overlays = (
    <>
      {sheetUi}
      {stepUi}
      {dialog?.kind === 'save' && view?.saveTitle ? (
        <SaveDialog view={view} busy={busy} ready={Boolean(draft)} onClose={() => setDialog(null)} onSave={() => save(dialog.then)} />
      ) : null}
      {dialog?.kind === 'unsaved' && view?.unsavedTitle ? (
        <NoticeDialog
          title={view.unsavedTitle}
          lines={[view.rejection ?? say('saveNote')]}
          actions={[
            { label: say('dontSave'), onPress: () => { const proceed = dialog.proceed; setDialog(null); setOps([]); proceed(); } },
            ...(view.rejection ? [] : [{ label: view.primary.label, primary: true, onPress: () => save(dialog.proceed) }]),
          ]}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {block ? (
        <NoticeDialog
          title={block.label}
          lines={[]}
          actions={[{ label: say('blockDevice', { label: block.label }), primary: true, onPress: doBlock }]}
          onClose={() => setBlock(null)}
        />
      ) : null}
      {pin ? <PinDialog client={client} staffId={pin.staffId} name={pin.name} onClose={() => setPin(null)} /> : null}
      {notice ? <NoticeDialog title={notice.title} lines={notice.lines} onClose={() => setNotice(null)} /> : null}
    </>
  );
  return (
    <SettingsFrame
      tab={tab}
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
