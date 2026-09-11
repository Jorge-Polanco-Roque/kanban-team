import type { Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET || "dev-insecure-secret-cambia-esto";

export type Principal = { uid: string; tid: string; role: string; name: string };
declare global { namespace Express { interface Request { user?: Principal } } }

export const hash = (pw: string) => bcrypt.hash(pw, 10);
export const verify = (pw: string, h: string) => bcrypt.compare(pw, h);
export const sign = (p: Principal) => jwt.sign(p, SECRET, { expiresIn: "7d" });

export function auth(req: Request, res: Response, next: NextFunction) {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return res.status(401).json({ error: "no autenticado" });
  try {
    req.user = jwt.verify(h.slice(7), SECRET) as Principal;
    next();
  } catch {
    res.status(401).json({ error: "token inválido" });
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "solo admin" });
  next();
}
