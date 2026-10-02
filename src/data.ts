// Carga de los JSON sintéticos y utilidades de tiempo. Sin persistencia:
// los archivos se leen una vez y las escrituras confirmadas viven en memoria.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function load<T>(file: string): T {
  return JSON.parse(readFileSync(join(ROOT, file), "utf8")) as T;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  tz: string;
  permissions: string[];
}
export interface Client {
  id: string;
  agent_id: string;
  name: string;
  status: string;
  note: string;
}
export interface CalendarEvent {
  agent_id: string;
  start: string;
  title: string;
}
export interface ToolSpec {
  name: string;
  write: boolean;
  requires_confirmation?: boolean;
  note?: string;
}

/** Corrección automática del catálogo de soporte. */
export interface Runbook {
  id: string;
  title: string;
  fixes: string;
  permission: string;
  auto_approved: boolean;
  why: string;
}

export const AGENTS = load<Agent[]>("agents.json");
export const CLIENTS = load<Client[]>("clients.json");
export const CALENDAR_SEED = load<CalendarEvent[]>("calendar.json");
export const TOOL_REGISTRY = load<{ tools: ToolSpec[] }>("mock_tools.json").tools;

// Soporte: archivo propio para no modificar los datos sintéticos del reto.
const SUPPORT = load<{ tools: ToolSpec[]; runbooks: Runbook[] }>("support_tools.json");
export const SUPPORT_TOOLS = SUPPORT.tools;
export const RUNBOOKS = SUPPORT.runbooks;

/** "Hoy" fijo para el reto. Se puede sobreescribir con TODAY=YYYY-MM-DD. */
export const TODAY = process.env.TODAY ?? "2026-09-29";

export function getAgent(id: string): Agent | undefined {
  return AGENTS.find((a) => a.id === id);
}

/** Minúsculas y sin tildes: "José" y "Jose" deben coincidir. */
export function norm(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Fecha, hora y abreviatura de un instante vistos desde una zona IANA. */
export function localParts(instant: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
    abbr: get("timeZoneName"),
  };
}

/** Convierte una hora local ("2026-09-30", "10:00") en una zona IANA a un instante UTC. */
export function zonedToUtc(date: string, time: string, tz: string): Date {
  const naive = Date.parse(`${date}T${time}:00Z`);
  let guess = naive;
  // Dos pasadas bastan para resolver el offset, incluido el cambio de horario.
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(guess), tz);
    const seen = Date.parse(`${p.date}T${p.time}:00Z`);
    guess += naive - seen;
  }
  return new Date(guess);
}
