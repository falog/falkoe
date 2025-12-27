// Greedy tokenization of an IPA string using known symbols.
// Longest-match wins (e.g. "tʃ" before "t").

export function tokenizeIpa(ipa: string, knownSymbols: string[]): string[] {
  if (!ipa) return [];

  // Sort by length descending to prefer multi-char tokens.
  const symbols = [...knownSymbols].sort((a, b) => b.length - a.length);

  const out: string[] = [];
  let i = 0;

  while (i < ipa.length) {
    let matched: string | null = null;

    for (const sym of symbols) {
      if (!sym) continue;
      if (ipa.startsWith(sym, i)) {
        matched = sym;
        break;
      }
    }

    if (matched) {
      out.push(matched);
      i += matched.length;
      continue;
    }

    // fallback: single code unit
    out.push(ipa[i]);
    i += 1;
  }

  return out;
}
