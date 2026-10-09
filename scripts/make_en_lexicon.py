"""Write app/models/en-lexicon.json: English word -> IPA, so Kokoro can speak English offline.

Words: the most frequent English dictionary words in the OPUS-MT Tagalog->English vocabulary
(what the translator can output), plus contractions and the built-in signs' English.
IPA comes from espeak-ng (en-us) at build time; espeak-ng itself is not shipped.
Run: python3 scripts/make_en_lexicon.py
"""
import json
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VOCAB = ROOT / ".vendor-tmp/tfjs/models/Helsinki-NLP/opus-mt-tl-en/vocab.json"
OUT = ROOT / "app/models/en-lexicon.json"
LIMIT = 10000

EXTRA = """i'm you're we're they're he's she's it's that's what's there's here's let's
don't doesn't didn't can't won't isn't aren't wasn't weren't couldn't wouldn't shouldn't haven't hasn't
i'll you'll we'll i've you've we've i'd you'd
yes no hello hi bye goodbye thanks thank you water food help pain sick hurt hurts bathroom toilet
wait correct wrong right good morning afternoon evening night welcome understand please sorry
how are am is okay hungry thirsty""".split()

dictionary = {w.strip().lower() for w in open("/usr/share/dict/words")}
words, seen = [], set()
for piece in json.load(open(VOCAB)):
    w = piece[1:].lower()
    if piece.startswith("\u2581") and w.isascii() and w.isalpha() and w in dictionary and w not in seen:
        if len(w) > 1 or w in ("a", "i"):
            seen.add(w)
            words.append(w)
    if len(words) >= LIMIT:
        break
words += [w for w in EXTRA if w not in seen]


def ipa(word):
    out = subprocess.run(["espeak-ng", "-q", "--ipa", "-v", "en-us", word], capture_output=True, text=True)
    return word, out.stdout.strip().replace("\n", " ")


# espeak reads a lone "a" as the letter name and stresses lone function words.
REDUCED = {"a": "ɐ", "the": "ðə", "an": "ən", "to": "tə", "of": "ʌv", "and": "ænd", "for": "fɚ",
           "or": "ɔːɹ", "at": "æt", "as": "æz", "from": "fɹʌm", "but": "bʌt", "than": "ðæn"}

with ThreadPoolExecutor(16) as pool:
    lexicon = {w: p for w, p in pool.map(ipa, words) if p}
lexicon.update(REDUCED)
OUT.write_text(json.dumps(lexicon, ensure_ascii=False, separators=(",", ":")))
print(f"   {len(lexicon)} words -> {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1e3:.0f} kB)")
