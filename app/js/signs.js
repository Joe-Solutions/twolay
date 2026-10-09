// The 12 demo signs, the team's own added words, and the Filipino / Taglish words that map speech to them.

export const UNKNOWN_TEXT = 'hindi kita';

const BUILTIN = [
  { label: 'oo',       text: 'Oo',       en: 'yes' },
  { label: 'hindi',    text: 'Hindi',    en: 'no' },
  { label: 'kumusta',  text: 'Kumusta',  en: 'hello / how are you' },
  { label: 'tubig',    text: 'Tubig',    en: 'water' },
  { label: 'pagkain',  text: 'Pagkain',  en: 'food' },
  { label: 'tulong',   text: 'Tulong',   en: 'help' },
  { label: 'sakit',    text: 'Sakit',    en: 'pain / sick' },
  { label: 'banyo',    text: 'Banyo',    en: 'bathroom' },
  { label: 'salamat',  text: 'Salamat',  en: 'thank you' },
  { label: 'sandali',  text: 'Sandali',  en: 'wait' },
  { label: 'tama',     text: 'Tama',     en: 'correct' },
  { label: 'mali',     text: 'Mali',     en: 'wrong' },
];

// SIGNS and LABELS are live: added words are appended in place, so importers see them.
export const SIGNS = [...BUILTIN];
export const LABELS = SIGNS.map((s) => s.label);
const BUILTIN_LABELS = new Set(LABELS);
const WORDS_KEY = 'twolay.words';
/** normalized spoken form -> label, for added words (exact match only) */
const CUSTOM = new Map();

export const isCustom = (label) => !BUILTIN_LABELS.has(label);
export const customWords = () => SIGNS.filter((s) => isCustom(s.label)).map((s) => s.text);
export const labelFor = (text) => normalize(text).replace(/ /g, '-');

function applyWords(words) {
  SIGNS.splice(BUILTIN.length);
  CUSTOM.clear();
  for (const text of words) {
    const label = labelFor(text);
    if (!label || BUILTIN_LABELS.has(label) || CUSTOM.has(normalize(text))) continue;
    SIGNS.push({ label, text, en: '' });
    CUSTOM.set(normalize(text), label);
  }
  LABELS.splice(0, LABELS.length, ...SIGNS.map((s) => s.label));
}

function loadWords() {
  try {
    applyWords(JSON.parse(localStorage.getItem(WORDS_KEY) || '[]'));
  } catch {
    applyWords([]);
  }
}

/** Replace the added words (e.g. with the Kamay phone's list). Returns true if anything changed. */
export function setCustomWords(words) {
  const before = JSON.stringify(customWords());
  applyWords(words.map((w) => String(w).trim()).filter(Boolean).slice(0, 100));
  localStorage.setItem(WORDS_KEY, JSON.stringify(customWords()));
  return JSON.stringify(customWords()) !== before;
}

/** Add a word as a new sign. Returns its label; throws with a Filipino message if it can't. */
export function addWord(text) {
  text = text.trim().replace(/\s+/g, ' ');
  const label = labelFor(text);
  if (!label) throw new Error('Walang salita');
  if (label.length > 40) throw new Error('Masyadong mahaba');
  if (BUILTIN_LABELS.has(label)) throw new Error(`Nasa listahan na ang "${signText(label)}"`);
  if (LABELS.includes(label)) throw new Error(`Naidagdag mo na ang "${signText(label)}"`);
  setCustomWords([...customWords(), text]);
  return label;
}

export function removeWord(label) {
  if (!isCustom(label)) return;
  setCustomWords(SIGNS.filter((s) => isCustom(s.label) && s.label !== label).map((s) => s.text));
}

loadWords();
window.addEventListener?.('storage', (e) => e.key === WORDS_KEY && loadWords());

export const signText = (label) => SIGNS.find((s) => s.label === label)?.text ?? label;

// Single words. Words of 5+ letters also match with one typo (Whisper tiny misspells Tagalog).
const WORDS = {
  oo: ['oo', 'opo', 'oho', 'o o', 'yes', 'yeah', 'sige', 'okay', 'ok', 'oks'],
  hindi: ['hindi', 'hinde', 'di', 'no', 'ayaw', 'ayoko', 'hinding'],
  kumusta: ['kumusta', 'kamusta', 'musta', 'kumustaka', 'hello', 'helo', 'hi'],
  tubig: ['tubig', 'water', 'inom', 'uminom', 'iinom', 'inumin', 'uhaw', 'nauuhaw'],
  pagkain: ['pagkain', 'kain', 'kumain', 'kakain', 'gutom', 'nagugutom', 'food', 'eat', 'ulam', 'kanin'],
  tulong: ['tulong', 'tulungan', 'tumulong', 'tutulong', 'help', 'saklolo'],
  sakit: ['sakit', 'masakit', 'sumasakit', 'nasaktan', 'pain', 'hurt', 'hurts', 'sick', 'ouch', 'aray'],
  banyo: ['banyo', 'cr', 'toilet', 'bathroom', 'restroom', 'kubeta', 'palikuran', 'iihi', 'ihi', 'jingle'],
  salamat: ['salamat', 'thanks', 'thank'],
  sandali: ['sandali', 'saglit', 'teka', 'wait', 'hintay', 'hintayin', 'antay', 'sandaling'],
  tama: ['tama', 'correct', 'right', 'tumpak', 'totoo'],
  mali: ['mali', 'wrong', 'mistake', 'mali-mali'],
};

// Multi-word phrases checked before single words.
const PHRASES = [
  ['comfort room', 'banyo'], ['c r', 'banyo'], ['thank you', 'salamat'], ['how are you', 'kumusta'],
  ['wait lang', 'sandali'], ['teka lang', 'sandali'], ['may sakit', 'sakit'], ['not yet', 'hindi'],
];

const WORD_TO_LABEL = new Map();
for (const [label, words] of Object.entries(WORDS)) for (const w of words) WORD_TO_LABEL.set(w, label);

export function normalize(text) {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')   // Whisper tags like [Music]
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function editDistance(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

function wordLabel(word) {
  if (CUSTOM.has(word)) return CUSTOM.get(word);
  if (WORD_TO_LABEL.has(word)) return WORD_TO_LABEL.get(word);
  if (word.length < 5) return null;
  for (const [w, label] of WORD_TO_LABEL) {
    if (w.length >= 5 && Math.abs(w.length - word.length) <= 1 && editDistance(w, word) <= 1) return label;
  }
  return null;
}

/** Text -> ordered, de-duplicated sign labels (max 3). "Ano ang sakit?" -> ['sakit'] */
export function textToSigns(text, max = 3) {
  const norm = ` ${normalize(text)} `;
  const hits = [];
  const customPhrases = [...CUSTOM].filter(([phrase]) => phrase.includes(' '));
  for (const [phrase, label] of [...customPhrases, ...PHRASES]) {
    const at = norm.indexOf(` ${phrase} `);
    if (at >= 0) hits.push({ at, label });
  }
  let pos = 0;
  for (const word of norm.trim().split(' ')) {
    const at = norm.indexOf(` ${word} `, pos);
    pos = at + 1;
    const label = word && wordLabel(word);
    if (label) hits.push({ at, label });
  }
  hits.sort((a, b) => a.at - b.at);
  return [...new Set(hits.map((h) => h.label))].slice(0, max);
}
