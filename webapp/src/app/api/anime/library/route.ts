import { getLibrary } from "@/server/media/libraryStore"

export const dynamic = "force-dynamic"

export async function GET() {
  return Response.json(getLibrary())
}
