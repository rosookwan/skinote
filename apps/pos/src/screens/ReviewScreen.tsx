// 확인 필요(features-1 §9-3, 머리줄 메뉴 `확인 필요`, #/review · #/review/done): 장부형 종이 한 장, 주 버튼 없음.
//   - 제목 `확인 필요`와 색인 탭 `미처리 {n}` · `처리 완료`.
//   - 미처리: 한 줄에 한 문장(`사실 · 할 일`, 두 줄까지 · 할 일 조각이 먼저 빠짐)과 오른쪽 버튼 둘(읽기 모델 choices: `확인` · `접수증`, 초과 수납은
//     `환불 · 10,000원`, 미입고는 `수거 목록`, 차량 예비권 기록 부족은 `예비권 적재` · `리프트권`).
//   - 처리 완료(오늘 영업일): 옅은 줄, 둘째 줄 `확인 완료 · 16:20 · 한가람`, 버튼 없음.
// 줄 높이는 남는 높이를 나눠 쓰고(layout fillRows, 긴급 줄 높이부터) 넘치면 바닥줄에서 쪽을 넘긴다. 화면은 셈하지 않는다: 줄 · 버튼 · 누를 수 있는지는
// 읽기 모델(reviewList) 그대로다. `확인`은 창 없이 보낸다(요청번호는 그 줄을 처음 누를 때 하나, 다시 누르면 같은 번호). 환불은 환불 창(RefundDialog),
// 예비권 적재는 예비권 창(SpareDialog).
import {
  draftToEnvelope, isAccepted, openCommandDraft, type AnyCommandDraft, type LedgerTabRow, type ReviewChoice, type ReviewItem, type ReviewListView, type ReviewTabKey,
} from '@skinote/contract';
import { fillRows } from '@skinote/layout';
import { FooterBar, Icon, IndexTabs, Pager, TextFit, t, useElementSize, useUi } from '@skinote/ui';
import { useMemo, useRef, useState, type CSSProperties } from 'react';
import { useClient, useLive } from '../app/client.tsx';
import { go } from '../app/router.ts';
import { say } from '../app/strings.ts';
import { ChoiceSheet, NoticeDialog } from '../components/NoticeDialog.tsx';
import { usePosHeader } from '../components/PosHeader.tsx';
import { RefundDialog } from '../components/RefundDialog.tsx';
import { SpareDialog } from '../components/SpareDialog.tsx';

/** 읽기 모델의 탭 → 색인 탭 행(화면 설정 행과 같은 모양: 수를 보이는 탭만 수). */
export function reviewTabs(view: Pick<ReviewListView, 'tabs'>): { tabs: LedgerTabRow[]; counts: Record<string, number> } {
  const tabs: LedgerTabRow[] = view.tabs.map((tab, i) => ({
    tab_key: tab.key, label: tab.label, short_label: null, filter_key: 'all', params: null, seq: (i + 1) * 10, priority: 100 - i * 10,
    overflow_key: 'more_sheet', shows_count: tab.count === undefined ? 0 : 1, feature_key: null, feature_on: 1,
  }));
  const counts = Object.fromEntries(view.tabs.flatMap((tab) => (tab.count === undefined ? [] : [[tab.key, tab.count]])));
  return { tabs, counts };
}

/** 버튼 하나가 할 일(화면 이동 · 창 · 명령). 읽기 모델의 key 그대로 고른다(업무 규칙이 아님). */
export type ReviewPress =
  | { kind: 'route'; route: Parameters<typeof go>[0] }
  | { kind: 'refund'; orderId: string }
  | { kind: 'spare'; vehicleId: string }
  | { kind: 'resolve' }
  | { kind: 'none' };

export function reviewPress(choice: ReviewChoice): ReviewPress {
  switch (choice.key) {
    case 'slip': return choice.orderId ? { kind: 'route', route: { name: 'slip', orderId: choice.orderId } } : { kind: 'none' };
    // 미입고는 그 차량의 수거 목록으로(`?vehicle=`).
    case 'collections': return { kind: 'route', route: { name: 'collection', date: choice.date ?? null, ...(choice.vehicleId ? { vehicleId: choice.vehicleId } : {}) } };
    case 'tickets': return { kind: 'route', route: { name: 'tickets', tab: 'status' } };
    case 'refund': return choice.orderId ? { kind: 'refund', orderId: choice.orderId } : { kind: 'none' };
    case 'spare_load': return choice.vehicleId ? { kind: 'spare', vehicleId: choice.vehicleId } : { kind: 'none' };
    case 'resolve': return choice.command ? { kind: 'resolve' } : { kind: 'none' };
  }
}

type Dialog = { kind: 'refund'; orderId: string } | { kind: 'spare'; vehicleId: string };

export function ReviewScreen({ tab }: { tab: ReviewTabKey }) {
  const client = useClient();
  const header = usePosHeader('other', 'review_list');
  const { profile } = useUi();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<{ title: string; lines: string[] } | null>(null);
  const [more, setMore] = useState<LedgerTabRow[] | null>(null);
  const [page, setPage] = useState(0);
  const [sending, setSending] = useState<string | null>(null);
  // `확인`의 초안(줄마다 처음 누를 때 하나, 다시 누르면 같은 요청번호: sync 2절).
  const drafts = useRef(new Map<string, AnyCommandDraft>());
  const live = useLive<ReviewListView>('review-screen', (c) => c.query('reviewList', {}), dialog !== null || notice !== null || more !== null || sending !== null || header.active);
  const view = live.data;
  const bodyRef = useRef<HTMLDivElement>(null);
  const body = useElementSize(bodyRef);
  const tabRows = useMemo(() => (view ? reviewTabs(view) : { tabs: [], counts: {} }), [view]);

  // 본문 높이(잰 값)에서 위 · 아래 여백(app.css .pos-review-body의 s · l)을 뺀 자리.
  const room = Math.max(0, (body?.height ?? 0) - profile.space.s - profile.space.l);
  const rows: ReviewItem[] = view ? (tab === 'open' ? view.items : view.done) : [];
  const fit = fillRows(room, rows.length, profile.pinRowPx, profile.fill.rowMaxPx);
  const current = Math.min(page, fit.pageCount - 1);
  const shown = rows.slice(current * fit.perPage, (current + 1) * fit.perPage);

  const toTab = (key: string) => {
    setPage(0);
    if (key === 'open' || key === 'done') go({ name: 'review', tab: key }, { replace: true });
  };
  const resolve = (item: ReviewItem, choice: ReviewChoice) => {
    if (!choice.command || !view || sending) return;
    const draft = drafts.current.get(item.id) ?? openCommandDraft(choice.command, view.basis);
    drafts.current.set(item.id, draft);
    setSending(item.id);
    client.command(draftToEnvelope(draft, {}, choice.command)).then((outcome) => {
      setSending(null);
      // 된 것(적용 · 다른 사람이 먼저 끝냄): 목록이 새로 읽혀 줄이 처리 완료로 간다. 그 밖(충돌 · 거절)은 한 줄 알림.
      if (isAccepted(outcome) || outcome.outcome === 'superseded') return;
      drafts.current.delete(item.id);
      setNotice({ title: view.title, lines: [outcome.error?.message ?? say('commandFailed')] });
    }, () => {
      setSending(null);
      setNotice({ title: view.title, lines: [say('sendFailed')] });
    });
  };
  const onChoice = (item: ReviewItem, choice: ReviewChoice) => {
    if (!choice.enabled) return;
    const press = reviewPress(choice);
    if (press.kind === 'route') go(press.route);
    else if (press.kind === 'refund') setDialog({ kind: 'refund', orderId: press.orderId });
    else if (press.kind === 'spare') setDialog({ kind: 'spare', vehicleId: press.vehicleId });
    else if (press.kind === 'resolve') resolve(item, choice);
  };
  const fail = (line: string) => { setDialog(null); setNotice({ title: view?.title ?? '', lines: [line] }); };
  const style = { '--pos-review-line': fit.rowPx + 'px' } as CSSProperties;

  return (
    <div className="sn-screen">
      {header.element}
      <div className="sn-desk">
        <main className="sn-sheet pos-review" aria-label={view?.title ?? say('titleReview')} style={style}>
          {view ? (
            <IndexTabs title={view.title} tabs={tabRows.tabs} counts={tabRows.counts} active={tab} onSelect={toTab} onMore={(tabs) => setMore(tabs)} />
          ) : null}
          {!view && live.error ? <p className="pos-sheet-note" role="status">{say('reviewUnreadable')}</p> : null}
          <div ref={bodyRef} className="pos-review-body">
            {view ? (
              rows.length ? (
                <ul className="pos-review-rows">
                  {shown.map((item) => <ReviewLine key={item.id} item={item} busy={sending === item.id} onChoice={(choice) => onChoice(item, choice)} />)}
                </ul>
              ) : <p className="pos-review-empty" role="status">{view.empty[tab]}</p>
            ) : null}
          </div>
        </main>
      </div>
      <FooterBar metrics={[]} pager={<Pager page={current} pageCount={fit.pageCount} onChange={setPage} />}>
        <div className="pos-footer-back">
          <button type="button" className="sn-button" onClick={() => go({ name: 'ledger', date: null })}>
            <Icon name="left" />
            <span>{t('home')}</span>
          </button>
        </div>
      </FooterBar>
      {more ? (
        <ChoiceSheet
          title={t('more')}
          choices={more.map((x) => ({ key: x.tab_key, label: x.label + (tabRows.counts[x.tab_key] !== undefined ? ' ' + tabRows.counts[x.tab_key] : '') }))}
          onPick={(key) => { setMore(null); toTab(key); }}
          onClose={() => setMore(null)}
        />
      ) : null}
      {dialog?.kind === 'refund' ? <RefundDialog orderId={dialog.orderId} onClose={() => setDialog(null)} onFail={fail} /> : null}
      {dialog?.kind === 'spare' ? <SpareDialog vehicleId={dialog.vehicleId} direction="load" onClose={() => setDialog(null)} onFail={fail} /> : null}
      {notice ? <NoticeDialog title={notice.title} lines={notice.lines} onClose={() => setNotice(null)} /> : null}
      {header.overlays}
    </div>
  );
}

/**
 * 확인 필요 한 줄: 열린 것은 문장(두 줄까지) + 버튼 둘, 처리 완료는 옅은 문장(한 줄) + 둘째 줄 `확인 완료 · 16:20 · 한가람`. 누를 수 없는 버튼은 흐리고
 * 까닭을 읽는 이름에 붙인다.
 */
function ReviewLine({ item, busy, onChoice }: { item: ReviewItem; busy: boolean; onChoice: (choice: ReviewChoice) => void }) {
  const parts = item.parts ?? [{ text: item.message, drop: 0 }];
  const done = item.status === 'resolved';
  return (
    <li className={'pos-review-line' + (done ? ' is-done' : '')} aria-label={item.message}>
      <span className="pos-review-text">
        <TextFit className="pos-review-sentence" input={{ mode: 'parts', parts }} lines={done ? 1 : 2} />
        {done && item.resolvedLine ? <TextFit className="pos-review-note" input={{ mode: 'words', text: item.resolvedLine }} /> : null}
      </span>
      {item.choices?.length ? (
        <span className="pos-review-actions" role="group" aria-label={say('reviewActions')}>
          {item.choices.map((choice) => (
            <button
              key={choice.key}
              type="button"
              className="sn-button pos-review-button"
              disabled={!choice.enabled || busy}
              aria-busy={(busy && choice.key === 'resolve') || undefined}
              aria-label={choice.reason ? choice.label + ' · ' + choice.reason : choice.label}
              onClick={() => onChoice(choice)}
            >
              <span>{busy && choice.key === 'resolve' ? t('processing') : choice.label}</span>
            </button>
          ))}
        </span>
      ) : null}
    </li>
  );
}
