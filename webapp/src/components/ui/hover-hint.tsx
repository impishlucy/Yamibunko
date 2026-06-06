"use client"

import type { ReactNode } from "react"
import { useCallback, useEffect, useId, useRef, useState } from "react"
import { createPortal } from "react-dom"

import { cn } from "@/lib/utils"

const CLICK_VISIBLE_MS = 5000
const HINT_GAP_PX = 8
const VIEWPORT_PADDING_PX = 8

type HoverHintProps = {
  label: ReactNode
  children: ReactNode
  className?: string
  contentClassName?: string
  side?: "top" | "bottom"
  align?: "start" | "center" | "end"
  clickVisibleMs?: number | null
}

type HintPosition = {
  left: number
  top: number
}

function clamp(value: number, min: number, max: number) {
  if (max < min) {
    return min
  }

  return Math.min(Math.max(value, min), max)
}

function getAlignedLeft(rect: DOMRect, width: number, align: HoverHintProps["align"]) {
  if (align === "start") {
    return rect.left
  }

  if (align === "end") {
    return rect.right - width
  }

  return rect.left + rect.width / 2 - width / 2
}

function getHintPosition(input: {
  root: HTMLElement
  content: HTMLElement
  side: NonNullable<HoverHintProps["side"]>
  align: NonNullable<HoverHintProps["align"]>
}): HintPosition {
  const rootRect = input.root.getBoundingClientRect()
  const contentRect = input.content.getBoundingClientRect()
  const maxLeft = window.innerWidth - contentRect.width - VIEWPORT_PADDING_PX
  const left = clamp(
    getAlignedLeft(rootRect, contentRect.width, input.align),
    VIEWPORT_PADDING_PX,
    maxLeft
  )

  const topPlacement = rootRect.top - contentRect.height - HINT_GAP_PX
  const bottomPlacement = rootRect.bottom + HINT_GAP_PX
  const preferredTop = input.side === "top" ? topPlacement : bottomPlacement
  const fallbackTop = input.side === "top" ? bottomPlacement : topPlacement
  const maxTop = window.innerHeight - contentRect.height - VIEWPORT_PADDING_PX
  const top =
    preferredTop >= VIEWPORT_PADDING_PX && preferredTop <= maxTop
      ? preferredTop
      : fallbackTop >= VIEWPORT_PADDING_PX && fallbackTop <= maxTop
        ? fallbackTop
        : clamp(preferredTop, VIEWPORT_PADDING_PX, maxTop)

  return { left, top }
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
  const contentRef = useRef<HTMLSpanElement | null>(null)
  const timerRef = useRef<number | null>(null)
  const [open, setOpen] = useState(false)
  const [stickyOpen, setStickyOpen] = useState(false)
  const [position, setPosition] = useState<HintPosition | null>(null)

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
    setPosition(null)
  }, [clearTimer])

  const openHint = useCallback(() => {
    setPosition(null)
    setOpen(true)
  }, [])

  const showForClick = useCallback(() => {
    clearTimer()
    setStickyOpen(true)
    openHint()

    if (clickVisibleMs === null) {
      return
    }

    timerRef.current = window.setTimeout(() => {
      setStickyOpen(false)
      setOpen(false)
      setPosition(null)
      timerRef.current = null
    }, clickVisibleMs)
  }, [clearTimer, clickVisibleMs, openHint])

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

  const updatePosition = useCallback(() => {
    const root = rootRef.current
    const content = contentRef.current

    if (!root || !content) {
      return
    }

    setPosition(getHintPosition({ root, content, side, align }))
  }, [align, side])

  useEffect(() => {
    if (!open) {
      return
    }

    const animationFrameId = window.requestAnimationFrame(updatePosition)

    return () => {
      window.cancelAnimationFrame(animationFrameId)
    }
  }, [open, updatePosition, label])

  useEffect(() => {
    if (!open) {
      return
    }

    let animationFrameId: number | null = null

    const scheduleUpdate = () => {
      if (animationFrameId !== null) {
        return
      }

      animationFrameId = window.requestAnimationFrame(() => {
        animationFrameId = null
        updatePosition()
      })
    }

    window.addEventListener("resize", scheduleUpdate)
    window.addEventListener("scroll", scheduleUpdate, true)

    return () => {
      window.removeEventListener("resize", scheduleUpdate)
      window.removeEventListener("scroll", scheduleUpdate, true)

      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId)
      }
    }
  }, [open, updatePosition])

  return (
    <span
      ref={rootRef}
      className={cn("relative inline-flex", className)}
      onMouseEnter={openHint}
      onMouseLeave={() => {
        if (!stickyOpen) {
          setOpen(false)
          setPosition(null)
        }
      }}
      onPointerDownCapture={showForClick}
      onFocusCapture={openHint}
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
          setPosition(null)
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
      {open
        ? createPortal(
            <span
              ref={contentRef}
              id={id}
              role="tooltip"
              className={cn(
                "pointer-events-none fixed z-[120] max-w-[min(22rem,calc(100vw-1rem))] rounded-md border border-white/10 bg-black/95 px-2 py-1 text-xs leading-relaxed whitespace-normal text-zinc-200 shadow-xl",
                position ? "visible" : "invisible",
                contentClassName
              )}
              style={{
                left: position?.left ?? 0,
                top: position?.top ?? 0,
              }}
            >
              {label}
            </span>,
            document.body
          )
        : null}
    </span>
  )
}
