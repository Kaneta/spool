// search.ts — Search overlay の matching core (UI-DESIGN.md §5)。
// pure function。UI / IndexedDB は触らない。NFKC + toLowerCase + whitespace AND のみ。

export function normalizeText(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/** query を normalize → whitespace で token split → 空token除去。 */
export function queryTokens(query: string): string[] {
  return normalizeText(query).split(/\s+/).filter((t) => t.length > 0);
}

/** normalize(name + "\n" + text) に全 token が substring として含まれれば match (AND)。ranking なし。 */
export function recordMatches(query: string, record: { name: string; text: string }): boolean {
  const haystack = normalizeText(`${record.name}\n${record.text}`);
  return queryTokens(query).every((token) => haystack.includes(token));
}

export type SearchResult = { name: string; text: string };

/** records (既存 chronological昇順) を既存順序のまま filter する。ranking は追加しない。 */
export function searchRecords<T extends SearchResult>(query: string, records: T[]): T[] {
  return records.filter((r) => recordMatches(query, r));
}
