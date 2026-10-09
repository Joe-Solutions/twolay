// English spelling -> IPA for Kokoro, from ~10k words pre-phonemized with espeak-ng
// (scripts/make_en_lexicon.py). English spelling has no reliable letter rules, so unknown
// words are reported as missing; the caller decides whether a rough guess is acceptable.
import { tagalogToIPA } from './tl-g2p.js';

/** Returns { ipa, missing: [words not in the lexicon] }. */
export function englishToIPA(text, lexicon) {
  const missing = [];
  const out = [];
  const tokens = text.replace(/[’‘]/g, "'").toLowerCase().match(/[a-z]+(?:'[a-z]+)?|[.,!?;:]/g) ?? [];
  for (const tok of tokens) {
    if (/^[.,!?;:]$/.test(tok)) {
      if (out.length) out[out.length - 1] += tok;
      continue;
    }
    const possessive = tok.endsWith("'s") && lexicon[tok.slice(0, -2)];
    const ipa = lexicon[tok] ?? (possessive ? `${possessive}z` : null);
    if (ipa) out.push(ipa);
    else {
      missing.push(tok);
      out.push(tagalogToIPA(tok));
    }
  }
  return { ipa: out.join(' '), missing };
}
