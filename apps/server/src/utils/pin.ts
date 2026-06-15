import bcrypt from 'bcryptjs';
import { generatePin, PIN_CHARS } from '@remotebridge/shared';

// ===== PIN 哈希 =====
export async function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, 10);
}

// ===== PIN 验证 =====
export async function verifyPin(pin: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pin, hash);
}

// ===== 生成 PIN 并返回明文和哈希 =====
export async function generatePinWithHash(length: number = 8): Promise<{
  pin: string;
  hash: string;
}> {
  const pin = generatePin(length);
  const hash = await hashPin(pin);
  return { pin, hash };
}

// ===== PIN 格式验证 =====
export function isValidPinFormat(pin: string): boolean {
  const pinRegex = new RegExp(`^[${PIN_CHARS}]{8}$`);
  return pinRegex.test(pin);
}
