"use client"

import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { apiGet } from "@/lib/api"

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

export function UserManagement() {
  const [me, setMe] = useState<MeResponse["user"]>(null)
  const [users, setUsers] = useState<UserListItem[]>([])
  const [username, setUsername] = useState("")
  const [deleteUsername, setDeleteUsername] = useState("")
  const [error, setError] = useState<string | null>(null)

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

  async function deleteSelectedUser() {
    if (!deleteUsername) {
      return
    }

    const target = users.find((user) => user.username === deleteUsername)

    if (!target) {
      return
    }

    const confirmed = window.confirm(`Delete user "${target.username}"?`)

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
        username: target.username,
      }),
    })

    if (!response.ok) {
      setError("Unable to delete user")
      return
    }

    const payload = (await response.json()) as { users: UserListItem[] }
    setUsers(payload.users)
    setDeleteUsername("")
  }

  if (!me?.isAdmin) {
    return null
  }

  const deletableUsers = users.filter((user) => !user.isAdmin)

  return (
    <Card className="rounded-lg border-white/10 bg-zinc-900/75">
      <CardHeader>
        <CardTitle className="text-zinc-100">Users</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
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

        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="delete-username" className="text-zinc-400">
              Delete user
            </Label>
            <select
              id="delete-username"
              value={deleteUsername}
              onChange={(event) => setDeleteUsername(event.target.value)}
              className="h-9 w-full rounded-lg border border-white/10 bg-zinc-950/70 px-3 text-sm text-zinc-100 outline-none"
            >
              <option value="">Select user</option>
              {deletableUsers.map((user) => (
                <option key={user.username} value={user.username}>
                  {user.username}
                </option>
              ))}
            </select>
          </div>
          <Button
            type="button"
            variant="destructive"
            onClick={deleteSelectedUser}
            disabled={!deleteUsername}
          >
            Delete
          </Button>
        </div>

        {error ? <p className="text-sm text-red-300">{error}</p> : null}

        <div className="divide-y divide-white/10 overflow-hidden rounded-lg border border-white/10">
          {users.map((user) => (
            <div
              key={user.username}
              className="grid gap-1 px-3 py-2 text-sm sm:grid-cols-[1fr_auto_auto]"
            >
              <span className="font-medium text-zinc-100">{user.username}</span>
              <span className="text-zinc-500">
                {user.isAdmin ? "Admin" : "User"}
              </span>
              <span className="text-zinc-500">
                {user.hasPassword ? "Password set" : "Password pending"}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
