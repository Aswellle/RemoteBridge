import { hash, compare } from '@node-rs/bcrypt';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { generatePin, PIN_CHARS } from '@remotebridge/shared';

// HMAC_KEY 用 JWT_SECRET 派生（同服务器，无需额外 env）
// 加 ':pin-hmac' 域分隔符防止与 JWT 签名共享密钥材料
const HMAC_KEY = (process.env.JWT_SECRET ?? 'dev-only') + ':pin-hmac';

// ===== HMAC 预过滤（BP-M1）=====
// 比 bcrypt 快 3-4 个数量级，用于在 bcrypt 验证前快速淘汰明显错误的 PIN
export function computePinHmac(pin: string): string {
  return createHmac('sha256', HMAC_KEY).update(pin).digest('hex');
}

function hmacMatch(pin: string, storedHmac: string): boolean {
  const computed = Buffer.from(computePinHmac(pin), 'hex');
  const stored = Buffer.from(storedHmac, 'hex');
  if (computed.length !== stored.length) return false;
  return timingSafeEqual(computed, stored);
}

// ===== PIN 哈希（PERF-H1: native @node-rs/bcrypt 替代纯 JS bcryptjs）=====
export async function hashPin(pin: string): Promise<string> {
  return hash(pin, 10);
}

// ===== PIN 验证（先 HMAC 预过滤，再 bcrypt）=====
export async function verifyPin(pin: string, bcryptHash: string, storedHmac?: string | null): Promise<boolean> {
  if (storedHmac && !hmacMatch(pin, storedHmac)) return false;
  return compare(pin, bcryptHash);
}

// ===== 生成 PIN 并返回明文、哈希与 HMAC =====
export async function generatePinWithHash(length: number = 8): Promise<{
  pin: string;
  hash: string;
  hmac: string;
}> {
  const pin = generatePin(length);
  const [pinHash, hmac] = await Promise.all([hashPin(pin), Promise.resolve(computePinHmac(pin))]);
  return { pin, hash: pinHash, hmac };
}

// ===== PIN 格式验证 =====
export function isValidPinFormat(pin: string): boolean {
  const pinRegex = new RegExp(`^[${PIN_CHARS}]{8}$`);
  return pinRegex.test(pin);
}
