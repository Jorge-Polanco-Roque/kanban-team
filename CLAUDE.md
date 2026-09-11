# Kanban · Portal de gestión de equipos (multi-tenant)

Portal Kanban con usuarios, permisos, multi-tenant y un agente de IA (LangGraph.js).
UI muy visual, 10 paletas Pokémon conmutables (sin rosa). Destino: **GCP**.

> Regla del repo: **desarrollar solo en local. No desplegar/commit/push a producción sin orden explícita.**

---

## Estado actual (hecho)

- **Fase 1 — Backend base** ✅ · **Fase 2 — Agente LangGraph** ✅ · **Fase 3 — Frontend conectado** ✅
- **Fase 4 — Deploy GCP** ✅ **EN VIVO** (ver "Producción" abajo)

## Producción (desplegado 2026-09-11)

- **URL**: https://kanban-431276756560.us-central1.run.app
- **Cuenta GCP**: jpolanco.ro@gmail.com · **Proyecto**: `newsletter-0526` (billing compartido; el proyecto
  nuevo `kanban-jpr-0926` no se pudo facturar por cupo excedido de la cuenta ServicioVoz).
- **Cloud Run**: servicio `kanban`, región `us-central1`, min-instances=0, max=4, 512Mi/1cpu, público.
- **Cloud SQL**: Postgres 16, instancia `kanban-db` (db-f1-micro), conn `newsletter-0526:us-central1:kanban-db`.
  Cloud Run se conecta por socket `/cloudsql/...`. Base `kanban`, usuario `kanban`.
- **Secretos** (Secret Manager): `kanban-jwt-secret`, `kanban-db-url`, `kanban-openai-key`.
- **Redeploy**: `gcloud run deploy kanban --source . --region=us-central1 --project=newsletter-0526`
  (con los mismos flags de `--set-secrets` y `--add-cloudsql-instances`).
- **Pendiente**: cargar la OpenAI key real en `kanban-openai-key` y lanzar nueva revisión para
  activar el agente (hoy el secreto es placeholder).

## Arquitectura

```
kanban/
  server/                 Node 22 + TypeScript (API + agente), ESM, tsx
    src/db.ts             Capa de datos: pg (prod) / PGlite (dev, sin setup). query() + execMulti()
    src/auth.ts           bcrypt + JWT (7d) + middleware auth/tenant
    src/agent.ts          LangGraph.js createReactAgent + 5 tools tenant-scoped (OpenAI gpt-4o-mini)
    src/routes.ts         API REST, todo filtrado por tenant_id
    src/index.ts          Express: /api + sirve ../../public
    .env.example          DATABASE_URL, JWT_SECRET, OPENAI_API_KEY, PORT
  public/index.html       Frontend (1 archivo, sin build): login, tablero, panorama,
                          calendario, gantt, actividad, ajustes + agente flotante
  CLAUDE.md               este archivo
```

## Modelo multi-tenant (clave)

- Cada fila lleva `tenant_id`. **Toda** consulta se filtra por el `tenant_id` del JWT.
- **Login por dominio de correo**: el dominio → tenant; la contraseña vive en el tenant
  (`tenants.shared_password_hash`). El usuario se crea al primer login. Todos `admin` por ahora.
- **Confidencialidad**: error de login genérico e idéntico (`credenciales inválidas`) para
  dominio inexistente / password malo / cruzado. Ningún endpoint lista tenants.
- Tenants configurados (dev seed):
  - `@redrush.mx` → **Red Rush** (contraseña de organización en el seed)
  - `@ternium.com.mx` → **Ternium**
  - Las contraseñas de organización NO van en este archivo ni en git; se gestionan por Secret Manager en prod.

## Agente (LangGraph.js)

- `createReactAgent` + `ChatOpenAI(gpt-4o-mini)`. 5 tools: `resumen_proyecto`, `listar_tareas`,
  `tareas_por_persona`, `tareas_vencidas`, `equipo` — **acotadas al tenant por closure**
  (el LLM no puede consultar otro tenant).
- **Memoria persistente**: tabla `agent_messages` (tenant_id, user_id, role, body, ts).
  `POST /api/agent` carga los últimos 16 turnos desde la DB (no confía en el cliente),
  responde y guarda el turno. `GET /api/agent/history` restaura la conversación tras recargar.
- Requiere `OPENAI_API_KEY` en `server/.env`. Sin key, el resto de la app funciona; solo el chat da error.

## Permisos

- `canEdit` = admin, o creador, o asignado. Hoy todos son admin → todos pueden todo ("por el momento").
- Cuando se pidan roles diferenciados: reactivar `member` + gestión de roles (endpoints removidos, en git history).

## Correr en local

```bash
cd server
cp .env.example .env          # opcional; sin DATABASE_URL usa PGlite (.pgdata)
# para el agente: añade OPENAI_API_KEY=sk-...
npm install
npm start                     # http://localhost:8080
```
Login demo: `cualquier@redrush.mx` / `cualquier@ternium.com.mx` con la contraseña de la organización.

---

# PLAN — Puesta en producción sobre GCP (solo planeación)

Objetivo: económico sin sacrificar performance para tráfico intermitente de 2 clientes.

## Topología recomendada

```
Usuarios ──HTTPS──> Cloud Run (servidor Node, contenedor)
                        │  DATABASE_URL (Secret Manager)
                        ├──> Neon Postgres (serverless, scale-to-zero)   ← recomendado
                        │    (alternativa: Cloud SQL Postgres db-f1-micro vía socket /cloudsql)
                        └──> OpenAI API (OPENAI_API_KEY en Secret Manager)
```

**Por qué Cloud Run + Neon:** ambos escalan a cero → pagas casi nada en reposo. Cloud SQL
mantiene una instancia encendida 24/7 (~USD 8–10/mes) aunque nadie use la app.

## Pasos (cuando se autorice el deploy)

1. **Contenerizar** el servidor. Dockerfile (borrador, aún no creado):
   ```dockerfile
   FROM node:22-slim
   WORKDIR /app
   COPY server/package*.json ./server/
   RUN cd server && npm ci --omit=dev
   COPY server ./server
   COPY public ./public
   ENV NODE_ENV=production PORT=8080
   WORKDIR /app/server
   CMD ["npm","start"]
   ```
   Nota: `tsx` corre TS directo en runtime (simple). Para prod más estricta, compilar con `tsc`
   y correr JS. `public/` se copia al contexto raíz para que `../../public` resuelva.
2. **Base de datos**: crear proyecto Neon → obtener `DATABASE_URL` (`sslmode=require`).
   El schema se autoinicializa en el arranque (`CREATE TABLE IF NOT EXISTS`).
   Provisionar los 2 tenants reales con `INSERT` controlado (script de seed prod, sin datos demo).
3. **Secretos** en Secret Manager: `JWT_SECRET` (cadena larga aleatoria), `OPENAI_API_KEY`,
   `DATABASE_URL`, y las contraseñas de organización. Montarlos como env vars en Cloud Run.
4. **Artifact Registry** + **Cloud Build**: `gcloud builds submit` → imagen; deploy a Cloud Run.
5. **Cloud Run**: región cercana (`us-central1` o `northamerica-*`), `--min-instances=0`
   (máximo ahorro; hay cold start ~1–2s) o `=1` si molesta el arranque. `--max-instances` acotado.
   Concurrency por defecto (80) es suficiente.
6. **HTTPS + dominio**: Cloud Run da HTTPS por defecto. Mapear dominio propio si aplica.
7. **CI/CD** (opcional): trigger de Cloud Build desde el repo (rama main) → build + deploy.

## Estimación de costo mensual (2 clientes, uso ligero)

| Componente        | Config                    | Costo aprox.        |
|-------------------|---------------------------|---------------------|
| Cloud Run         | min-instances=0           | ~USD 0–5 (free tier cubre casi todo) |
| Neon Postgres     | free / launch tier        | USD 0–19            |
| OpenAI gpt-4o-mini| por uso del chat          | centavos/consulta   |
| Secret Manager    | pocos secretos            | ~USD 0              |
| **Total**         |                           | **~USD 0–25/mes**   |

Alternativa Cloud SQL (si se prefiere GCP puro): +~USD 8–10/mes fijos por la instancia.

## Endurecimiento pendiente para producción (checklist)

- [ ] **Rate limiting** en `POST /auth/login` (anti fuerza bruta sobre la contraseña de organización).
- [ ] **Rotación** de contraseñas de organización + política mínima; considerar migrar a
      identidad por usuario (OAuth/Google Workspace) en lugar de password compartida.
- [ ] `helmet` + CORS explícito (hoy same-origin; si el front se separa, configurar).
- [ ] Migraciones formales (hoy `CREATE IF NOT EXISTS` en boot) — p. ej. node-pg-migrate.
- [ ] Logs estructurados + Error Reporting; healthcheck `/healthz`.
- [ ] Backups de Neon/Cloud SQL activados.
- [ ] Seed de producción SIN datos demo; cada tenant arranca limpio o con su data real.

## Deudas técnicas marcadas (`ponytail:`)

- `db.ts`: email UNIQUE global (login solo por dominio+password). Si un email debe existir en
  varios tenants → UNIQUE(tenant_id,email) + login con slug de tenant.
- `agent.ts`: se crea un agente por request (barato). Cachear por tenant si la latencia importa.
  Upgrade de memoria: LangGraph Postgres checkpointer (thread por usuario) en vez de tabla propia.

## Próximos pasos sugeridos

1. Probar el agente en vivo con `OPENAI_API_KEY` (validar tools + memoria persistente).
2. Cuando se autorice: Dockerfile real + Neon + Secret Manager + primer deploy a Cloud Run.
3. Roles diferenciados (admin/member) si el cliente los pide.
