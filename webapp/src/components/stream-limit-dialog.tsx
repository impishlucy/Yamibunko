"use client"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type StreamLimitDialogProps = {
  open: boolean
  onConfirm: () => void
  onCancel?: () => void
  onDismiss?: () => void
  confirmLabel?: string
  cancelLabel?: string
  loading?: boolean
  dismissible?: boolean
}

export function StreamLimitDialog({
  open,
  onConfirm,
  onCancel,
  onDismiss,
  confirmLabel = "Yes",
  cancelLabel,
  loading = false,
  dismissible = true,
}: StreamLimitDialogProps) {
  if (!open) {
    return null
  }

  return (
    <div
      className="fixed inset-0 z-[120] grid place-items-center bg-black/70 p-4 backdrop-blur-sm"
      role="presentation"
      onPointerDown={(event) => {
        if (!dismissible || event.target !== event.currentTarget) {
          return
        }

        onDismiss?.()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="stream-limit-title"
        className="w-full max-w-sm rounded-xl border border-white/10 bg-zinc-950 p-5 text-zinc-100 shadow-2xl"
      >
        <h2 id="stream-limit-title" className="text-base font-semibold">
          Only 1 active Stream allowed at a time
        </h2>
        <p className="mt-2 text-sm leading-6 text-zinc-400">
          Want to close the other stream and watch this instead ?
        </p>
        <div
          className={cn(
            "mt-5 flex gap-2",
            cancelLabel ? "justify-end" : "justify-start"
          )}
        >
          {cancelLabel ? (
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
              disabled={loading}
            >
              {cancelLabel}
            </Button>
          ) : null}
          <Button type="button" onClick={onConfirm} disabled={loading}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
