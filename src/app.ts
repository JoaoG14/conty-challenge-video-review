import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { Context } from "hono";
import {
  addComment, approveDelivery, approveVersion, createCampaign, createDelivery,
  getCampaign, getDelivery, getVersion, pieceTypes, ReviewError, submitVersion,
} from "./reviews.ts";
import type { PieceType } from "./reviews.ts";

async function readBody(c: Context): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ReviewError("corpo deve ser um objeto JSON", 400);
  }
  return body as Record<string, unknown>;
}

function requiredText(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) throw new ReviewError(`${field} é obrigatório`, 400);
  return value.trim();
}

function nonNegativeNumber(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ReviewError(`${field} deve ser um número finito maior ou igual a zero`, 400);
  }
  return value;
}

function pieceType(value: unknown): PieceType {
  if (typeof value !== "string" || !pieceTypes.includes(value as PieceType)) {
    throw new ReviewError("tipo de peça deve ser script, video, cover ou caption", 400);
  }
  return value as PieceType;
}

function requiredPieces(value: unknown): PieceType[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ReviewError("required_pieces deve ser uma lista não vazia", 400);
  }
  const types = value.map(pieceType);
  if (new Set(types).size !== types.length) throw new ReviewError("required_pieces não pode repetir peças", 400);
  return types;
}

function mediaUrl(body: Record<string, unknown>): string {
  const value = requiredText(body, "url");
  const protocol = URL.parse(value)?.protocol;
  if (protocol !== "http:" && protocol !== "https:") {
    throw new ReviewError("url deve ser um endereço HTTP ou HTTPS válido", 400);
  }
  return value;
}

export function createApp(db: DatabaseSync, now: () => Date = () => new Date()) {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof ReviewError) {
      return c.json({ error: error.message, pending_pieces: error.pending_pieces }, error.status);
    }
    console.error(error);
    return c.json({ error: "erro interno" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/campaigns", async (c) => {
    const body = await readBody(c);
    return c.json(createCampaign(db, requiredText(body, "name"), requiredPieces(body.required_pieces), now()), 201);
  });
  app.get("/campaigns/:id", (c) => c.json(getCampaign(db, c.req.param("id"))));

  app.post("/deliveries", async (c) => {
    const body = await readBody(c);
    return c.json(createDelivery(db, requiredText(body, "campaign_id"), requiredText(body, "creator_id"), now()), 201);
  });
  app.get("/deliveries/:id", (c) => c.json(getDelivery(db, c.req.param("id"))));
  app.post("/deliveries/:id/approve", (c) => c.json(approveDelivery(db, c.req.param("id"))));

  app.post("/deliveries/:id/pieces/:type/versions", async (c) => {
    const body = await readBody(c);
    const type = pieceType(c.req.param("type"));
    const idempotencyKey = c.req.header("Idempotency-Key")?.trim() ?? null;
    if (idempotencyKey === "") throw new ReviewError("Idempotency-Key não pode ser vazio", 400);
    let content: string | null = null;
    let url: string | null = null;
    let duration: number | null = null;
    if (type === "script" || type === "caption") {
      content = requiredText(body, "content");
    } else {
      url = mediaUrl(body);
      if (type === "video") {
        duration = nonNegativeNumber(body, "duration_seconds");
        if (duration === 0) throw new ReviewError("duration_seconds deve ser maior que zero", 400);
      }
    }
    const result = submitVersion(db, c.req.param("id"), type, {
      content, url, duration_seconds: duration,
    }, now(), idempotencyKey);
    return c.json(result.version, result.repeated ? 200 : 201);
  });

  app.get("/versions/:id", (c) => c.json(getVersion(db, c.req.param("id"))));
  app.post("/versions/:id/approve", (c) => c.json(approveVersion(db, c.req.param("id"), now())));
  app.post("/versions/:id/comments", async (c) => {
    const body = await readBody(c);
    return c.json(addComment(db, c.req.param("id"), {
      second: nonNegativeNumber(body, "second"), text: requiredText(body, "text"),
    }, now()), 201);
  });

  return app;
}
