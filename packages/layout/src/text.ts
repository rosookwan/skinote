// 글자 맞추기(ui 4-3). 옛 pos-shell.js의 엔진(parts · items · words · alts)을 옮기고 조각 우선순위를 더했다.
// 말줄임표(…)는 쓰지 않는다: 덜 중요한 부분이 통째로 빠지고, 품목 목록은 '외 N종'으로 끝난다.
// 폭은 부르는 쪽이 넘기는 measure(글자 → px)로 잰다: 화면은 묶은 글꼴의 canvas, 서버와 시험은 글자 폭 표.

export type Measure = (text: string) => number;

export const PART_JOINER = ' · ';

export interface TextPart {
  text: string;
  /** 0 = 빠지지 않음, 큰 것부터 먼저 빠진다(같으면 뒤쪽부터). */
  drop: number;
  /** 조각을 다 빼도 넘치면 이 조각 안에서 낱말을 뒤에서부터 뺀다. */
  words?: boolean;
  /** 빠질 차례가 오면 먼저 이 짧은 글로 바뀌고(한 번), 그래도 넘치면 그다음 차례에 빠진다('꽃마을 들국화' → '들국화'). */
  short?: string;
}

export interface FitResult {
  text: string;
  /** 모두 들어갔는지. false면 부르는 쪽이 두 줄로 내리거나(허락될 때) 규칙 검사가 잡는다. */
  fits: boolean;
  /** 빠진 조각 · 품목 · 낱말 수. */
  dropped: number;
}

export interface ItemsWording {
  /** '외 {n}종' */
  more: (n: number) => string;
  /** '품목 {n}종' */
  kinds: (n: number) => string;
}

export const KO_ITEMS_WORDING: ItemsWording = {
  more: (n) => '외 ' + n + '종',
  kinds: (n) => '품목 ' + n + '종',
};

const within = (text: string, widthPx: number, measure: Measure) => measure(text) <= widthPx + 0.5;

/** 낱말 맞추기: 뒤에서부터 낱말을 뺀다(첫 낱말은 남긴다). */
export function fitWords(text: string, widthPx: number, measure: Measure): FitResult {
  const words = text.split(' ').filter(Boolean);
  let dropped = 0;
  while (words.length > 1 && !within(words.join(' '), widthPx, measure)) {
    words.pop();
    dropped += 1;
  }
  const out = words.join(' ');
  return { text: out, fits: within(out, widthPx, measure), dropped };
}

/**
 * 조각 맞추기: drop이 큰 조각부터 통째로 뺀다(짧은 글이 있는 조각은 먼저 짧은 글로 바꾼다). 빠지지 않는 조각만 남아도
 * 넘치면 words 조각 안에서 낱말을 줄인다.
 */
export function fitParts(parts: readonly TextPart[], widthPx: number, measure: Measure, joiner = PART_JOINER): FitResult {
  const live = parts.filter((p) => p.text.trim() !== '').map((p) => ({ ...p }));
  let dropped = 0;
  const join = () => live.map((p) => p.text).join(joiner);
  while (!within(join(), widthPx, measure)) {
    let victim = -1;
    live.forEach((p, i) => {
      if (p.drop > 0 && (victim < 0 || p.drop >= (live[victim]?.drop ?? 0))) victim = i;
    });
    if (victim < 0) break;
    const part = live[victim]!;
    if (part.short && part.short.trim() !== '' && part.short !== part.text) {
      part.text = part.short;
      delete part.short;
      continue;
    }
    live.splice(victim, 1);
    dropped += 1;
  }
  if (within(join(), widthPx, measure)) return { text: join(), fits: true, dropped };
  // 빠지지 않는 조각만 남았다: 낱말을 줄여도 된다고 표시한 조각(긴 단체 이름)에서만 줄인다.
  const target = live.find((p) => p.words);
  if (target) {
    const others = measure(live.filter((p) => p !== target).map((p) => p.text).join(joiner) + (live.length > 1 ? joiner : ''));
    const inner = fitWords(target.text, Math.max(0, widthPx - others), measure);
    target.text = inner.text;
    dropped += inner.dropped;
  }
  const out = join();
  return { text: out, fits: within(out, widthPx, measure), dropped };
}

/** 품목 맞추기: '스키 2 · 보드 1 · 헬멧 3' → '스키 2 · 보드 1 외 1종' → '스키 2 외 2종' → '품목 3종'. */
export function fitItems(items: readonly string[], widthPx: number, measure: Measure, wording: ItemsWording = KO_ITEMS_WORDING, joiner = PART_JOINER): FitResult {
  const list = items.filter((t) => t.trim() !== '');
  for (let k = list.length; k >= 1; k -= 1) {
    const text = list.slice(0, k).join(joiner) + (k < list.length ? ' ' + wording.more(list.length - k) : '');
    if (within(text, widthPx, measure)) return { text, fits: true, dropped: list.length - k };
  }
  if (list.length > 1) {
    const text = wording.kinds(list.length);
    return { text, fits: within(text, widthPx, measure), dropped: list.length };
  }
  const only = list[0] ?? '';
  return { text: only, fits: within(only, widthPx, measure), dropped: 0 };
}

/** 짧은 대체 문구: 들어가는 첫 문구(긴 것부터 적는다). 없으면 가장 짧은 것. */
export function fitAlts(alts: readonly string[], widthPx: number, measure: Measure): FitResult {
  for (let i = 0; i < alts.length; i += 1) {
    const text = alts[i]!;
    if (within(text, widthPx, measure)) return { text, fits: true, dropped: i };
  }
  const last = alts.at(-1) ?? '';
  return { text: last, fits: within(last, widthPx, measure), dropped: Math.max(0, alts.length - 1) };
}

export type TextFitInput =
  | { mode: 'parts'; parts: readonly TextPart[] }
  | { mode: 'items'; items: readonly string[] }
  | { mode: 'words'; text: string }
  | { mode: 'alts'; alts: readonly string[] };

export function fitText(input: TextFitInput, widthPx: number, measure: Measure, wording: ItemsWording = KO_ITEMS_WORDING): FitResult {
  switch (input.mode) {
    case 'parts': return fitParts(input.parts, widthPx, measure);
    case 'items': return fitItems(input.items, widthPx, measure, wording);
    case 'words': return fitWords(input.text, widthPx, measure);
    case 'alts': return fitAlts(input.alts, widthPx, measure);
  }
}

/** 맞추기 전의 온전한 글(처음 그릴 때 · 서버 그리기). */
export function fullText(input: TextFitInput): string {
  switch (input.mode) {
    case 'parts': return input.parts.map((p) => p.text).filter(Boolean).join(PART_JOINER);
    case 'items': return input.items.join(PART_JOINER);
    case 'words': return input.text;
    case 'alts': return input.alts[0] ?? '';
  }
}

/** 바닥줄 숫자 하나(글자로 바꾼 값). */
export interface MetricText {
  key: string;
  label: string;
  /** 값 글자('14', '485,000원', '18팀'). */
  value: string;
  priority: number;
  /** 옆의 숫자와 합칠 수 있는지('지급 14 · 반납 9' → '지급/반납 14/9'). */
  foldable: boolean;
  /** 값이 품목 목록이면(차에 있는 것) 품목 맞추기. */
  items?: readonly string[];
}

export interface MetricsFit {
  text: string;
  fits: boolean;
  shown: string[];
  folded: boolean;
}

/**
 * 바닥줄 숫자 맞추기(ui 4-4): 먼저 이웃한 합칠 수 있는 숫자 둘을 합치고('지급/반납 14/9'), 그다음 우선순위 낮은 숫자를 뺀다.
 * 품목 목록 값은 남는 폭 안에서 '외 N종'으로 줄인다.
 */
export function fitMetrics(metrics: readonly MetricText[], widthPx: number, measure: Measure, wording: ItemsWording = KO_ITEMS_WORDING): MetricsFit {
  const render = (list: readonly MetricText[]) => list.map((m) => (m.label ? m.label + ' ' : '') + m.value).join(PART_JOINER);
  const attempt = (list: MetricText[], folded: boolean): MetricsFit | null => {
    const itemsIndex = list.findIndex((m) => m.items && m.items.length > 0);
    if (within(render(list), widthPx, measure)) return { text: render(list), fits: true, shown: list.map((m) => m.key), folded };
    if (itemsIndex >= 0) {
      const target = list[itemsIndex]!;
      const rest = list.filter((_, i) => i !== itemsIndex);
      const restText = render(rest);
      const room = widthPx - measure((restText ? restText + PART_JOINER : '') + target.label + ' ');
      const fitted = fitItems(target.items ?? [], room, measure, wording);
      if (fitted.fits) {
        const next = list.map((m, i) => (i === itemsIndex ? { ...m, value: fitted.text } : m));
        return { text: render(next), fits: true, shown: next.map((m) => m.key), folded };
      }
    }
    return null;
  };

  let list = [...metrics];
  let folded = false;
  const first = attempt(list, folded);
  if (first) return first;
  // 합치기: 이웃한 합칠 수 있는 숫자 둘.
  for (let i = 0; i + 1 < list.length; i += 1) {
    const a = list[i]!;
    const b = list[i + 1]!;
    if (a.foldable && b.foldable && !a.items && !b.items) {
      list = [...list.slice(0, i), { key: a.key + '+' + b.key, label: a.label + '/' + b.label, value: a.value + '/' + b.value, priority: Math.max(a.priority, b.priority), foldable: false }, ...list.slice(i + 2)];
      folded = true;
      const hit = attempt(list, folded);
      if (hit) return hit;
    }
  }
  // 우선순위 낮은 숫자부터 뺀다(적어도 하나는 남긴다).
  while (list.length > 1) {
    let victim = 0;
    list.forEach((m, i) => { if (m.priority < (list[victim]?.priority ?? 0)) victim = i; });
    list = list.filter((_, i) => i !== victim);
    const hit = attempt(list, folded);
    if (hit) return hit;
  }
  const text = render(list);
  return { text, fits: within(text, widthPx, measure), shown: list.map((m) => m.key), folded };
}
