// Sesión simulada firmada con HMAC. No es autenticación: el interruptor del
// header hace de "login" del demo. Lo que sí garantiza es que el actor lo
// emite el servidor: editar la cookie a mano (pbg_session=A2) no sirve.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getAgent } from "./data.js";
import type { Session } from "./policy.js";

export const COOKIE = "pbg_session";
export const DEFAULT_AGENT = "A1";

// Sin SESSION_SECRET se genera uno por arranque: reiniciar invalida las sesiones.
const SECRET = process.env.SESSION_SECRET || randomBytes(32).toString("hex");

function sign(agentId: string): string {
  return createHmac("sha256", SECRET).update(agentId).digest("base64url");
}

export function issueCookie(agentId: string): string {
  return `${COOKIE}=${agentId}.${sign(agentId)}; Path=/; HttpOnly; SameSite=Strict`;
}

/** Actor de la sesión. Cookie ausente, alterada o sin firma → sesión inicial (A1). */
export function sessionFromCookie(header: string | undefined): Session {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=(A\\d+)\\.([\\w-]+)`).exec(header ?? "");
  if (m && getAgent(m[1])) {
    const given = Buffer.from(m[2]);
    const expected = Buffer.from(sign(m[1]));
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { agent_id: m[1] };
  }
  return { agent_id: DEFAULT_AGENT };
}
