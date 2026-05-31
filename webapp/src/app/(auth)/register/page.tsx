import Link from "next/link"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export default function RegisterPage() {
  return (
    <Card className="w-full rounded-lg border-white/10 bg-zinc-900/85 shadow-[0_24px_90px_rgba(124,58,237,0.18)]">
      <CardHeader>
        <CardTitle className="text-xl text-zinc-50">Create account</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="name" className="text-zinc-400">
              Name
            </Label>
            <Input
              id="name"
              autoComplete="name"
              className="rounded-lg border-white/10 bg-zinc-950/70"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="email" className="text-zinc-400">
              Email
            </Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              className="rounded-lg border-white/10 bg-zinc-950/70"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password" className="text-zinc-400">
              Password
            </Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              className="rounded-lg border-white/10 bg-zinc-950/70"
            />
          </div>
          <Button type="submit" className="w-full rounded-lg">
            Continue
          </Button>
        </form>
        <p className="mt-4 text-center text-sm text-zinc-500">
          <Link href="/login" className="text-violet-300 hover:text-violet-200">
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  )
}
