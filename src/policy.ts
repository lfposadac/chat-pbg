// Capa 2: política. Determinista, sin LLM. Intercepta CADA llamada que el
// modelo propone, fija el actor desde la sesión y decide: ejecutar, bloquear o
// dejar pendiente de confirmación humana. Es el único llamador de tools.ts.
import { type Agent, AGENTS, RUNBOOKS, SUPPORT_TOOLS, TOOL_REGISTRY, getAgent, norm } from "./data.js";
import * as tools from "./tools.js";
import { type PendingAction, ToolError } from "./tools.js";

export interface Session {
  agent_id: string;
}

export type StepStatus = "ok" | "pending" | "blocked" | "info";
export interface TraceStep {
  by: "model" | "software" | "human";
  label: string;
  detail?: unknown;
  status?: StepStatus;
}

export interface ProposedCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type GatewayOutcome =
  | { status: "executed"; tool: string; data: any }
  | { status: "pending"; tool: string; action: PendingAction }
  | { status: "blocked"; tool: string; rule: string; reason: string; requested: string }
  | { status: "error"; tool: string; code: string; message: string };

/** Permiso requerido por herramienta, verificado contra agents.json. */
export const REQUIRED_PERMISSION: Record<string, string> = {
  list_clients: "clients:read",
  read_calendar: "calendar:read",
  schedule_meeting: "calendar:write",
  create_task: "tasks:write",
  draft_message: "clients:read",
  diagnose_my_data: "clients:read",
  // run_runbook: el permiso lo define cada runbook del catálogo.
};

/** Parámetros de identidad que el modelo nunca puede fijar. Se descartan. */
const IDENTITY_KEYS = ["agent_id", "actor", "actor_id", "owner_id", "user_id", "session"];

function describe(call: ProposedCall): string {
  const args = Object.entries(call.input)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(", ");
  return `${call.name}(${args})`;
}

function resolveAgent(ref: string): Agent | undefined {
  const q = norm(ref);
  return AGENTS.find((a) => norm(a.id) === q || norm(a.name) === q);
}

export function sessionActor(session: Session): Agent {
  const actor = getAgent(session.agent_id);
  if (!actor) throw new Error(`Sesión inválida: ${session.agent_id}`);
  return actor;
}

/**
 * Evalúa y, si procede, ejecuta una llamada propuesta por el modelo.
 * Añade a `trace` cada decisión del software.
 */
export function gateway(call: ProposedCall, session: Session, trace: TraceStep[]): GatewayOutcome {
  const actor = sessionActor(session);
  const requested = describe(call);
  const block = (rule: string, reason: string): GatewayOutcome => {
    trace.push({ by: "software", label: `política: ${reason} → BLOQUEADO`, status: "blocked", detail: { rule, requested } });
    return { status: "blocked", tool: call.name, rule, reason, requested };
  };

  // R1. Solo herramientas registradas en mock_tools.json o support_tools.json.
  const spec = [...TOOL_REGISTRY, ...SUPPORT_TOOLS].find((t) => t.name === call.name);
  if (!spec) return block("tool_not_registered", `la herramienta "${call.name}" no existe en el registro`);

  // R2. Identidad: el actor sale de la sesión; lo que mande el modelo se ignora.
  const args = { ...call.input };
  const ignored = IDENTITY_KEYS.filter((k) => k in args);
  for (const k of ignored) delete args[k];
  const target = typeof args.agent === "string" ? args.agent : undefined;
  delete args.agent;
  trace.push({
    by: "software",
    label:
      ignored.length || target
        ? `actor de sesión es ${actor.id}; parámetro ${[...ignored, ...(target ? ["agent"] : [])].join(", ")} ignorado`
        : `actor inyectado desde la sesión: ${actor.id}`,
    status: "info",
    detail: { actor: actor.id, ignored_params: target ? [...ignored, `agent=${target}`] : ignored, effective_args: args },
  });

  // R3. Aislamiento: pedir datos de otro agente se niega, no se reinterpreta.
  if (target) {
    const owner = resolveAgent(target);
    if (!owner || owner.id !== actor.id) {
      const verb = spec.write ? "escribir en" : "leer";
      return block(
        "cross_agent_access",
        owner ? `${actor.id} no puede ${verb} datos de ${owner.id}` : `${actor.id} solo puede ${verb} sus propios datos`,
      );
    }
  }

  // R6. Soporte: el modelo no inventa correcciones. Solo runbooks del catálogo
  // marcados como auto-aprobados; lo demás requiere a un ingeniero.
  const runbook = call.name === "run_runbook" ? RUNBOOKS.find((r) => r.id === args.runbook_id) : undefined;
  if (call.name === "run_runbook") {
    if (!runbook) return block("runbook_not_in_catalog", `el runbook "${String(args.runbook_id)}" no está en el catálogo`);
    if (!runbook.auto_approved) return block("runbook_requires_human", `"${runbook.id}" ${runbook.why}`);
  }

  // R4. Permiso del actor según agents.json.
  const perm = runbook ? runbook.permission : REQUIRED_PERMISSION[call.name];
  if (!perm || !actor.permissions.includes(perm)) {
    return block("missing_permission", `${actor.id} no tiene el permiso ${perm ?? "(sin mapear)"}`);
  }
  trace.push({ by: "software", label: `permiso ${perm} verificado para ${actor.id}`, status: "info", detail: { permissions: actor.permissions } });

  try {
    // R5. Escrituras materiales: nunca se ejecutan aquí. Quedan pendientes.
    if (spec.write && spec.requires_confirmation) {
      const action =
        call.name === "schedule_meeting" ? tools.prepare_schedule_meeting(actor, args) : tools.prepare_create_task(actor, args);
      if (action.conflicts.length) {
        trace.push({ by: "software", label: `conflicto detectado: ${action.conflicts.map((c) => `"${c.title}" ${c.local_time} ${c.tz_abbr}`).join(", ")}`, status: "pending", detail: action.conflicts });
      }
      trace.push({ by: "software", label: `${call.name} requiere confirmación → PENDIENTE (nada escrito)`, status: "pending", detail: { token: action.token, summary: action.summary } });
      return { status: "pending", tool: call.name, action };
    }

    if (call.name === "diagnose_my_data") {
      const data = tools.diagnose_my_data(actor, RUNBOOKS);
      trace.push({
        by: "software",
        label: data.issues.length
          ? `diagnóstico de ${actor.id}: ${data.issues.map((i) => `${i.name.toLowerCase()} con ${i.detail}`).join(", ")} → PROBLEMA DETECTADO`
          : `diagnóstico de ${actor.id}: todos los componentes en orden`,
        status: "info",
        detail: data,
      });
      return { status: "executed", tool: call.name, data };
    }

    // No requiere confirmación: el catálogo solo auto-aprueba correcciones
    // idempotentes sobre datos derivados del propio actor. Igual se verifican.
    if (runbook) {
      const job = tools.start_runbook(actor, runbook);
      trace.push({ by: "software", label: `runbook "${runbook.id}" en el catálogo y auto-aprobado: ${runbook.why}`, status: "info", detail: runbook });
      trace.push({ by: "software", label: "corrección en curso; el aviso sale solo si la verificación pasa", status: "info", detail: { job_id: job.id } });
      return { status: "executed", tool: call.name, data: { job_id: job.id, status: job.status, runbook: job.runbook, before: job.before } };
    }

    const data =
      call.name === "list_clients" ? tools.list_clients(actor, args)
      : call.name === "read_calendar" ? tools.read_calendar(actor, args)
      : tools.draft_message(actor, args);

    const filterNote = call.name === "draft_message" ? "borrador generado; no existe herramienta de envío" : `filtro agent_id=${actor.id} aplicado`;
    trace.push({ by: "software", label: `${call.name} ejecutado · ${filterNote}`, status: "ok", detail: data });
    const flagged = "clients" in data ? data.clients.filter((c) => c.note_has_embedded_instructions) : [];
    if (flagged.length) {
      trace.push({
        by: "software",
        label: `${flagged.length} nota(s) con instrucciones embebidas: se entregan al modelo como <tool_data untrusted>, nunca como órdenes`,
        status: "info",
        detail: flagged.map((c: any) => ({ id: c.id, note: c.note })),
      });
    }
    return { status: "executed", tool: call.name, data };
  } catch (err) {
    if (err instanceof ToolError) {
      trace.push({ by: "software", label: `${call.name}: ${err.message}`, status: "info", detail: { code: err.code } });
      return { status: "error", tool: call.name, code: err.code, message: err.message };
    }
    throw err;
  }
}

/** Autoriza /confirm y /cancel: el token debe existir, seguir pendiente y ser del actor de la sesión. */
export function authorizeDecision(token: string, session: Session): { ok: true; action: PendingAction } | { ok: false; reason: string } {
  const action = tools.getPending(token);
  if (!action) return { ok: false, reason: "token desconocido" };
  if (action.actor_id !== session.agent_id) return { ok: false, reason: `el token pertenece a otra sesión; ${session.agent_id} no puede confirmarlo` };
  if (action.status !== "pending") return { ok: false, reason: `la acción ya está ${action.status === "executed" ? "ejecutada" : "cancelada"}` };
  return { ok: true, action };
}

/** Lo que ve el modelo: datos envueltos como no confiables, sin tokens ni IDs de agente. */
export function toModelContent(o: GatewayOutcome): { content: string; is_error: boolean } {
  switch (o.status) {
    case "executed": {
      // El modelo no recibe el id del job: no puede consultarlo ni anunciar el resultado.
      const data =
        o.tool === "run_runbook"
          ? { status: "running", runbook: o.data.runbook, note: "El software verificará la corrección y avisará al agente en el chat." }
          : o.data;
      return { content: `<tool_data untrusted="true">${JSON.stringify(data)}</tool_data>`, is_error: false };
    }
    case "pending":
      return {
        content: `<policy_decision status="pending_confirmation">${JSON.stringify({ summary: o.action.summary, conflicts: o.action.conflicts, note: "Nada se ha escrito. Solo el agente humano puede confirmar desde la interfaz." })}</policy_decision>`,
        is_error: false,
      };
    case "blocked":
      return { content: `<policy_decision status="blocked" rule="${o.rule}">${o.reason}. No se devolvió ningún dato.</policy_decision>`, is_error: true };
    case "error":
      return { content: `<policy_decision status="error">${o.message}</policy_decision>`, is_error: true };
  }
}
