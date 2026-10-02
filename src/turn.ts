// Orquestador de un turno: modelo → política → herramientas → modelo.
// Las tarjetas se construyen a partir de los resultados del SOFTWARE, no del
// texto del modelo: lo que el agente ve como dato no pasa por el LLM.
import { randomUUID } from "node:crypto";
import type { Exchange, ModelDriver, ToolResultForModel } from "./model.js";
import { type GatewayOutcome, type Session, type TraceStep, gateway, sessionActor, toModelContent } from "./policy.js";

const MAX_MODEL_STEPS = 4;

/** "running": una corrección de soporte quedó corriendo; el aviso llega después. */
export type Outcome = "executed" | "running" | "pending" | "blocked" | "answered";

export type Card =
  | { type: "clients"; clients: any[] }
  | { type: "calendar"; tz: string; date: string | null; events: any[] }
  | { type: "pending"; token: string; tool: string; summary: string; conflicts: any[] }
  | { type: "blocked"; requested: string; rule: string; reason: string }
  | { type: "draft"; client: { id: string; name: string }; body: string }
  | { type: "diagnosis"; components: any[]; issues: any[] }
  | { type: "support_job"; job_id: string; runbook: { id: string; title: string } }
  | { type: "notice"; message: string };

export interface TurnResult {
  turn_id: string;
  actor: { id: string; name: string };
  prompt: string;
  reply: string;
  cards: Card[];
  trace: TraceStep[];
  outcome: Outcome;
  model: string;
}

function toCard(o: GatewayOutcome): Card {
  switch (o.status) {
    case "blocked":
      return { type: "blocked", requested: o.requested, rule: o.rule, reason: o.reason };
    case "pending":
      return { type: "pending", token: o.action.token, tool: o.tool, summary: o.action.summary, conflicts: o.action.conflicts };
    case "error":
      return { type: "notice", message: o.message };
    case "executed":
      if (o.tool === "list_clients") return { type: "clients", clients: o.data.clients };
      if (o.tool === "read_calendar") return { type: "calendar", tz: o.data.tz, date: o.data.date, events: o.data.events };
      if (o.tool === "diagnose_my_data") return { type: "diagnosis", components: o.data.components, issues: o.data.issues };
      if (o.tool === "run_runbook") return { type: "support_job", job_id: o.data.job_id, runbook: o.data.runbook };
      return { type: "draft", client: o.data.client, body: o.data.body };
  }
}

const SEVERITY: Outcome[] = ["answered", "executed", "running", "pending", "blocked"];
const FINAL_STEP_STATUS = { answered: "info", executed: "ok", running: "info", pending: "pending", blocked: "blocked" } as const;

export async function runTurn(session: Session, prompt: string, model: ModelDriver): Promise<TurnResult> {
  const actor = sessionActor(session);
  const trace: TraceStep[] = [];
  const cards: Card[] = [];
  const history: Exchange[] = [{ role: "user", text: prompt }];
  let outcome: Outcome = "answered";
  let reply = "";

  for (let i = 0; i < MAX_MODEL_STEPS; i++) {
    const step = await model.respond(history, { agentName: actor.name, tz: actor.tz });
    history.push({ role: "assistant", step });

    if (!step.calls.length) {
      reply = step.text;
      break;
    }

    const results: ToolResultForModel[] = [];
    for (const call of step.calls) {
      const args = Object.entries(call.input).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ");
      trace.push({ by: "model", label: `propuso ${call.name}(${args})`, detail: { tool: call.name, input: call.input } });

      const o = gateway(call, session, trace);
      cards.push(toCard(o));
      const status: Outcome =
        o.status === "error" ? "answered" : o.status === "executed" && o.tool === "run_runbook" ? "running" : o.status;
      if (SEVERITY.indexOf(status) > SEVERITY.indexOf(outcome)) outcome = status;

      const { content, is_error } = toModelContent(o);
      results.push({ tool_use_id: call.id, tool: call.name, status: o.status, content, is_error });
    }
    history.push({ role: "tool_results", results });
    if (i === MAX_MODEL_STEPS - 1) reply = "Alcancé el límite de pasos para esta solicitud.";
  }

  trace.push({
    by: "model",
    label: outcome === "blocked" ? "redactó el mensaje de negación" : "redactó la respuesta",
    status: FINAL_STEP_STATUS[outcome],
    detail: { text: reply },
  });

  return {
    turn_id: randomUUID(),
    actor: { id: actor.id, name: actor.name },
    prompt,
    reply: reply || "No encontré una acción para esa solicitud. Prueba con clientes, calendario, reuniones, borradores o cuéntame si algo no está funcionando.",
    cards,
    trace,
    outcome,
    model: model.name,
  };
}
