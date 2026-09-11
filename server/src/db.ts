import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";

// Capa de datos portable: Postgres (pg) en prod, PGlite embebido en dev si no hay DATABASE_URL.
// Ambos exponen query(sql, params) -> { rows }, así que el resto del código no distingue.
type QueryResult = { rows: any[] };
let _query: (sql: string, params?: any[]) => Promise<QueryResult>;
let _execMulti: (sql: string) => Promise<void>; // varias sentencias (DDL)

export async function connect() {
  if (process.env.DATABASE_URL) {
    const { Pool } = await import("pg");
    const local = /localhost|127\.0\.0\.1|\/cloudsql\//.test(process.env.DATABASE_URL);
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: local ? undefined : { rejectUnauthorized: true }, // TLS verificado (Neon/Cloud SQL usan certs válidos)
    });
    _query = (sql, params) => pool.query(sql, params);
    _execMulti = async (sql) => { await pool.query(sql); };
    console.log("[db] Postgres vía DATABASE_URL");
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const pg = new PGlite("./.pgdata");
    _query = (sql, params) => pg.query(sql, params) as Promise<QueryResult>;
    _execMulti = (sql) => pg.exec(sql) as unknown as Promise<void>;
    console.log("[db] PGlite local (.pgdata) — sin DATABASE_URL");
  }
}

export const query = (sql: string, params?: any[]) => _query(sql, params);
export const one = async (sql: string, params?: any[]) => (await query(sql, params)).rows[0] || null;
export const uid = (p: string) => p + "_" + randomUUID().slice(0, 8);

export async function initSchema() {
  await _execMulti(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
      domain TEXT UNIQUE NOT NULL, shared_password_hash TEXT NOT NULL,
      created_at BIGINT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
      email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', color TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
      title TEXT NOT NULL, descr TEXT DEFAULT '', col TEXT NOT NULL DEFAULT 'todo',
      assignee_id TEXT, creator_id TEXT NOT NULL, prio TEXT NOT NULL DEFAULT 'media',
      tags TEXT[] DEFAULT '{}', start_date TEXT, due_date TEXT, created_at BIGINT NOT NULL);
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
      card_id TEXT NOT NULL, user_id TEXT NOT NULL, body TEXT NOT NULL, ts BIGINT NOT NULL);
    CREATE TABLE IF NOT EXISTS activity (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
      user_id TEXT NOT NULL, body TEXT NOT NULL, card_id TEXT, ts BIGINT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_messages (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
      user_id TEXT NOT NULL, role TEXT NOT NULL, body TEXT NOT NULL, ts BIGINT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_cards_tenant ON cards(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_activity_tenant ON activity(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_agentmsg_user ON agent_messages(tenant_id,user_id,ts);
  `);
}

// Login por dominio: la contraseña vive en el tenant; los usuarios se crean al primer login.
export async function seedIfEmpty() {
  const n = await one(`SELECT count(*)::int AS c FROM tenants`);
  if (n.c > 0) return;
  const now = Date.now();
  const iso = (d: number) => { const x = new Date(); x.setDate(x.getDate() + d); return x.toISOString().slice(0, 10); };

  async function makeTenant(name: string, slug: string, domain: string, password: string, seedName: string, cards: any[]) {
    const tid = uid("t"), owner = uid("u");
    await query(`INSERT INTO tenants(id,name,slug,domain,shared_password_hash,created_at) VALUES($1,$2,$3,$4,$5,$6)`,
      [tid, name, slug, domain, bcrypt.hashSync(password, 10), now]);
    await query(`INSERT INTO users(id,tenant_id,email,password_hash,name,role,color) VALUES($1,$2,$3,$4,$5,'admin',$6)`,
      [owner, tid, `ops@${domain}`, "", seedName, "#E0202C"]);
    for (const c of cards) {
      await query(`INSERT INTO cards(id,tenant_id,title,descr,col,assignee_id,creator_id,prio,tags,start_date,due_date,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [uid("c"), tid, c.title, c.descr || "", c.col, owner, owner, c.prio, c.tags || [], c.start, c.due, now]);
    }
  }

  await makeTenant("Red Rush", "redrush", "redrush.mx", "redrush2026", "Operaciones", [
    { title: "Ruta MTY–CDMX", descr: "Consolidar carga terrestre", col: "doing", prio: "alta", tags: ["operaciones"], start: iso(-2), due: iso(3) },
    { title: "Onboarding transportistas", descr: "Alta de nuevas unidades", col: "todo", prio: "media", tags: ["flota"], start: iso(1), due: iso(6) },
    { title: "Auditoría de unidades", col: "done", prio: "baja", tags: ["cumplimiento"], start: iso(-6), due: iso(-1) }]);

  await makeTenant("Ternium", "ternium", "ternium.com.mx", "ternium2026", "Planta", [
    { title: "Mantenimiento colada continua", descr: "Ventana programada", col: "doing", prio: "alta", tags: ["mantenimiento"], start: iso(-1), due: iso(4) },
    { title: "Reporte de particulados", descr: "Monitoreo ambiental", col: "review", prio: "media", tags: ["ambiental"], start: iso(-3), due: iso(2) },
    { title: "Inventario de rollos", col: "todo", prio: "baja", tags: ["logística"], start: iso(0), due: iso(8) }]);

  console.log("[db] seed listo — 2 tenants configurados por dominio");
}
