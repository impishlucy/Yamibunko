type LibraryFamilyDisplayRule = {
  displayTitle: string
  exactTerms?: string[]
  prefixTerms?: string[]
  suffixTerms?: string[]
  containsTerms?: string[]
}

const libraryFamilyDisplayRules: LibraryFamilyDisplayRule[] = [
  {
    displayTitle: "Fate",
    exactTerms: ["fate"],
  },
  {
    displayTitle: "Monogatari",
    suffixTerms: ["monogatari"],
  },
]

function normalizeFamilyTitle(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
}

function normalizeTerms(values: string[] | undefined) {
  return values?.map(normalizeFamilyTitle).filter(Boolean) ?? []
}

function wordsForTitle(value: string) {
  return normalizeFamilyTitle(value).split(" ").filter(Boolean)
}

function ruleMatchesTitle(rule: LibraryFamilyDisplayRule, title: string) {
  const normalized = normalizeFamilyTitle(title)
  const words = wordsForTitle(title)

  if (!normalized || words.length === 0) {
    return false
  }

  for (const term of normalizeTerms(rule.exactTerms)) {
    if (normalized === term || words.includes(term)) {
      return true
    }
  }

  for (const term of normalizeTerms(rule.prefixTerms)) {
    if (words.some((word) => word === term || word.startsWith(term))) {
      return true
    }
  }

  for (const term of normalizeTerms(rule.suffixTerms)) {
    if (words.some((word) => word === term || word.endsWith(term))) {
      return true
    }
  }

  for (const term of normalizeTerms(rule.containsTerms)) {
    if (normalized.includes(term)) {
      return true
    }
  }

  return false
}

export function resolveLibraryFamilyDisplayTitle(
  fallbackTitle: string,
  titles: Iterable<string | null | undefined>
) {
  const normalizedTitles = [...titles]
    .map((title) => title?.trim())
    .filter((title): title is string => Boolean(title))

  for (const rule of libraryFamilyDisplayRules) {
    if (normalizedTitles.some((title) => ruleMatchesTitle(rule, title))) {
      return rule.displayTitle
    }
  }

  return fallbackTitle
}
