import { WatchView } from "@/components/watch-view"

type WatchPageProps = {
  params: Promise<{
    animeId: string
    epNr: string
  }>
  searchParams: Promise<{
    season?: string
  }>
}

export default async function WatchPage({
  params,
  searchParams,
}: WatchPageProps) {
  const { animeId, epNr } = await params
  const { season } = await searchParams

  return <WatchView animeId={animeId} epNr={epNr} seasonNr={season ?? "1"} />
}
