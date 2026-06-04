import { Heart, Info } from "lucide-react"
import { SiGithub } from "@icons-pack/react-simple-icons"

import { Card, CardContent } from "@/components/ui/card"
import { HoverHint } from "@/components/ui/hover-hint"

type SettingsAboutProps = {
  isAdmin: boolean
}

export function SettingsAbout({ isAdmin }: SettingsAboutProps) {
  return (
    <Card className="rounded-lg border-white/10 bg-zinc-900/75">
      <CardContent className="space-y-4 text-sm text-zinc-300">
        <p className="flex flex-wrap items-center gap-1.5">
          <span>Made with</span>
          <Heart className="size-4 fill-pink-400 text-pink-400" />
          <span>by</span>
          <a
            href="https://lucy.codes"
            target="_blank"
            rel="noreferrer"
            className="font-medium text-violet-200 underline-offset-4 hover:text-violet-100 hover:underline"
          >
            Lucy
          </a>
        </p>

        {isAdmin ? (
          <p className="flex flex-wrap items-center gap-1.5 text-zinc-400">
            <span>
              Thank you for using my app, if you find a bug or have a
              suggestion for the app let me know on my
            </span>
            <a
              href="https://github.com/impishlucy/Yamibunko/issues"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-medium text-violet-200 underline-offset-4 hover:text-violet-100 hover:underline"
            >
              <SiGithub className="size-4" />
              Github
            </a>
          </p>
        ) : (
          <div className="space-y-2 text-zinc-400">
            <p className="flex flex-wrap items-center gap-1.5">
              <span>
                If you find an app bug or have a suggestion, report it on
              </span>
              <a
                href="https://github.com/impishlucy/Yamibunko/issues"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-medium text-violet-200 underline-offset-4 hover:text-violet-100 hover:underline"
              >
                <SiGithub className="size-4" />
                Github
              </a>
              <span>
                . Only app bugs and app suggestions belong there. Missing
                episodes, missing anime, wrong file names, or library issues
                should be reported to your admin.
              </span>
            </p>
            <HoverHint
              label="Anime xyz is missing ep 12 -> Inform Admin / UI or Player is behaving weird -> Report to Github"
              className="max-w-full"
              align="start"
              contentClassName="whitespace-normal"
            >
              <p className="inline-flex items-center gap-1.5 text-xs text-zinc-500">
                <Info className="size-3.5" />
                Hover or tap for a quick reporting guide.
              </p>
            </HoverHint>
          </div>
        )}

        <p className="text-zinc-400">
          If you like to help make sure to let others know of this App :3
        </p>
      </CardContent>
    </Card>
  )
}
