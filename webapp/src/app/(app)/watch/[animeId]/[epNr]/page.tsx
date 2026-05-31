import { WatchView } from "@/components/watch-view"

type WatchPageProps = {
  params: Promise<{
    animeId: string
    epNr: string
  }>
}

export default async function WatchPage({ params }: WatchPageProps) {
  const { animeId, epNr } = await params

  return <WatchView animeId={animeId} epNr={epNr} />
}
