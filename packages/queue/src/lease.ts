import type { Redis } from "ioredis";
import { randomUUID } from "node:crypto";

export interface LeaseHandle {
  key: string;
  token: string;
  fencingToken: number;
  ttlMs: number;
}

const ACQUIRE_LEASE_LUA = `
local key = KEYS[1]
local fencingKey = KEYS[2]
local token = ARGV[1]
local ttlMs = tonumber(ARGV[2])

-- Check if lease already held
local current = redis.call('GET', key)
if current then
  return nil
end

-- Increment fencing token monotonically
local fencingToken = redis.call('INCR', fencingKey)

-- Store lease payload
local payload = cjson.encode({ token = token, fencingToken = fencingToken })
redis.call('SET', key, payload, 'PX', ttlMs)

return { token, fencingToken }
`;

const RENEW_LEASE_LUA = `
local key = KEYS[1]
local token = ARGV[1]
local ttlMs = tonumber(ARGV[2])

local current = redis.call('GET', key)
if not current then
  return 0
end

local data = cjson.decode(current)
if data.token == token then
  redis.call('PEXPIRE', key, ttlMs)
  return 1
else
  return 0
end
`;

const RELEASE_LEASE_LUA = `
local key = KEYS[1]
local token = ARGV[1]

local current = redis.call('GET', key)
if not current then
  return 0
end

local data = cjson.decode(current)
if data.token == token then
  redis.call('DEL', key)
  return 1
else
  return 0
end
`;

export class LeaseManager {
  constructor(private redis: Redis) {}

  async acquire(key: string, ttlMs = 30000): Promise<LeaseHandle | null> {
    const fencingKey = `${key}:fencing`;
    const token = randomUUID();

    const result = (await this.redis.eval(
      ACQUIRE_LEASE_LUA,
      2,
      key,
      fencingKey,
      token,
      ttlMs.toString()
    )) as [string, number] | null;

    if (!result || !result[0]) {
      return null;
    }

    return {
      key,
      token: result[0],
      fencingToken: Number(result[1]),
      ttlMs,
    };
  }

  async renew(key: string, token: string, ttlMs = 30000): Promise<boolean> {
    const res = await this.redis.eval(RENEW_LEASE_LUA, 1, key, token, ttlMs.toString());
    return res === 1;
  }

  async release(key: string, token: string): Promise<boolean> {
    const res = await this.redis.eval(RELEASE_LEASE_LUA, 1, key, token);
    return res === 1;
  }

  async verifyFencing(key: string, expectedFencingToken: number): Promise<boolean> {
    const raw = await this.redis.get(key);
    if (!raw) return false;
    try {
      const parsed = JSON.parse(raw);
      return parsed.fencingToken === expectedFencingToken;
    } catch {
      return false;
    }
  }
}
