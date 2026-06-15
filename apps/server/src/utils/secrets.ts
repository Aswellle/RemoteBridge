import { DEFAULT_JWT_SECRET } from './jwt';

// ===== JWT 密钥强度校验 =====
// 仅在 NODE_ENV=production 时生效：拒绝默认/缺失/过短/相同/由 JWT_SECRET 派生的密钥启动，
// 避免 jwt.ts 中的开发回退值（DEFAULT_JWT_SECRET、`${JWT_SECRET}-refresh`）被带入生产环境。
const MIN_SECRET_LENGTH = 32;

function isDerivedRefreshSecret(jwtSecret: string, refreshSecret: string | undefined): boolean {
  return !refreshSecret || refreshSecret === `${jwtSecret}-refresh`;
}

export function validateJwtSecrets(): void {
  if (process.env.NODE_ENV !== 'production') return;

  const jwtSecret = process.env.JWT_SECRET || DEFAULT_JWT_SECRET;
  const refreshSecret = process.env.JWT_REFRESH_SECRET;
  const problems: string[] = [];

  if (!process.env.JWT_SECRET || jwtSecret === DEFAULT_JWT_SECRET) {
    problems.push('JWT_SECRET 未设置或仍为默认开发密钥');
  } else if (jwtSecret.length < MIN_SECRET_LENGTH) {
    problems.push(`JWT_SECRET 长度不足 ${MIN_SECRET_LENGTH} 字符`);
  }

  if (isDerivedRefreshSecret(jwtSecret, refreshSecret)) {
    problems.push('JWT_REFRESH_SECRET 未设置或由 JWT_SECRET 派生，丧失密钥独立性');
  } else if (refreshSecret!.length < MIN_SECRET_LENGTH) {
    problems.push(`JWT_REFRESH_SECRET 长度不足 ${MIN_SECRET_LENGTH} 字符`);
  } else if (refreshSecret === jwtSecret) {
    problems.push('JWT_REFRESH_SECRET 与 JWT_SECRET 相同');
  }

  if (problems.length > 0) {
    throw new Error(
      'NODE_ENV=production 拒绝启动，JWT 密钥配置不安全:\n' +
      problems.map((p) => `  - ${p}`).join('\n') +
      '\n请使用 `openssl rand -base64 48` 为 JWT_SECRET 和 JWT_REFRESH_SECRET 分别生成独立的强密钥。'
    );
  }
}
