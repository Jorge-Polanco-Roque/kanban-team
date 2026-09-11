# Kanban Team · Portal de gestión de equipos multi-tenant

Portal de gestión de equipos basado en Kanban, con **múltiples clientes aislados (multi-tenant)**,
autenticación por dominio de correo, permisos por usuario, una interfaz muy visual con **10 paletas
de color conmutables** y un **agente de IA (LangGraph.js + OpenAI)** con memoria persistente que
responde preguntas sobre los datos de cada equipo.

> 🌐 **En producción:** Google Cloud (Cloud Run + Cloud SQL).

---

## ✨ Características

- **Tablero Kanban** con drag & drop nativo entre columnas (Por hacer / En progreso / En revisión / Hecho).
- **Multi-tenant**: cada cliente ve únicamente su propia información; el aislamiento se aplica en cada
  consulta por `tenant_id`. Ningún endpoint revela la existencia de otros clientes.
- **Login por dominio de correo**: el dominio determina la organización; la contraseña es por organización.
  El usuario se crea automáticamente en su primer acceso.
- **Permisos**: modelo admin / miembro (`canEdit` = admin, creador o asignado). Hoy todos son admin.
- **Vistas**:
  - 🗂️ **Tablero** — Kanban con prioridades, etiquetas, asignados, fechas y comentarios.
  - 📊 **Panorama** — dashboard con métricas: totales, en progreso, completadas, vencidas, carga por persona y prioridad.
  - 📅 **Calendario** — tareas por fecha de vencimiento, navegación mensual.
  - 📈 **Cronograma (Gantt)** — línea de tiempo por tarea (inicio → fin).
  - 💬 **Actividad** — registro de eventos del equipo (crear, mover, comentar, eliminar).
  - ⚙️ **Ajustes** — selección de paleta y filtro "solo mis tareas".
- **Agente de IA flotante** (LangGraph.js): responde en lenguaje natural usando *tools* que consultan
  la base de datos **acotadas al tenant**. Con **memoria persistente** por usuario (sobrevive recargas).
- **10 paletas Pokémon** conmutables en caliente (sin rosa): Charizard, Bulbasaur, Squirtle, Pikachu,
  Gengar, Snorlax, Umbreon, Vaporeon, Machamp, Gyarados. Incluye dos modos oscuros (Gengar, Umbreon).

---

## 🏗️ Arquitectura

```
kanban/
├── server/                 Backend — Node 22 + TypeScript (ESM, ejecutado con tsx)
│   ├── src/
│   │   ├── db.ts           Capa de datos portable: Postgres (pg) en prod, PGlite embebido en dev
│   │   ├── auth.ts         bcrypt + JWT (7 días) + middleware de autenticación/tenant
│   │   ├── agent.ts        Agente LangGraph.js (createReactAgent) + 5 tools tenant-scoped
│   │   ├── routes.ts       API REST, todas las consultas filtradas por tenant_id
│   │   └── index.ts        Express: expone /api y sirve el frontend estático
│   ├── package.json
│   └── .env.example
├── public/
│   └── index.html          Frontend completo en un solo archivo (sin build ni framework)
├── Dockerfile              Imagen para Cloud Run
├── CLAUDE.md               Documentación técnica y plan de operación/producción
└── README.md
```

### Stack

| Capa       | Tecnología                                              |
|------------|--------------------------------------------------------|
| Frontend   | HTML/CSS/JS puro (un archivo), sin build ni dependencias |
| Backend    | Node 22, TypeScript, Express                            |
| Agente     | LangGraph.js (`@langchain/langgraph`), OpenAI `gpt-4o-mini` |
| Datos      | PostgreSQL (`pg`) · PGlite (`@electric-sql/pglite`) en desarrollo |
| Auth       | JWT (`jsonwebtoken`) + hashing `bcryptjs`              |
| Infra      | Google Cloud Run + Cloud SQL (Postgres) + Secret Manager |

### Modelo de datos

- **tenants** — organización: `domain`, `shared_password_hash`.
- **users** — pertenecen a un tenant; se crean al primer login.
- **cards** — tareas con estado, prioridad, etiquetas, asignado, fechas.
- **comments** — comentarios por tarjeta.
- **activity** — registro de eventos por tenant.
- **agent_messages** — memoria del agente por usuario/tenant.

Toda tabla incluye `tenant_id` y **todas** las consultas se filtran por él.

---

## 🚀 Desarrollo local

Requisitos: Node 22+.

```bash
cd server
cp .env.example .env          # opcional
npm install
npm start                     # http://localhost:8080
```

- Sin `DATABASE_URL`, la app usa **PGlite** automáticamente (Postgres embebido en `server/.pgdata`),
  sin necesidad de instalar ni configurar una base de datos.
- Para habilitar el agente, agrega `OPENAI_API_KEY` en `server/.env`.

### Variables de entorno

| Variable         | Descripción                                                        |
|------------------|--------------------------------------------------------------------|
| `DATABASE_URL`   | Cadena de conexión a Postgres. Vacío → PGlite local.               |
| `JWT_SECRET`     | Secreto para firmar los tokens JWT.                                |
| `OPENAI_API_KEY` | Clave de OpenAI para el agente.                                    |
| `PORT`           | Puerto del servidor (por defecto `8080`).                          |

---

## 🔌 API

Todos los endpoints (excepto login) requieren `Authorization: Bearer <token>`.

| Método | Ruta                       | Descripción                                    |
|--------|----------------------------|------------------------------------------------|
| POST   | `/api/auth/login`          | Login por dominio de correo → JWT              |
| GET    | `/api/auth/me`             | Datos del usuario autenticado                  |
| GET    | `/api/users`               | Miembros del tenant                            |
| GET    | `/api/cards`               | Tarjetas del tenant (con comentarios)          |
| POST   | `/api/cards`               | Crear tarjeta                                  |
| PATCH  | `/api/cards/:id`           | Editar / mover tarjeta (según permisos)        |
| DELETE | `/api/cards/:id`           | Eliminar tarjeta (según permisos)              |
| POST   | `/api/cards/:id/comments`  | Comentar una tarjeta                           |
| GET    | `/api/activity`            | Registro de actividad del tenant               |
| POST   | `/api/agent`               | Preguntar al agente (con memoria persistente)  |
| GET    | `/api/agent/history`       | Historial de conversación del usuario          |

---

## 🤖 Agente de IA

Construido con **LangGraph.js** (`createReactAgent`) sobre OpenAI `gpt-4o-mini`. Dispone de 5 herramientas
que consultan la base de datos **siempre acotadas al tenant** del usuario autenticado (el modelo no puede
acceder a datos de otra organización):

- `resumen_proyecto` — totales, completadas, vencidas, tamaño del equipo.
- `listar_tareas` — filtra por estado y/o prioridad.
- `tareas_por_persona` — tareas asignadas a alguien.
- `tareas_vencidas` — tareas fuera de fecha no completadas.
- `equipo` — miembros y roles.

La conversación se **persiste** en la tabla `agent_messages` (por usuario/tenant); el servidor carga los
últimos turnos desde la base de datos en cada consulta (no confía en el historial enviado por el cliente).

---

## ☁️ Despliegue en Google Cloud

La aplicación se despliega en **Cloud Run** (contenedor) conectado a **Cloud SQL (PostgreSQL)** mediante
socket, con los secretos en **Secret Manager**.

```bash
gcloud run deploy kanban \
  --source . \
  --region=us-central1 \
  --allow-unauthenticated \
  --add-cloudsql-instances="PROJECT:REGION:INSTANCE" \
  --set-secrets="DATABASE_URL=kanban-db-url:latest,JWT_SECRET=kanban-jwt-secret:latest,OPENAI_API_KEY=kanban-openai-key:latest" \
  --memory=512Mi --cpu=1 --min-instances=0 --max-instances=4 --port=8080
```

El esquema de base de datos se inicializa automáticamente al arrancar (`CREATE TABLE IF NOT EXISTS`).
Detalles completos de operación, costos y endurecimiento en [`CLAUDE.md`](./CLAUDE.md).

---

## 🔐 Seguridad

- Contraseñas hasheadas con bcrypt; tokens JWT firmados.
- Aislamiento estricto por `tenant_id` en cada consulta y en las tools del agente.
- Error de login **genérico e idéntico** — no revela si un dominio/tenant existe.
- Secretos gestionados fuera del código (Secret Manager en producción).

### Notas / mejoras recomendadas

- Las contraseñas de organización del *seed* de demostración están en el código. Para un entorno
  público o multi-cliente, moverlas a variables de entorno / Secret Manager y rotarlas.
- Pendiente para producción: rate limiting en el login, migraciones formales, dominio propio y,
  eventualmente, identidad por usuario (OAuth / Google Workspace) en vez de contraseña por organización.

---

## 📄 Licencia

Proyecto privado. Todos los derechos reservados.
