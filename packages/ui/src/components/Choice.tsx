// 고르기 버튼(ChoiceButton, 시안의 mk-choice)과 한 줄의 고르기 버튼들(ChoiceRow). 반납 시각 · 반납 장소 · 수거 차량 · 방식 고르기가 쓴다.
// 고른 것은 남색 바탕 · 크림 글자(주황이 아님: 주 버튼과 헷갈리지 않게), 누를 수 없는 것은 점선 · 회색이고 자리는 그대로 둔다
// (창 높이 · 줄 자리가 흔들리지 않게). 두 줄 버튼('솔마을' / '두솔동'), 다음 단이 열리는 버튼은 글 뒤에 '›'(글자로 둔다).
// 한 줄에 다 들어가지 않으면 덜 중요한 것부터 줄인다: 짧은 이름이 있는 버튼은 짧은 이름('오전타임 후 12:00' → '12:00'), 그래도 넘치면
// 끝 칸이 '더 보기'가 되어 나머지를 같은 줄에 차례로 보인다(스크롤 · 말줄임 없음). 부르는 쪽이 more를 주면 끝 칸은 그 이름('규격 더 보기 ›')
// 이고 누르면 부르는 쪽이 모든 선택지의 작은 창을 연다(부츠 220 ~ 300, spec 3-4). 무엇을 고를 수 있는지는 읽기 모델이 정했다.
import type { ChoiceOption } from '@skinote/contract';
import { useRef, useState, type ReactNode } from 'react';
import { useElementSize, useFontsVersion, useIsoLayoutEffect } from '../measure.ts';
import { t } from '../strings.ko-KR.ts';

export interface ChoiceButtonProps {
  option: ChoiceOption;
  onPress: (key: string) => void;
  /** 읽는 이름(열리는 버튼 '다른 날 · 날짜 선택', 고른 구역 '솔마을 두솔동 · 장소 다시 선택'). 없으면 이름(+ 누를 수 없는 까닭). */
  name?: string;
  /** 줄이 좁아 짧은 이름으로 쓴다. */
  useShort?: boolean;
}

export function ChoiceButton({ option, onPress, name, useShort = false }: ChoiceButtonProps) {
  // 두 줄 버튼도 짧은 이름이 있으면 좁을 때 한 줄 짧은 이름이다(`분실금 청구` / `보증금 공제` → `차액 청구`).
  const short = useShort && option.short !== undefined;
  const two = option.secondLine !== undefined && !short;
  const text = short ? option.short! : option.label;
  // 읽는 이름은 늘 온전한 이름(짧게 보일 때도)과 누를 수 없는 까닭.
  const aria = name ?? (option.reason ? option.label + ' · ' + option.reason : text !== option.label ? option.label : undefined);
  return (
    <button
      type="button"
      className={'sn-button sn-choice' + (two ? ' is-two' : '')}
      aria-pressed={option.selected}
      disabled={!option.enabled}
      {...(aria ? { 'aria-label': aria } : {})}
      onClick={() => onPress(option.key)}
    >
      {two ? (
        <>
          <span>{option.label}</span>
          <small>{option.secondLine}</small>
        </>
      ) : (
        <>
          {text}
          {option.opens ? <>{' '}<span className="sn-choice-more">›</span></> : null}
        </>
      )}
    </button>
  );
}

export interface ChoiceRowProps {
  options: ChoiceOption[];
  onPress: (key: string) => void;
  /** 묶음의 읽는 이름('반납 시각'). */
  label: string;
  /** 버튼마다 읽는 이름(key → 이름). */
  names?: Readonly<Record<string, string>>;
  /** 줄 맨 앞의 버튼(장소 줄의 '‹ 구역'). 줄이 좁아도 빠지지 않는다. */
  lead?: ReactNode;
  /** 넘칠 때의 끝 칸(같은 줄의 '더 보기' 대신): 이름('규격 더 보기') 뒤에 '›', 누르면 onPress(모든 선택지의 작은 창). */
  more?: { label: string; onPress: () => void };
  /** 줄 맨 끝의 버튼(운영 규칙의 값 버튼 `1매 5,000원 ›`). 줄이 좁아도 빠지지 않는다. */
  trail?: ReactNode;
}

interface Fit {
  signature: string;
  /** 짧은 이름으로 쓰는 버튼 수(앞에서부터). */
  shorts: number;
  /** 한 번에 보이는 버튼 수(null = 모두). 모자라면 끝 칸이 '더 보기'. */
  count: number | null;
  /** '더 보기'로 넘긴 첫 버튼. */
  start: number;
}

export function ChoiceRow({ options, onPress, label, names, lead, more: moreCell, trail }: ChoiceRowProps) {
  const ref = useRef<HTMLDivElement>(null);
  const box = useElementSize(ref);
  const fonts = useFontsVersion();
  const signature = JSON.stringify([options.map((o) => [o.key, o.label, o.short ?? '', o.secondLine ?? '', o.opens ? 1 : 0]), box?.width ?? 0, fonts]);
  const [fit, setFit] = useState<Fit>({ signature, shorts: 0, count: null, start: 0 });
  const current: Fit = fit.signature === signature ? fit : { signature, shorts: 0, count: null, start: 0 };
  const shortable = options.flatMap((o, i) => (o.short && o.short !== o.label ? [i] : []));
  const shortSet = new Set(shortable.slice(0, current.shorts));
  const all = current.count === null || current.count >= options.length;
  const count = all ? options.length : Math.max(1, current.count ?? options.length);
  const start = all || moreCell ? 0 : current.start % options.length;
  const shown = all ? options.map((o, i) => ({ o, i })) : options.map((o, i) => ({ o, i })).slice(start, start + count);

  // 그린 뒤 줄이 넘치면 한 단계씩 줄인다(짧은 이름 → 더 보기). 들어가면 그대로 둔다.
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.scrollWidth <= el.clientWidth + 1) {
      if (fit.signature !== signature) setFit(current);
      return;
    }
    if (current.shorts < shortable.length) setFit({ ...current, shorts: current.shorts + 1 });
    else if (count > 1) setFit({ ...current, count: all ? options.length - 1 : count - 1 });
  });

  const more = () => setFit({ ...current, start: start + count >= options.length ? 0 : start + count });
  return (
    <div ref={ref} className="sn-choices" role="group" aria-label={label}>
      {lead}
      {shown.map(({ o, i }) => (
        <ChoiceButton key={o.key} option={o} onPress={onPress} useShort={shortSet.has(i)} {...(names?.[o.key] ? { name: names[o.key] } : {})} />
      ))}
      {all ? null : moreCell ? (
        <button type="button" className="sn-button sn-choice" onClick={moreCell.onPress}>{moreCell.label}{' '}<span className="sn-choice-more">›</span></button>
      ) : (
        <button type="button" className="sn-button sn-choice" onClick={more}>{t('more')}</button>
      )}
      {trail}
    </div>
  );
}
