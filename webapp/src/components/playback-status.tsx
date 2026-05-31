import { Badge } from "@/components/ui/badge"

export type PlaybackStatusState =
  | "checking"
  | "direct"
  | "transcoding"
  | "waiting"
  | "blocked"

const labels: Record<PlaybackStatusState, string> = {
  checking: "Checking playback",
  direct: "Direct play",
  transcoding: "Transcoding",
  waiting: "Waiting for transcoding resources...",
  blocked: "Transcoding not possible right now.",
}

export function PlaybackStatus({ state }: { state: PlaybackStatusState }) {
  const variant = state === "blocked" ? "destructive" : "outline"

  return (
    <Badge
      variant={variant}
      className="border-violet-400/30 bg-zinc-950/70 text-zinc-200"
    >
      {labels[state]}
    </Badge>
  )
}
