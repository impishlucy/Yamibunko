import { RouteNoticeRedirect } from "@/components/route-notice-redirect"

export default function Unauthorized() {
  return <RouteNoticeRedirect kind="not-allowed" />
}
