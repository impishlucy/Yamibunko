"use client"

import type { ReactNode } from "react"
import { useCallback, useEffect, useId, useRef, useState } from "react"

import { cn } from "@/lib/utils"

const CLICK_VISIBLE_MS = 5000

type HoverHintProps = {
  label: ReactNode
  children: ReactNode
  className?: string
  contentClassName?: string
  side?: "top" | "bottom"
  align?: "start" | "center" | "end"
  clickVisibleMs?: number | null
}

const sideClassNames = {
  top: "bottom-full mb-2",
  bottom: "top-full mt-2",
}

const alignClassNames = {
  start: "left-0",
  center: "left-1/2 -translate-x-1/2",
  end: "right-0",
}

export function HoverHint({
  label,
  children,
  className,
  contentClassName,
  side = "top",
  align = "center",
  clickVisibleMs = CLICK_VISIBLE_MS,
}: HoverHintProps) {
  const id = useId()
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const timerRef = useRef<number | null>(null)
  const [open, setOpen] = useState(false)
  const [stickyOpen, setStickyOpen] = useState(false)

  const clearTimer = useCallback(() => {
    if (timerRef.current === null) {
      return
    }

    window.clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  const close = useCallback(() => {
    clearTimer()
    setStickyOpen(false)
    setOpen(false)
  }, [clearTimer])

  const showForClick = useCallback(() => {
    clearTimer()
    setStickyOpen(true)
    setOpen(true)

    if (clickVisibleMs === null) {
      return
    }

    timerRef.current = window.setTimeout(() => {
      setStickyOpen(false)
      setOpen(false)
      timerRef.current = null
    }, clickVisibleMs)
  }, [clearTimer, clickVisibleMs])

  useEffect(() => {
    if (!open) {
      return
    }

    function onPointerDown(event: PointerEvent) {
      const target = event.target

      if (target instanceof Node && rootRef.current?.contains(target)) {
        return
      }

      close()
    }

    document.addEventListener("pointerdown", onPointerDown)

    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
    }
  }, [close, open])

  useEffect(() => clearTimer, [clearTimer])

  return (
    <span
      ref={rootRef}
      className={cn("relative inline-flex", className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        if (!stickyOpen) {
          setOpen(false)
        }
      }}
      onPointerDownCapture={showForClick}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={(event) => {
        if (
          !stickyOpen &&
          event.relatedTarget instanceof Node &&
          rootRef.current?.contains(event.relatedTarget)
        ) {
          return
        }

        if (!stickyOpen) {
          setOpen(false)
        }
      }}
      onClick={(event) => {
        if (event.detail === 0) {
          showForClick()
        }
      }}
      aria-describedby={open ? id : undefined}
    >
      {children}
      {open ? (
        <span
          id={id}
          role="tooltip"
          className={cn(
            "pointer-events-none absolute z-[80] max-w-[min(18rem,calc(100vw-2rem))] rounded-md border border-white/10 bg-black/95 px-2 py-1 text-xs leading-relaxed whitespace-nowrap text-zinc-200 shadow-xl",
            sideClassNames[side],
            alignClassNames[align],
            contentClassName
          )}
        >
          {label}
        </span>
      ) : null}
    </span>
  )
}
