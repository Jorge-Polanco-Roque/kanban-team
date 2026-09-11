import { ChatOpenAI } from "@langchain/openai";
import { tool } from "@langchain/core/tools";
import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { z } from "zod";
import { query } from "./db.js";

const COL_NAME: Record<string, string> = { todo: "Por hacer", doing: "En progreso", review: "En revisión", done: "Hecho" };
const today = () => new Date().toISOString().slice(0, 10);
const fmt = (rows: any[]) =>
  rows.length ? rows.map((c) => `• ${c.title} [${COL_NAME[c.col] || c.col}${c.due_date ? ", vence " + c.due_date : ""}${c.assignee_name ? ", " + c.assignee_name : ""}]`).join("\n") : "Ninguna.";

// Tools acotadas al tenant vía closure: el LLM no puede pedir datos de otro tenant.
function makeTools(tid: string) {
  const cardsWithNames = (extra = "", params: any[] = []) =>
    query(`SELECT c.*, u.name AS assignee_name FROM cards c LEFT JOIN users u ON u.id=c.assignee_id
            WHERE c.tenant_id=$1 ${extra} ORDER BY c.due_date NULLS LAST`, [tid, ...params]);

  return [
    tool(async () => {
      const s = await query(`SELECT col, count(*)::int c FROM cards WHERE tenant_id=$1 GROUP BY col`, [tid]);
      const total = s.rows.reduce((a, r) => a + r.c, 0);
      const done = s.rows.find((r) => r.col === "done")?.c || 0;
      const over = (await query(`SELECT count(*)::int c FROM cards WHERE tenant_id=$1 AND due_date<$2 AND col<>'done'`, [tid, today()])).rows[0].c;
      const team = (await query(`SELECT count(*)::int c FROM users WHERE tenant_id=$1`, [tid])).rows[0].c;
      return `Total: ${total} tareas. Completadas: ${done}. Pendientes: ${total - done}. Vencidas: ${over}. Personas: ${team}.`;
    }, { name: "resumen_proyecto", description: "Resumen general: totales, completadas, vencidas y tamaño del equipo.", schema: z.object({}) }),

    tool(async ({ estado, prioridad }) => {
      const conds: string[] = [], p: any[] = [];
      if (estado) { conds.push(`c.col=$${p.length + 2}`); p.push(estado); }
      if (prioridad) { conds.push(`c.prio=$${p.length + 2}`); p.push(prioridad); }
      const r = await cardsWithNames(conds.length ? "AND " + conds.join(" AND ") : "", p);
      return fmt(r.rows);
    }, {
      name: "listar_tareas", description: "Lista tareas, opcionalmente filtradas por estado y/o prioridad.",
      schema: z.object({
        estado: z.enum(["todo", "doing", "review", "done"]).optional().describe("todo=por hacer, doing=en progreso, review=en revisión, done=hecho"),
        prioridad: z.enum(["alta", "media", "baja"]).optional(),
      }),
    }),

    tool(async ({ nombre }) => {
      const r = await cardsWithNames(`AND u.name ILIKE $2`, [`%${nombre}%`]);
      return r.rows.length ? `Tareas de ${nombre}:\n${fmt(r.rows)}` : `No encontré tareas asignadas a "${nombre}".`;
    }, { name: "tareas_por_persona", description: "Tareas asignadas a una persona por su nombre.", schema: z.object({ nombre: z.string() }) }),

    tool(async () => {
      const r = await cardsWithNames(`AND c.due_date<$2 AND c.col<>'done'`, [today()]);
      return r.rows.length ? `Vencidas:\n${fmt(r.rows)}` : "No hay tareas vencidas. 🎉";
    }, { name: "tareas_vencidas", description: "Tareas con fecha de vencimiento pasada que no están completadas.", schema: z.object({}) }),

    tool(async () => {
      const r = await query(`SELECT name, role FROM users WHERE tenant_id=$1 ORDER BY name`, [tid]);
      return r.rows.map((u) => `• ${u.name} (${u.role})`).join("\n");
    }, { name: "equipo", description: "Miembros del equipo y sus roles.", schema: z.object({}) }),
  ];
}

let _llm: ChatOpenAI | null = null;
const llm = () => (_llm ??= new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0 }));

// ponytail: se crea un agente por request (barato). Cachear por tenant si la latencia importa.
export async function askAgent(tid: string, userName: string, message: string, history: { role: string; text: string }[] = []) {
  const agent = createReactAgent({ llm: llm(), tools: makeTools(tid) });
  const sys = new SystemMessage(
    `Eres el asistente de un tablero Kanban de gestión de equipos. Respondes en español, breve y claro. ` +
    `Usuario actual: ${userName}. Usa SIEMPRE las herramientas para consultar datos reales antes de responder; ` +
    `nunca inventes tareas. Si la pregunta no es sobre el proyecto, dilo amablemente.`
  );
  const msgs = [sys, ...history.slice(-8).map((m) => (m.role === "user" ? new HumanMessage(m.text) : new AIMessage(m.text))), new HumanMessage(message)];
  const out = await agent.invoke({ messages: msgs });
  const last = out.messages[out.messages.length - 1];
  return typeof last.content === "string" ? last.content : JSON.stringify(last.content);
}
