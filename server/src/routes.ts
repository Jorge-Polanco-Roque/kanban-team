import { Router } from "express";
import { query, one, uid } from "./db.js";
import { verify, sign, auth } from "./auth.js";
import { askAgent } from "./agent.js";

export const api = Router();

const AVATAR = ["#E0202C", "#F08030", "#48A860", "#4FA6DE", "#8257C7", "#39B7C9"];

/* ---------- Auth (login por dominio) ---------- */
const titleize = (s: string) => s.replace(/[._-]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()).trim();

api.post("/auth/login", async (req, res) => {
  const email = String(req.body?.email || "").toLowerCase().trim();
  const password = String(req.body?.password || "");
  const domain = email.split("@")[1];
  // Error genérico e idéntico: nunca revela si el dominio/tenant existe.
  const fail = () => res.status(401).json({ error: "credenciales inválidas" });
  if (!domain) return fail();
  const t = await one(`SELECT * FROM tenants WHERE domain=$1`, [domain]);
  if (!t || !(await verify(password, t.shared_password_hash))) return fail();

  let u = await one(`SELECT * FROM users WHERE email=$1 AND tenant_id=$2`, [email, t.id]);
  if (!u) {
    const id = uid("u");
    const n = (await query(`SELECT count(*)::int c FROM users WHERE tenant_id=$1`, [t.id])).rows[0].c;
    await query(`INSERT INTO users(id,tenant_id,email,password_hash,name,role,color) VALUES($1,$2,$3,'',$4,'admin',$5)`,
      [id, t.id, email, titleize(email.split("@")[0]), AVATAR[n % AVATAR.length]]);
    u = await one(`SELECT * FROM users WHERE id=$1`, [id]);
  }
  const token = sign({ uid: u.id, tid: t.id, role: u.role, name: u.name });
  res.json({ token, tenant: t.name, user: { id: u.id, name: u.name, role: u.role, color: u.color, email: u.email } });
});

api.use(auth); // todo lo de abajo requiere sesión

api.get("/auth/me", (req, res) => res.json(req.user));

/* ---------- Usuarios (solo del tenant) ---------- */
api.get("/users", async (req, res) => {
  const r = await query(`SELECT id,name,role,color,email FROM users WHERE tenant_id=$1 ORDER BY name`, [req.user!.tid]);
  res.json(r.rows);
});

/* ---------- Tarjetas ---------- */
const mapCard = (c: any) => ({
  id: c.id, title: c.title, desc: c.descr, col: c.col, assignee: c.assignee_id, creator: c.creator_id,
  prio: c.prio, tags: c.tags || [], start: c.start_date, due: c.due_date,
});
const canEdit = (u: any, c: any) => u.role === "admin" || c.creator_id === u.uid || c.assignee_id === u.uid;

async function logEvent(tid: string, uidv: string, body: string, cardId?: string) {
  await query(`INSERT INTO activity(id,tenant_id,user_id,body,card_id,ts) VALUES($1,$2,$3,$4,$5,$6)`,
    [uid("a"), tid, uidv, body, cardId || null, Date.now()]);
}

api.get("/cards", async (req, res) => {
  const cards = (await query(`SELECT * FROM cards WHERE tenant_id=$1 ORDER BY created_at`, [req.user!.tid])).rows.map(mapCard);
  const cids = cards.map((c) => c.id);
  const comments = cids.length
    ? (await query(`SELECT * FROM comments WHERE tenant_id=$1 ORDER BY ts`, [req.user!.tid])).rows
    : [];
  for (const c of cards as any[]) c.comments = comments.filter((m) => m.card_id === c.id).map((m) => ({ id: m.id, userId: m.user_id, text: m.body, ts: Number(m.ts) }));
  res.json(cards);
});

api.post("/cards", async (req, res) => {
  const b = req.body || {};
  if (!b.title) return res.status(400).json({ error: "título requerido" });
  const id = uid("c");
  await query(`INSERT INTO cards(id,tenant_id,title,descr,col,assignee_id,creator_id,prio,tags,start_date,due_date,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, req.user!.tid, b.title, b.desc || "", b.col || "todo", b.assignee || null, req.user!.uid, b.prio || "media", b.tags || [], b.start || null, b.due || null, Date.now()]);
  await logEvent(req.user!.tid, req.user!.uid, `creó “${b.title}”`, id);
  res.json({ id });
});

api.patch("/cards/:id", async (req, res) => {
  const c = await one(`SELECT * FROM cards WHERE id=$1 AND tenant_id=$2`, [req.params.id, req.user!.tid]);
  if (!c) return res.status(404).json({ error: "no encontrada" });
  if (!canEdit(req.user!, c)) return res.status(403).json({ error: "solo tus tareas" });
  const b = req.body || {};
  const movedTo = b.col && b.col !== c.col ? b.col : null;
  await query(`UPDATE cards SET title=$1,descr=$2,col=$3,assignee_id=$4,prio=$5,tags=$6,start_date=$7,due_date=$8 WHERE id=$9 AND tenant_id=$10`,
    [b.title ?? c.title, b.desc ?? c.descr, b.col ?? c.col, b.assignee !== undefined ? b.assignee : c.assignee_id,
     b.prio ?? c.prio, b.tags ?? c.tags, b.start !== undefined ? b.start : c.start_date, b.due !== undefined ? b.due : c.due_date,
     req.params.id, req.user!.tid]);
  const COL: Record<string, string> = { todo: "Por hacer", doing: "En progreso", review: "En revisión", done: "Hecho" };
  if (movedTo) await logEvent(req.user!.tid, req.user!.uid, `movió “${c.title}” a ${COL[movedTo]}`, c.id);
  res.json({ ok: true });
});

api.delete("/cards/:id", async (req, res) => {
  const c = await one(`SELECT * FROM cards WHERE id=$1 AND tenant_id=$2`, [req.params.id, req.user!.tid]);
  if (!c) return res.status(404).json({ error: "no encontrada" });
  if (!canEdit(req.user!, c)) return res.status(403).json({ error: "solo tus tareas" });
  await query(`DELETE FROM comments WHERE card_id=$1 AND tenant_id=$2`, [c.id, req.user!.tid]);
  await query(`DELETE FROM cards WHERE id=$1 AND tenant_id=$2`, [c.id, req.user!.tid]);
  await logEvent(req.user!.tid, req.user!.uid, `eliminó “${c.title}”`);
  res.json({ ok: true });
});

api.post("/cards/:id/comments", async (req, res) => {
  const c = await one(`SELECT * FROM cards WHERE id=$1 AND tenant_id=$2`, [req.params.id, req.user!.tid]);
  if (!c) return res.status(404).json({ error: "no encontrada" });
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "texto vacío" });
  const id = uid("m");
  await query(`INSERT INTO comments(id,tenant_id,card_id,user_id,body,ts) VALUES($1,$2,$3,$4,$5,$6)`,
    [id, req.user!.tid, c.id, req.user!.uid, text, Date.now()]);
  await logEvent(req.user!.tid, req.user!.uid, `comentó en “${c.title}”: ${text}`, c.id);
  res.json({ id });
});

/* ---------- Actividad ---------- */
api.get("/activity", async (req, res) => {
  const r = await query(`SELECT * FROM activity WHERE tenant_id=$1 ORDER BY ts DESC LIMIT 100`, [req.user!.tid]);
  res.json(r.rows.map((a) => ({ id: a.id, userId: a.user_id, text: a.body, cardId: a.card_id, ts: Number(a.ts) })));
});

/* ---------- Agente (con memoria persistente por usuario/tenant) ---------- */
api.get("/agent/history", async (req, res) => {
  const r = await query(`SELECT role,body,ts FROM agent_messages WHERE tenant_id=$1 AND user_id=$2 ORDER BY ts`,
    [req.user!.tid, req.user!.uid]);
  res.json(r.rows.map((m) => ({ role: m.role, text: m.body, ts: Number(m.ts) })));
});

api.post("/agent", async (req, res) => {
  const { tid, uid: userId, name } = req.user!;
  const message = String(req.body?.message || "").trim();
  if (!message) return res.status(400).json({ error: "mensaje vacío" });
  try {
    // Memoria = últimos 16 turnos desde la DB (no se confía en el cliente).
    const hist = (await query(`SELECT role,body FROM agent_messages WHERE tenant_id=$1 AND user_id=$2 ORDER BY ts DESC LIMIT 16`,
      [tid, userId])).rows.reverse().map((m) => ({ role: m.role, text: m.body }));
    const answer = await askAgent(tid, name, message, hist);
    const now = Date.now();
    await query(`INSERT INTO agent_messages(id,tenant_id,user_id,role,body,ts) VALUES($1,$2,$3,'user',$4,$5),($6,$7,$8,'bot',$9,$10)`,
      [uid("am"), tid, userId, message, now, uid("am"), tid, userId, answer, now + 1]);
    res.json({ answer });
  } catch (e: any) {
    console.error("[agent]", e?.message);
    res.status(500).json({ error: "el agente falló", detail: e?.message });
  }
});
