export const localNonAnimeIdBase = 8_000_000_000_000
export const localNonAnimeIdRange = 900_000_000_000

export function isLocalNonAnimeId(id: number) {
  return (
    Number.isInteger(id) &&
    id >= localNonAnimeIdBase &&
    id < localNonAnimeIdBase + localNonAnimeIdRange
  )
}
