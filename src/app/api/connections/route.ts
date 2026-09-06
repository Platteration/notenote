import { json, withUser } from "@/lib/api";
import { listConnections } from "@/lib/connections";

export const GET = withUser(async (_req, user) => json({ connections: listConnections(user.id) }));
