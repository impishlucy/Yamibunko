"use client"

import { useEffect, useRef, useState } from "react"
import {
  ChevronDown,
  Star,
  StarOff,
  Trash2,
  User,
  UserCog,
  UserStar,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { HoverHint } from "@/components/ui/hover-hint"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { apiGet } from "@/lib/api"

const MAX_VISIBLE_USERNAME_LENGTH = 15

type UserListItem = {
  username: string
  isAdmin: boolean
  isVip: boolean
  hasPassword: boolean
  createdAt: string
}

type MeResponse = {
  user: {
    username: string
    isAdmin: boolean
    isVip: boolean
  } | null
}

type UsersResponse = {
  users: UserListItem[]
}

function getCompactUsername(username: string) {
  if (username.length <= MAX_VISIBLE_USERNAME_LENGTH) {
    return username
  }

  return `${username.slice(0, MAX_VISIBLE_USERNAME_LENGTH)}...`
}

function UserStatusIcon({ user }: { user: UserListItem }) {
  if (user.isAdmin) {
    return (
      <HoverHint label="Admin">
        <span aria-label="Admin" role="img">
          <UserStar
            className="size-4 shrink-0 text-amber-300"
            aria-hidden="true"
          />
        </span>
      </HoverHint>
    )
  }

  if (!user.hasPassword) {
    return (
      <HoverHint label="User">
        <span aria-label="User" role="img">
          <UserCog
            className="size-4 shrink-0 text-orange-300"
            aria-hidden="true"
          />
        </span>
      </HoverHint>
    )
  }

  return (
    <HoverHint label="User">
      <span aria-label="User" role="img">
        <User className="size-4 shrink-0 text-violet-300" aria-hidden="true" />
      </span>
    </HoverHint>
  )
}

function UserVipIcon({ user }: { user: UserListItem }) {
  return user.isVip ? (
    <Star className="size-4" aria-hidden="true" />
  ) : (
    <StarOff className="size-4" aria-hidden="true" />
  )
}

export function UserManagement() {
  const [me, setMe] = useState<MeResponse["user"]>(null)
  const [users, setUsers] = useState<UserListItem[]>([])
  const [username, setUsername] = useState("")
  const [usersOpen, setUsersOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const usersDropdownRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false

    apiGet<MeResponse>("/api/auth/me")
      .then(async (meResponse) => {
        if (cancelled) {
          return
        }

        setMe(meResponse.user)

        if (!meResponse.user?.isAdmin) {
          return
        }

        const usersResponse = await apiGet<UsersResponse>("/api/auth/users")

        if (!cancelled) {
          setUsers(usersResponse.users)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError("User management unavailable")
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!usersOpen) {
      return
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target

      if (
        target instanceof Node &&
        usersDropdownRef.current?.contains(target)
      ) {
        return
      }

      setUsersOpen(false)
    }

    document.addEventListener("pointerdown", handlePointerDown)

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown)
    }
  }, [usersOpen])

  async function createUser() {
    setError(null)

    const response = await fetch("/api/auth/users", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        username,
      }),
    })

    if (!response.ok) {
      setError("Unable to create user")
      return
    }

    const payload = (await response.json()) as { users: UserListItem[] }
    setUsers(payload.users)
    setUsername("")
  }

  async function deleteUser(user: UserListItem) {
    if (user.isAdmin) {
      return
    }

    const confirmed = window.confirm(`Delete user "${user.username}"?`)

    if (!confirmed) {
      return
    }

    setError(null)

    const response = await fetch("/api/auth/users", {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        username: user.username,
      }),
    })

    if (!response.ok) {
      setError("Unable to delete user")
      return
    }

    const payload = (await response.json()) as { users: UserListItem[] }
    setUsers(payload.users)
  }

  async function toggleVip(user: UserListItem) {
    setError(null)

    const response = await fetch("/api/auth/users", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        username: user.username,
        isVip: !user.isVip,
      }),
    })

    if (!response.ok) {
      setError("Unable to update VIP status")
      return
    }

    const payload = (await response.json()) as { users: UserListItem[] }
    setUsers(payload.users)
  }

  if (!me?.isAdmin) {
    return null
  }

  return (
    <Card className="overflow-visible rounded-lg border-white/10 bg-zinc-900/75">
      <CardHeader>
        <CardTitle className="text-zinc-100">Users</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 overflow-visible">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="new-username" className="text-zinc-400">
              Username
            </Label>
            <Input
              id="new-username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className="h-9 rounded-lg border-white/10 bg-zinc-950/70 text-zinc-100"
            />
          </div>
          <Button
            type="button"
            onClick={createUser}
            disabled={username.trim().length < 3}
          >
            Create
          </Button>
        </div>

        {error ? <p className="text-sm text-red-300">{error}</p> : null}

        <div className="flex flex-wrap items-center gap-3 overflow-visible">
          <h3 className="text-sm font-medium text-zinc-200">Existing users</h3>
          <div ref={usersDropdownRef} className="relative w-80 max-w-full">
            <button
              type="button"
              onClick={() => setUsersOpen((open) => !open)}
              className="flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-white/10 bg-zinc-950/70 px-3 text-left text-sm text-zinc-100 outline-none transition hover:border-violet-300/40"
              aria-haspopup="listbox"
              aria-expanded={usersOpen}
            >
              <span>{users.length} users</span>
              <ChevronDown
                className={`size-4 shrink-0 text-zinc-500 transition ${
                  usersOpen ? "rotate-180" : ""
                }`}
              />
            </button>

            {usersOpen ? (
              <div
                role="listbox"
                className="mt-2 max-h-52 w-full overflow-y-auto rounded-lg border border-white/10 bg-zinc-950/95 p-1 shadow-2xl shadow-black/40 sm:absolute sm:left-0 sm:top-11 sm:mt-0 sm:max-h-[188px]"
              >
                {users.map((user) => (
                  <div
                    key={user.username}
                    className="flex h-9 items-center gap-2 rounded-md px-2 text-sm text-zinc-100 hover:bg-white/5"
                  >
                    <HoverHint
                      label={user.username}
                      className="min-w-0 flex-1 overflow-hidden"
                      align="start"
                    >
                      <span className="block truncate">
                        {getCompactUsername(user.username)}
                      </span>
                    </HoverHint>
                    <UserStatusIcon user={user} />
                    <HoverHint label={user.isVip ? "Remove VIP" : "Make VIP"}>
                      <button
                        type="button"
                        onClick={() => toggleVip(user)}
                        className={`rounded-md p-1 transition ${
                          user.isVip
                            ? "text-amber-300 hover:bg-amber-400/10 hover:text-amber-200"
                            : "text-violet-300 hover:bg-violet-400/10 hover:text-violet-200"
                        }`}
                        aria-label={user.isVip ? "Remove VIP" : "Make VIP"}
                      >
                        <UserVipIcon user={user} />
                      </button>
                    </HoverHint>
                    {!user.isAdmin ? (
                      <HoverHint label="Delete">
                        <button
                          type="button"
                          onClick={() => deleteUser(user)}
                          className="rounded-md p-1 text-red-300 transition hover:bg-red-400/10 hover:text-red-200"
                          aria-label="Delete"
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </HoverHint>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
