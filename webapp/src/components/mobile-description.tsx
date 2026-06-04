"use client"

import { useState } from "react"

type MobileDescriptionProps = {
  text: string
}

export function MobileDescription({ text }: MobileDescriptionProps) {
  const [expanded, setExpanded] = useState(false)

  if (text.length <= 200 || expanded) {
    return <p className="text-sm leading-5 text-zinc-300 sm:hidden">{text}</p>
  }

  return (
    <p className="text-sm leading-5 text-zinc-300 sm:hidden">
      {text.slice(0, 150).trimEnd()}
      <button
        type="button"
        className="ml-1 font-medium text-violet-200 underline-offset-4 hover:text-violet-100 hover:underline"
        onClick={() => setExpanded(true)}
      >
        ... more
      </button>
    </p>
  )
}
