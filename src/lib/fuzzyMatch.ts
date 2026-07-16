export function fuzzyMatchOptions(
  options: readonly string[],
  query: string,
  limit: number
): readonly string[] {
  const normalizedQuery: string = normalizeFuzzyText(query)
  const uniqueOptions: string[] = [...new Set(options)]
  if (!normalizedQuery) return uniqueOptions.slice(0, limit)

  return uniqueOptions
    .map((option: string): { option: string; score: number | null } => ({
      option,
      score: fuzzyScore(option, normalizedQuery)
    }))
    .filter(
      (match: {
        option: string
        score: number | null
      }): match is { option: string; score: number } => match.score !== null
    )
    .sort(
      (left: { option: string; score: number }, right: { option: string; score: number }): number =>
        right.score - left.score || left.option.localeCompare(right.option)
    )
    .slice(0, limit)
    .map((match: { option: string; score: number }): string => match.option)
}

function fuzzyScore(option: string, normalizedQuery: string): number | null {
  const candidate: string = normalizeFuzzyText(option)
  if (candidate === normalizedQuery) return 10_000

  const substringIndex: number = candidate.indexOf(normalizedQuery)
  if (substringIndex >= 0) return 5_000 - substringIndex * 5 - candidate.length

  let candidateIndex = 0
  let firstMatch = -1
  let previousMatch = -1
  let gapPenalty = 0
  for (const character of normalizedQuery) {
    const matchIndex: number = candidate.indexOf(character, candidateIndex)
    if (matchIndex < 0) return null
    if (firstMatch < 0) firstMatch = matchIndex
    if (previousMatch >= 0) gapPenalty += matchIndex - previousMatch - 1
    previousMatch = matchIndex
    candidateIndex = matchIndex + 1
  }
  return 1_000 - firstMatch * 4 - gapPenalty * 3 - candidate.length
}

function normalizeFuzzyText(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s_-]+/g, '')
}
