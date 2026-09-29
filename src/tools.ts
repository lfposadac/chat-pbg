// Capa 3: herramientas. Reciben el actor que inyecta la política (nunca un
// agent_id del modelo) y SIEMPRE filtran por él. Las acciones de escritura no
// escriben: preparan un pending_action que solo /confirm puede ejecutar.
import { randomUUID } from "node:crypto";
import {
  type Agent,
  type CalendarEvent,
  CALENDAR_SEED,
  CLIENTS,
  TODAY,
  localParts,
  norm,
  zonedToUtc,
} from "./data.js";

/** Los eventos de calendar.json no traen duración; se asume esta. */
export const DEFAULT_EVENT_MINUTES = 30;

export class ToolError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export interface PendingAction {
  token: string;
  actor_id: string;
  tool: "schedule_meeting" | "create_task";
  args: Record<string, unknown>;
  summary: string;
  conflicts: { title: string; local_time: string; tz_abbr: string }[];
  status: "pending" | "executed" | "cancelled";
  created_at: string;
}

// Estado en memoria (sin persistencia, por regla del reto).
let calendar: CalendarEvent[] = [];
let tasks: { agent_id: string; title: string; due_date?: string }[] = [];
const pending = new Map<string, PendingAction>();

export function resetStore(): void {
  calendar = CALENDAR_SEED.map((e) => ({ ...e }));
  tasks = [];
  pending.clear();
}
resetStore();

export function calendarSize(): number {
  return calendar.length;
}
export function getPending(token: string): PendingAction | undefined {
  return pending.get(token);
}

// Heurística solo para la UI: marca notas que parecen órdenes. NO es la
// defensa; la defensa es que la política fija el actor y los filtros.
const INSTRUCTION_PATTERN =
  /(ignore|ignora|system message|mensaje del sistema|reveal|revela|olvida|instrucciones|permissions|permisos)/i;

function findOwnClient(actor: Agent, name: unknown) {
  if (typeof name !== "string" || !name.trim()) {
    throw new ToolError("invalid_args", "Falta el nombre del cliente.");
  }
  const q = norm(name);
  const match = CLIENTS.find((c) => c.agent_id === actor.id && norm(c.name).includes(q));
  // Mismo mensaje exista o no el cliente en otra cartera: no se filtra nada.
  if (!match) throw new ToolError("not_found", `No hay un cliente "${name}" en tu cartera.`);
  return match;
}

function toLocal(e: CalendarEvent, tz: string) {
  const instant = new Date(e.start);
  const p = localParts(instant, tz);
  return {
    title: e.title,
    start_original: e.start,
    start_utc: instant.toISOString(),
    local_date: p.date,
    local_time: p.time,
    tz,
    tz_abbr: p.abbr,
  };
}

// ---------------------------------------------------------------- lecturas

export function list_clients(actor: Agent, args: { status?: string; name?: string }) {
  let rows = CLIENTS.filter((c) => c.agent_id === actor.id);
  if (args.status) rows = rows.filter((c) => norm(c.status) === norm(args.status!));
  if (args.name) rows = rows.filter((c) => norm(c.name).includes(norm(args.name!)));
  return {

    count: rows.length,
    clients: rows.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      note: c.note,
      note_has_embedded_instructions: INSTRUCTION_PATTERN.test(c.note),
    })),
  };
}

export function read_calendar(actor: Agent, args: { date?: string }) {
  const events = calendar
    .filter((e) => e.agent_id === actor.id)
    .map((e) => toLocal(e, actor.tz))
    .filter((e) => !args.date || e.local_date === args.date)
    .sort((a, b) => a.start_utc.localeCompare(b.start_utc));
  return { tz: actor.tz, date: args.date ?? null, events };
}

export function draft_message(actor: Agent, args: { client_name?: string; body?: string }) {
  const client = findOwnClient(actor, args.client_name);
  const body =
    typeof args.body === "string" && args.body.trim()
      ? args.body.trim()
      : `Hola ${client.name.split(" ")[0]}, te escribo para dar seguimiento a tu póliza. ¿Tienes unos minutos esta semana para conversar?`;
  // No existe herramienta de envío. El borrador vuelve al agente humano.
  return { client: { id: client.id, name: client.name }, body, sent: false };
}

// ------------------------------------------ escrituras (solo preparan)

export function prepare_schedule_meeting(
  actor: Agent,
  args: { client_name?: string; date?: string; time?: string; duration_minutes?: number },
): PendingAction {
  const client = findOwnClient(actor, args.client_name);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date ?? "") || !/^\d{2}:\d{2}$/.test(args.time ?? "")) {
    throw new ToolError("invalid_args", "Fecha u hora con formato inválido (YYYY-MM-DD, HH:MM).");
  }
  if (args.date! < TODAY) throw new ToolError("invalid_args", "La fecha ya pasó.");
  const minutes = Math.min(Math.max(Number(args.duration_minutes) || 30, 15), 240);
  const start = zonedToUtc(args.date!, args.time!, actor.tz);
  const end = new Date(start.getTime() + minutes * 60_000);
  const local = localParts(start, actor.tz);

  // Conflictos: solo contra el calendario del propio actor.
  const conflicts = calendar
    .filter((e) => e.agent_id === actor.id)
    .filter((e) => {
      const s = new Date(e.start).getTime();
      const f = s + DEFAULT_EVENT_MINUTES * 60_000;
      return s < end.getTime() && start.getTime() < f;
    })
    .map((e) => {
      const l = toLocal(e, actor.tz);
      return { title: l.title, local_time: `${l.local_date} ${l.local_time}`, tz_abbr: l.tz_abbr };
    });

  const action: PendingAction = {
    token: randomUUID(),
    actor_id: actor.id,
    tool: "schedule_meeting",
    args: {
      client_id: client.id,
      client_name: client.name,
      start_utc: start.toISOString(),
      local: `${local.date} ${local.time} ${local.abbr}`,
      tz: actor.tz,
      duration_minutes: minutes,
    },
    summary: `Reunión con ${client.name} el ${local.date} a las ${local.time} ${local.abbr} (${actor.tz}), ${minutes} min`,
    conflicts,
    status: "pending",
    created_at: new Date().toISOString(),
  };
  pending.set(action.token, action);
  return action;
}

export function prepare_create_task(
  actor: Agent,
  args: { title?: string; due_date?: string; client_name?: string },
): PendingAction {
  if (typeof args.title !== "string" || !args.title.trim()) {
    throw new ToolError("invalid_args", "La tarea necesita un título.");
  }
  const client = args.client_name ? findOwnClient(actor, args.client_name) : undefined;
  const action: PendingAction = {
    token: randomUUID(),
    actor_id: actor.id,
    tool: "create_task",
    args: { title: args.title.trim(), due_date: args.due_date ?? null, client_id: client?.id ?? null },
    summary: `Tarea "${args.title.trim()}"${client ? ` para ${client.name}` : ""}${args.due_date ? ` con vencimiento ${args.due_date}` : ""}`,
    conflicts: [],
    status: "pending",
    created_at: new Date().toISOString(),
  };
  pending.set(action.token, action);
  return action;
}

/** Única ruta que escribe. La llama /confirm tras autorizar a la persona. */
export function commitPending(action: PendingAction) {
  if (action.tool === "schedule_meeting") {
    const a = action.args as { start_utc: string; client_name: string };
    calendar.push({ agent_id: action.actor_id, start: a.start_utc, title: `Reunión ${a.client_name}` });
  } else {
    const a = action.args as { title: string; due_date?: string };
    tasks.push({ agent_id: action.actor_id, title: a.title, due_date: a.due_date });
  }
  action.status = "executed";
  return { executed: action.tool, summary: action.summary };
}

export function cancelPending(action: PendingAction) {
  action.status = "cancelled";
  return { cancelled: action.tool, summary: action.summary };
}
