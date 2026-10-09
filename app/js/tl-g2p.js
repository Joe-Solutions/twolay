// Tagalog / Taglish spelling -> IPA phonemes for Kokoro. Tagalog spelling is close to phonetic,
// so letter rules plus default penultimate stress are enough for short phrases.

const WORDS = { ng: 'naŋ', mga: 'maŋa' };
// Common words stressed on the last syllable (default is the second to last).
const FINAL_STRESS = new Set([
  'salamat', 'hindi', 'sakit', 'masakit', 'sandali', 'maintindihan', 'naiintindihan', 'intindihan', 'anuman',
  'ako', 'ikaw', 'siya', 'kami', 'tayo', 'kayo', 'sila', 'saan', 'doon', 'mahal', 'kanin', 'gabi', 'hapon',
  'dalawa', 'tatlo', 'lima', 'anim', 'ulit',
]);
// Short function words are spoken without stress.
const UNSTRESSED = new Set(['ang', 'ng', 'sa', 'si', 'ni', 'ko', 'mo', 'po', 'ba', 'na', 'ka', 'ay', 'at', 'kay', 'mga', 'din', 'rin', 'lang', 'nang', 'pa']);

const DIGRAPHS = [
  ['ng', 'ŋ'], ['ts', 'ʧ'], ['ch', 'ʧ'], ['sh', 'ʃ'], ['ph', 'f'], ['th', 't'],
];
// Only before a vowel ("dyip", "niyan" stays n-i-y).
const BEFORE_VOWEL = [['dy', 'ʤ'], ['ny', 'ɲ']];

const LETTERS = {
  a: 'a', e: 'ɛ', i: 'i', o: 'o', u: 'u',
  b: 'b', c: 'k', d: 'd', f: 'f', g: 'ɡ', h: 'h', j: 'ʤ', k: 'k', l: 'l', m: 'm', n: 'n', ñ: 'ɲ',
  p: 'p', q: 'k', r: 'ɾ', s: 's', t: 't', v: 'v', w: 'w', x: 'ks', y: 'j', z: 'z',
};
const VOWELS = new Set(['a', 'ɛ', 'i', 'o', 'u']);

function word(w) {
  if (WORDS[w]) return WORDS[w];
  const out = [];
  for (let i = 0; i < w.length; ) {
    const two = w.slice(i, i + 2);
    const di = DIGRAPHS.find(([g]) => g === two);
    if (di) { out.push(di[1]); i += 2; continue; }
    const bv = BEFORE_VOWEL.find(([g]) => g === two);
    if (bv && 'aeiou'.includes(w[i + 2] ?? '')) { out.push(bv[1]); i += 2; continue; }
    const ch = w[i];
    if (ch === 'c' && 'ei'.includes(w[i + 1] ?? '')) out.push('s');
    else if (LETTERS[ch]) out.push(LETTERS[ch]);
    else if (ch === '-') out.push('ʔ');
    i += 1;
  }
  const ipa = out.join('').replace(/([^aɛiou])\1/g, '$1');
  return UNSTRESSED.has(w) ? ipa : stress(ipa, FINAL_STRESS.has(w));
}

/** Tagalog stress: the penultimate vowel by default, the last one for `final` words. */
function stress(ipa, final = false) {
  const at = [...ipa].map((c, i) => (VOWELS.has(c) ? i : -1)).filter((i) => i >= 0);
  if (!at.length) return ipa;
  const i = final || at.length < 2 ? at[at.length - 1] : at[at.length - 2];
  const chars = [...ipa];
  chars.splice(i, 0, 'ˈ');
  return chars.join('');
}

export function tagalogToIPA(text) {
  const clean = text
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean
    .split(/([,.!?;:]+|\s+)/)
    .map((t) => (/^[a-zñ-]+$/.test(t) ? word(t) : /^\s+$/.test(t) ? ' ' : t.replace(/[^,.!?;:]/g, '')))
    .join('')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
}
