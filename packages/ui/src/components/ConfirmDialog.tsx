// 확인 창(ui 5 ConfirmDialog): 도장 · 수납 · 입고 같은 일을 확정하기 전의 요약. 도장은 이 창을 거친 뒤에만 찍힌다.
// 창 크기는 잰 화면으로 정한다(layout의 confirmWindow, 4-5). 창이 열릴 때 요청번호를 만들어 초안에 저장하고
// (useCommandDraft), 두 번 누르기 · '처리 중'에 또 누르기에는 같은 번호로 보낸다. 창이 열린 채 새로 고침한 뒤 같은 창을
// 다시 열면(보내기 전 · 자료가 그대로) 같은 번호를 쓰고, 한 번 보낸 초안의 번호는 새 창에 쓰지 않는다. 스크롤은 없다.
import {
  openCommandDraft, reusableDraft, type AnyCommandDraft, type Basis, type ConfirmCommand, type OpenDraftOptions,
} from '@skinote/contract';
import { confirmWindow } from '@skinote/layout';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useUi } from '../context.tsx';
import { Icon } from '../icons.tsx';
import { t } from '../strings.ko-KR.ts';
import { PrimaryButton } from './PrimaryButton.tsx';
import { TextFit } from './TextFit.tsx';

const DRAFT_PREFIX = 'sn-draft:';

function readDraft(key: string): AnyCommandDraft | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(DRAFT_PREFIX + key);
    return raw ? (JSON.parse(raw) as AnyCommandDraft) : null;
  } catch {
    return null;
  }
}

function writeDraft(key: string, draft: AnyCommandDraft | null): void {
  try {
    if (draft) globalThis.sessionStorage?.setItem(DRAFT_PREFIX + key, JSON.stringify(draft));
    else globalThis.sessionStorage?.removeItem(DRAFT_PREFIX + key);
  } catch {
    // 저장이 막힌 브라우저(사생활 보호 창)에서도 창은 돈다. 새로 고침 뒤에는 새 번호가 된다.
  }
}

/**
 * 창을 열 때의 초안: 저장된 초안이 아직 보내지 않은 같은 일 · 같은 basis면 그것(새로 고침 뒤 다시 연 창), 아니면 새 요청번호.
 * 순수 함수라 시험이 저장소 없이 부른다.
 */
export function openOrRestoreDraft(saved: AnyCommandDraft | null, command: ConfirmCommand, basis: Basis, options: OpenDraftOptions = {}): AnyCommandDraft {
  return reusableDraft(saved, command.type, basis) ?? openCommandDraft(command, basis, options);
}

export interface CommandDraftHandle {
  draft: AnyCommandDraft | null;
  /** 명령을 보내기 직전에 부른다: 이 요청번호는 이제 끝난 일로 적힌다(새 창에 다시 쓰지 않음). */
  markSent: () => void;
}

/**
 * 확인 창의 명령 초안. key가 생기면(창이 열리면) 초안을 만들고(요청번호 · basis · expect 고정), key가 null이 되거나
 * 부품이 사라지면(창을 닫음 · 화면을 떠남) 저장된 초안을 지운다. 새로 고침은 지우는 틈이 없어 남고, 다시 열 때 위의 규칙으로 가린다.
 */
export function useCommandDraft(key: string | null, command: ConfirmCommand | null, basis: Basis, options: OpenDraftOptions = {}): CommandDraftHandle {
  const [draft, setDraft] = useState<AnyCommandDraft | null>(null);
  const openKey = useRef<string | null>(null);
  const current = useRef<AnyCommandDraft | null>(null);
  useEffect(() => {
    if (key === null || command === null) {
      if (openKey.current) writeDraft(openKey.current, null);
      openKey.current = null;
      current.current = null;
      setDraft(null);
      return;
    }
    if (openKey.current === key) return;
    if (openKey.current) writeDraft(openKey.current, null);
    openKey.current = key;
    const next = openOrRestoreDraft(readDraft(key), command, basis, options);
    writeDraft(key, next);
    current.current = next;
    setDraft(next);
    // 초안은 창이 열릴 때 한 번만 만든다: 그 뒤 새 rev · 본문이 와도 basis와 요청번호는 그대로다.
  }, [key]);
  // 화면을 떠나 부품이 사라지면(창을 닫지 않고) 그 초안은 버린다: 다음에 여는 창은 새 일이다.
  useEffect(() => () => { if (openKey.current) writeDraft(openKey.current, null); }, []);
  const markSent = useCallback(() => {
    const open = current.current;
    if (!open || !openKey.current || open.sentAt) return;
    const sent = { ...open, sentAt: new Date().toISOString() };
    current.current = sent;
    writeDraft(openKey.current, sent);
  }, []);
  return { draft, markSent };
}

/** 창이 끝났을 때(명령을 보냈거나 닫음) 저장된 초안을 지운다. */
export function clearCommandDraft(key: string): void {
  writeDraft(key, null);
}

/**
 * 주 버튼 글이 창 폭에 들어가지 않을 때의 짧은 글들(긴 것부터). 수(`2개` · `1매`)는 끝까지 지킨다: 좁은 기사 휴대폰에서 `수거 처리 · 2개`만
 * 보이면 권 1매를 두고 올 수 있다(2026-09-26 첫 매장 검토). 차례는 ① 그대로, ② 동작 이름의 `처리`를 뗀 것(`수거 · 2개 · 1매`), ③ 금액 조각
 * (`보증금 15,000원`, 창의 요약 줄에 있음)을 뺀 것과 그 짧은 이름, ④ 마지막으로 뒤 조각부터 뺀 것(`수거 처리 · 2개` → `수거 처리`).
 */
export function confirmLabelAlts(label: string): string[] {
  const parts = label.split(' · ');
  const [name = '', ...rest] = parts;
  const short = name.includes(' ') ? name.split(' ')[0]! : name;
  const counts = rest.filter((p) => !/원$/.test(p));
  const out: string[] = [label];
  const add = (list: string[]) => { const text = list.join(' · '); if (!out.includes(text)) out.push(text); };
  if (rest.length) add([short, ...rest]);
  if (counts.length < rest.length) { add([name, ...counts]); if (counts.length) add([short, ...counts]); }
  for (let i = 1; i < parts.length; i += 1) add(parts.slice(0, parts.length - i));
  return out;
}

export interface ConfirmQuantity {
  value: number;
  min: number;
  max: number;
  unit: string;
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** 확정 전 요약 줄(쉬운 말 한 줄씩). */
  summary: string[];
  /** 수량 −/+ (지급 · 반납 · 받음의 일부만). */
  quantity?: ConfirmQuantity;
  onQuantityChange?: (value: number) => void;
  /** 주 버튼 이름('받음 도장 · 4개'). */
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  /** 결과를 기다리는 중: 다시 눌러도 같은 요청번호로 간다. */
  busy?: boolean;
  /** 주 버튼을 누를 수 없음(이 요청번호로 보낸 일이 끝나 다시 보낼 것이 없음: 창을 닫는다). */
  disabled?: boolean;
  /** 이 창의 요청번호(초안). 시험 · 기록이 읽는다. */
  requestId?: string;
  /** 창 안의 단계(확인 필요 · 카드 결과 모름 등). */
  children?: ReactNode;
}

export function ConfirmDialog({ open, title, summary, quantity, onQuantityChange, confirmLabel, onConfirm, onClose, busy = false, disabled = false, requestId, children }: ConfirmDialogProps) {
  const { profile, viewport } = useUi();
  const titleId = useId();
  const primaryRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    primaryRef.current?.querySelector('button')?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  const size = confirmWindow(viewport, profile.confirm, 1, profile.capacity.quickMethods, profile.capacity.paymentSectionsPerPage);
  return (
    <div className="sn-overlay">
      <div
        className="sn-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-request-id={requestId}
        style={{ width: size.widthPx, maxHeight: size.heightPx }}
      >
        <header className="sn-dialog-head">
          <h2 id={titleId} className="sn-dialog-title"><TextFit input={{ mode: 'words', text: title }} /></h2>
        </header>
        <div className="sn-dialog-body">
          {summary.map((line, i) => (
            <p key={i} className="sn-dialog-line">{line}</p>
          ))}
          {quantity ? (
            <div className="sn-qty" role="group" aria-label={t('qtySet')}>
              <button type="button" className="sn-qty-button" aria-label={t('qtyMinus')} disabled={quantity.value <= quantity.min} onClick={() => onQuantityChange?.(quantity.value - 1)}>−</button>
              <output className="sn-qty-value" aria-live="polite">{quantity.value + quantity.unit}</output>
              <button type="button" className="sn-qty-button" aria-label={t('qtyPlus')} disabled={quantity.value >= quantity.max} onClick={() => onQuantityChange?.(quantity.value + 1)}>+</button>
            </div>
          ) : null}
          {children}
        </div>
        <footer className="sn-dialog-foot">
          <button type="button" className="sn-button" onClick={onClose}>
            <Icon name="left" />
            <span>{t('close')}</span>
          </button>
          <div ref={primaryRef} className="sn-dialog-primary">
            <PrimaryButton label={busy ? t('processing') : confirmLabel} {...(busy ? {} : { alts: confirmLabelAlts(confirmLabel) })} onPress={onConfirm} busy={busy} disabled={disabled} />
          </div>
        </footer>
      </div>
    </div>
  );
}
