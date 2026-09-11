import "dotenv/config";
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { connect, initSchema, seedIfEmpty } from "./db.js";
import { api } from "./routes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

await connect();
await initSchema();
await seedIfEmpty();

const app = express();
app.use(express.json());
app.use("/api", api);
app.use(express.static(join(__dirname, "../../public"))); // frontend

const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => console.log(`[kanban] http://localhost:${PORT}`));
