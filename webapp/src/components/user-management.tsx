"use client"

import { useEffect, useRef, useState } from "react"
import { ChevronDown, Trash2, User, UserCog, UserStar } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { apiGet } from "@/lib/api"

const MAX_VISIBLE_USERNAME_LENGTH = 15

type UserListItem = {
  username: string
  isAdmin: boolean
  hasPassword: boolean
  createdAt: string
}

type MeResponse = {
  user: {
    username: string
    isAdmin: boolean
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
      <UserStar
        className="size-4 shrink-0 text-amber-300"
        aria-label="Admin"
      />
    )
  }

  if (!user.hasPassword) {
    return (
      <UserCog
        className="size-4 shrink-0 text-orange-300"
        aria-label="Password pending"
      />
    )
  }

  return (
    <User className="size-4 shrink-0 text-violet-300" aria-label="User" />
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
                className="absolute left-0 top-11 z-50 max-h-[188px] w-full overflow-y-auto rounded-lg border border-white/10 bg-zinc-950/95 p-1 shadow-2xl shadow-black/40"
              >
                {users.map((user) => (
                  <div
                    key={user.username}
                    className="flex h-9 items-center gap-2 rounded-md px-2 text-sm text-zinc-100 hover:bg-white/5"
                    title={user.username}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {getCompactUsername(user.username)}
                    </span>
                    <UserStatusIcon user={user} />
                    {!user.isAdmin ? (
                      <button
                        type="button"
                        onClick={() => deleteUser(user)}
                        className="rounded-md p-1 text-red-300 transition hover:bg-red-400/10 hover:text-red-200"
                        aria-label={`Delete ${user.username}`}
                        title={`Delete ${user.username}`}
                      >
                        <Trash2 className="size-4" />
                      </button>
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
