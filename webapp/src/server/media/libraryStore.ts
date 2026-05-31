import type { AnimeInfo, AnimeSummary, Episode } from "@/lib/types"

const anime: AnimeInfo[] = [
  {
    id: "violet-archive",
    title: "Violet Archive",
    coverImage:
      "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21827-10F6m50H4GJK.jpg",
    bannerImage:
      "https://s4.anilist.co/file/anilistcdn/media/anime/banner/21827-aQF7WzUaZr9q.jpg",
    episodeCount: 4,
    year: 2018,
    genres: ["Drama", "Slice of Life"],
    description:
      "A restored library catalog entry with letters, quiet city nights, and careful memories.",
  },
  {
    id: "starlit-rail",
    title: "Starlit Rail",
    coverImage:
      "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx97986-8oxwTF84hzue.jpg",
    bannerImage:
      "https://s4.anilist.co/file/anilistcdn/media/anime/banner/97986-WLOzMWZkzldd.jpg",
    episodeCount: 3,
    year: 2023,
    genres: ["Fantasy", "Adventure"],
    description:
      "A small collection of episodes following a winter rail line between mountain towns.",
  },
]

const episodes: Episode[] = [
  {
    animeId: "violet-archive",
    episodeNumber: 1,
    title: "The First Letter",
    fileName: "Violet Archive - 01.mkv",
    mediaId: "violet-archive-01.mkv",
    thumbnail:
      "https://s4.anilist.co/file/anilistcdn/media/anime/banner/21827-aQF7WzUaZr9q.jpg",
    durationSeconds: 1422,
  },
  {
    animeId: "violet-archive",
    episodeNumber: 2,
    title: "Ink Under Glass",
    fileName: "Violet Archive - 02.mkv",
    mediaId: "violet-archive-02.mkv",
    thumbnail:
      "https://s4.anilist.co/file/anilistcdn/media/anime/banner/21827-aQF7WzUaZr9q.jpg",
    durationSeconds: 1418,
  },
  {
    animeId: "violet-archive",
    episodeNumber: 3,
    title: "Blue Window",
    fileName: "Violet Archive - 03.mkv",
    mediaId: "violet-archive-03.mkv",
    thumbnail:
      "https://s4.anilist.co/file/anilistcdn/media/anime/banner/21827-aQF7WzUaZr9q.jpg",
    durationSeconds: 1430,
  },
  {
    animeId: "violet-archive",
    episodeNumber: 4,
    title: "Archive Lamp",
    fileName: "Violet Archive - 04.mkv",
    mediaId: "violet-archive-04.mkv",
    thumbnail:
      "https://s4.anilist.co/file/anilistcdn/media/anime/banner/21827-aQF7WzUaZr9q.jpg",
    durationSeconds: 1419,
  },
  {
    animeId: "starlit-rail",
    episodeNumber: 1,
    title: "Snow at Platform Six",
    fileName: "Starlit Rail - 01.mkv",
    mediaId: "starlit-rail-01.mkv",
    thumbnail:
      "https://s4.anilist.co/file/anilistcdn/media/anime/banner/97986-WLOzMWZkzldd.jpg",
    durationSeconds: 1501,
  },
  {
    animeId: "starlit-rail",
    episodeNumber: 2,
    title: "Lantern Timetable",
    fileName: "Starlit Rail - 02.mkv",
    mediaId: "starlit-rail-02.mkv",
    thumbnail:
      "https://s4.anilist.co/file/anilistcdn/media/anime/banner/97986-WLOzMWZkzldd.jpg",
    durationSeconds: 1498,
  },
  {
    animeId: "starlit-rail",
    episodeNumber: 3,
    title: "Aurora Switchyard",
    fileName: "Starlit Rail - 03.mkv",
    mediaId: "starlit-rail-03.mkv",
    thumbnail:
      "https://s4.anilist.co/file/anilistcdn/media/anime/banner/97986-WLOzMWZkzldd.jpg",
    durationSeconds: 1505,
  },
]

export function getLibrary(): AnimeSummary[] {
  return anime.map(
    ({ id, title, coverImage, bannerImage, episodeCount, year }) => ({
      id,
      title,
      coverImage,
      bannerImage,
      episodeCount,
      year,
    })
  )
}

export function getAnimeInfo(animeId: string) {
  return anime.find((item) => item.id === animeId) ?? null
}

export function getEpisodes(animeId: string) {
  return episodes.filter((episode) => episode.animeId === animeId)
}

export function getEpisode(animeId: string, epNr: string | number) {
  const episodeNumber =
    typeof epNr === "number" ? epNr : Number.parseInt(epNr, 10)

  if (!Number.isInteger(episodeNumber) || episodeNumber < 1) {
    return null
  }

  return (
    episodes.find(
      (episode) =>
        episode.animeId === animeId && episode.episodeNumber === episodeNumber
    ) ?? null
  )
}
