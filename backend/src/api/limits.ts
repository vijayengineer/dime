import type { FastifyInstance, FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";

export type AuthedRequest = FastifyRequest & { userId?: string; authError?: string };

/**
 * Session verification BEFORE rate limiting (onRequest hooks run in registration order), so signed-in
 * users get their own buckets instead of sharing the reverse proxy's address; unauthenticated requests are
 * limited per real client IP (Fastify must be created with trustProxy = the proxy hop) (audit M-06).
 * `verify` returns the verified user id for a bearer token, or null.
 */
export async function installAuthAndRateLimit(
  app: FastifyInstance,
  opt: { authMode: "privy" | "none"; max: number; verify: (token: string) => Promise<string | null> },
) {
  app.addHook("onRequest", async (req) => {
    const r = req as AuthedRequest;
    if (opt.authMode === "none") { r.userId = `ip:${req.ip}`; return; }
    const h = req.headers.authorization;
    if (!h?.startsWith("Bearer ")) return;
    try {
      const id = await opt.verify(h.slice(7));
      if (id) r.userId = id; else r.authError = "Invalid session";
    } catch { r.authError = "Invalid session"; }
  });
  await app.register(rateLimit, {
    max: opt.max, timeWindow: "1 minute",
    keyGenerator: (req) => { const u = (req as AuthedRequest).userId; return u ? `user:${u}` : `ip:${req.ip}`; },
  });
}
