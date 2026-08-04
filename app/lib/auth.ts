import {
  createHmac,
  randomBytes,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from "node:crypto";
const SESSION_SECONDS = 12 * 60 * 60;
const SCRYPT_MAX_MEMORY = 256 * 1024 * 1024;

type SessionPayload = {
  username: string;
  expiresAt: number;
  nonce: string;
};

function deriveKey(password: string, salt: Buffer, length: number, options: { N: number; r: number; p: number; maxmem: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, salt, length, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function sessionSecret(): string | null {
  const secret = process.env.SESSION_SECRET?.trim();
  return secret && secret.length >= 32 ? secret : null;
}

export function configuredUsername(): string {
  return process.env.APP_USERNAME?.trim() || "admin";
}

export function secureSessionCookies(): boolean {
  const configured = process.env.SESSION_COOKIE_SECURE?.trim().toLowerCase();
  if (configured === "false" || configured === "0") return false;
  if (configured === "true" || configured === "1") return true;
  return process.env.NODE_ENV === "production";
}

export function sessionCookieName(): string {
  return secureSessionCookies() ? "__Host-line_value_session" : "line_value_session";
}

export function authConfigurationError(): string | null {
  if (!process.env.APP_PASSWORD_HASH?.trim()) return "APP_PASSWORD_HASH is not configured.";
  if (!sessionSecret()) return "SESSION_SECRET must contain at least 32 characters.";
  return null;
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  if (!password || password.length > 512) return false;
  const parts = encodedHash.split("$");
  if (parts.length !== 8 || parts[1] !== "scrypt") return false;
  const [, , nText, rText, pText, saltText, hashText] = parts;
  const N = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N < 16384 || r < 1 || p < 1) return false;
  try {
    const salt = Buffer.from(saltText, "base64url");
    const expected = Buffer.from(hashText, "base64url");
    if (salt.length < 16 || expected.length < 32) return false;
    const derived = await deriveKey(password, salt, expected.length, { N, r, p, maxmem: SCRYPT_MAX_MEMORY });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export async function verifyCredentials(username: string, password: string): Promise<boolean> {
  const encodedHash = process.env.APP_PASSWORD_HASH?.trim();
  if (!encodedHash || authConfigurationError()) return false;
  const usernameMatches = safeEqual(username, configuredUsername());
  const passwordMatches = await verifyPassword(password, encodedHash);
  return usernameMatches && passwordMatches;
}

export function createSessionToken(username: string, now = Date.now()): string {
  const secret = sessionSecret();
  if (!secret) throw new Error("Authentication is not configured.");
  const payload: SessionPayload = {
    username,
    expiresAt: now + SESSION_SECONDS * 1000,
    nonce: randomBytes(18).toString("base64url"),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifySessionToken(token: string | undefined, now = Date.now()): SessionPayload | null {
  const secret = sessionSecret();
  if (!token || !secret) return null;
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra) return null;
  const expectedSignature = createHmac("sha256", secret).update(encoded).digest("base64url");
  if (!safeEqual(signature, expectedSignature)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SessionPayload;
    if (payload.username !== configuredUsername() || !Number.isFinite(payload.expiresAt) || payload.expiresAt <= now || typeof payload.nonce !== "string") return null;
    return payload;
  } catch {
    return null;
  }
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "strict" as const,
  path: "/",
  maxAge: SESSION_SECONDS,
};
