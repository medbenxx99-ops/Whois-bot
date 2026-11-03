import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const CACHE_SECONDS = 30 * 24 * 60 * 60;
const MAX_MONTHLY_LOOKUPS = 500;

const RESERVE_SCRIPT = `
local cached = redis.call("GET", KEYS[1])
if cached then return {"CACHE", cached} end
local locked = redis.call("SET", KEYS[2], "1", "NX", "PX", 1100)
if not locked then return {"RATE"} end
local count = tonumber(redis.call("GET", KEYS[3]) or "0")
if count >= tonumber(ARGV[1]) then
  redis.call("DEL", KEYS[2])
  return {"LIMIT", tostring(count)}
end
redis.call("INCR", KEYS[3])
return {"CALL"}
`;

function monthKey() {
  return `whois:usage:${new Date().toISOString().slice(0, 7)}`;
}

export async function getUsage() {
  const count = Number((await redis.get(monthKey())) || 0);
  return { used: count, limit: MAX_MONTHLY_LOOKUPS, remaining: Math.max(0, MAX_MONTHLY_LOOKUPS - count) };
}

export async function lookupDomain(domain) {
  const cacheKey = `whois:cache:${domain}`;
  const rateKey = "whois:global-rate-limit";
  const counterKey = monthKey();

  const reservation = await redis.eval(
    RESERVE_SCRIPT,
    [cacheKey, rateKey, counterKey],
    [String(MAX_MONTHLY_LOOKUPS)]
  );

  const status = reservation?.[0];
  if (status === "CACHE") {
    return { kind: "cache", data: JSON.parse(reservation[1]) };
  }
  if (status === "RATE") return { kind: "rate" };
  if (status === "LIMIT") return { kind: "limit", used: Number(reservation[1]) };
  if (status !== "CALL") throw new Error("Unexpected Redis reservation response");

  try {
    const response = await fetch(`https://api.who.is/v1/whois/${encodeURIComponent(domain)}`, {
      headers: { Authorization: `Bearer ${process.env.WHOIS_API_KEY}` },
      signal: AbortSignal.timeout(8000)
    });
    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      await redis.decr(counterKey); // Who.is errors are not charged.
      const error = new Error(body?.detail || body?.title || `Who.is returned ${response.status}`);
      error.status = response.status;
      throw error;
    }

    await redis.set(cacheKey, JSON.stringify(body), { ex: CACHE_SECONDS });
    return { kind: "fresh", data: body };
  } catch (error) {
    // If fetch itself failed before an HTTP response, release the reserved local count.
    if (!error.status) await redis.decr(counterKey);
    throw error;
  }
}