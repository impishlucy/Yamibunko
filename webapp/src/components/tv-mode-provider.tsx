"use client"

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react"

import {
  detectClientDevice,
  type DeviceDetection,
} from "@/lib/device"

type TvModeContextValue = DeviceDetection

const defaultDevice: DeviceDetection = {
  kind: "desktop",
  isTv: false,
  isGameConsole: false,
  isTvLike: false,
}

const TvModeContext = createContext<TvModeContextValue>(defaultDevice)

function applyTvModeDataset(device: DeviceDetection) {
  if (typeof document === "undefined") {
    return
  }

  document.documentElement.dataset.yamiDevice = device.kind
  document.documentElement.dataset.yamiTv = device.isTvLike ? "true" : "false"
  document.documentElement.dataset.yamiConsole = device.isGameConsole ? "true" : "false"
}

export function TvModeProvider({
  children,
  initialDevice,
}: {
  children: ReactNode
  initialDevice: DeviceDetection
}) {
  const [device, setDevice] = useState(initialDevice)

  useEffect(() => {
    const detected = detectClientDevice(initialDevice)
    applyTvModeDataset(detected)

    const timer = window.setTimeout(() => {
      setDevice(detected)
    }, 0)

    return () => {
      window.clearTimeout(timer)
    }
  }, [initialDevice])

  useEffect(() => {
    applyTvModeDataset(device)
  }, [device])

  const value = useMemo(() => device, [device])

  return <TvModeContext.Provider value={value}>{children}</TvModeContext.Provider>
}

export function useTvMode() {
  return useContext(TvModeContext)
}
