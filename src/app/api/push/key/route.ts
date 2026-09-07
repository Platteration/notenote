import { json } from "@/lib/api";
import { vapidPublicKey } from "@/lib/push";

export function GET() {
  const key = vapidPublicKey();
  return json({ publicKey: key, configured: key !== null });
}
