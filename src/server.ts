// Servidor HTTP nativo. La sesión es una cookie simulada pero firmada (sin
// autenticación real, por regla del reto): el actor SIEMPRE sale de aquí,
// nunca del cuerpo de la petición ni del modelo.
import { readFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { join } from "node:path";
import { AGENTS, ROOT, TODAY, getAgent } from "./data.js";
import { createModel } from "./model.js";
import { type Session, type TraceStep, authorizeDecision } from "./policy.js";
import { issueCookie, sessionFromCookie } from "./session.js";
import { cancelPending, commitPending, resetStore } from "./tools.js";
import { runTurn } from "./turn.js";

const PORT = Number(process.env.PORT ?? 3000);
const RESET_EVERY_MIN = Number(process.env.RESET_EVERY_MIN ?? 0);
const model = createModel();

// En un demo público todos comparten el estado en memoria: se restaura solo.
if (RESET_EVERY_MIN > 0) setInterval(resetStore, RESET_EVERY_MIN * 60_000).unref();

function sessionFrom(req: IncomingMessage): Session {
  return sessionFromCookie(req.headers.cookie);
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new Error("payload demasiado grande");
  }
  return raw ? JSON.parse(raw) : {};
}

function profile(session: Session) {
  const a = getAgent(session.agent_id)!;
  return { agent: a, agents: AGENTS.map(({ id, name }) => ({ id, name })), today: TODAY, model: model.name };
}

async function decide(req: IncomingMessage, res: ServerResponse, kind: "confirm" | "cancel") {
  const session = sessionFrom(req);
  const { token } = await readJson(req);
  const trace: TraceStep[] = [
    { by: "human", label: `${kind === "confirm" ? "confirmó" : "canceló"} la acción desde la interfaz`, detail: { token } },
  ];
  const auth = authorizeDecision(String(token ?? ""), session);
  if (!auth.ok) {
    trace.push({ by: "software", label: `política: ${auth.reason} → BLOQUEADO`, status: "blocked" });
    return send(res, 403, { ok: false, reason: auth.reason, trace });
  }
  const result = kind === "confirm" ? commitPending(auth.action) : cancelPending(auth.action);
  trace.push({
    by: "software",
    label: kind === "confirm" ? `${auth.action.tool} ejecutado para ${session.agent_id} → ESCRITO` : "acción descartada; nada escrito",
    status: kind === "confirm" ? "ok" : "info",
    detail: result,
  });
  send(res, 200, { ok: true, result, trace });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(readFileSync(join(ROOT, "public", "index.html")));
    }
    if (req.method === "GET" && url.pathname === "/api/session") return send(res, 200, profile(sessionFrom(req)));
    if (req.method === "POST" && url.pathname === "/api/session") {
      const { agent_id } = await readJson(req);
      if (!getAgent(agent_id)) return send(res, 400, { error: "agente desconocido" });
      return send(res, 200, profile({ agent_id }), { "set-cookie": issueCookie(agent_id) });
    }
    if (req.method === "POST" && url.pathname === "/api/chat") {
      const { message } = await readJson(req);
      if (typeof message !== "string" || !message.trim()) return send(res, 400, { error: "mensaje vacío" });
      // Cualquier agent_id del cuerpo se ignora: el actor viene de la cookie.
      return send(res, 200, await runTurn(sessionFrom(req), message.trim().slice(0, 2000), model));
    }
    if (req.method === "POST" && url.pathname === "/api/confirm") return await decide(req, res, "confirm");
    if (req.method === "POST" && url.pathname === "/api/cancel") return await decide(req, res, "cancel");
    send(res, 404, { error: "no encontrado" });
  } catch (err) {
    console.error(err);
    send(res, 500, { error: err instanceof Error ? err.message : "error interno" });
  }
});

server.listen(PORT, () => {
  console.log(`Chat PBG en http://localhost:${PORT}  ·  modelo: ${model.name}`);
  if (RESET_EVERY_MIN > 0) console.log(`Los datos se restauran cada ${RESET_EVERY_MIN} min.`);
});
