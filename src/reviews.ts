import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./db.ts";

export const pieceTypes = ["script", "video", "cover", "caption"] as const;
export type PieceType = typeof pieceTypes[number];
type CampaignRow = { id: string; name: string; required_pieces: string; created_at: string };
type DeliveryRow = { id: string; campaign_id: string; creator_id: string; created_at: string };
type VersionInput = { content: string | null; url: string | null; duration_seconds: number | null };
type VersionRow = VersionInput & {
  id: string;
  delivery_id: string;
  piece_type: PieceType;
  number: number;
  status: "pending" | "approved";
  submitted_at: string;
  approved_at: string | null;
};
type CommentRow = { id: string; version_id: string; second: number; text: string; created_at: string };
type PendingPiece = { piece_type: PieceType; reason: "missing" | "not_approved" };

export class ReviewError extends Error {
  constructor(message: string, public status: 400 | 404 | 409, public pending_pieces?: PendingPiece[]) {
    super(message);
  }
}

export function getCampaign(db: DatabaseSync, id: string) {
  const row = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id) as CampaignRow | undefined;
  if (!row) throw new ReviewError("campanha não encontrada", 404);
  return { ...row, required_pieces: JSON.parse(row.required_pieces) as PieceType[] };
}

export function createCampaign(db: DatabaseSync, name: string, requiredPieces: PieceType[], now: Date) {
  const id = randomUUID();
  db.prepare("INSERT INTO campaigns (id, name, required_pieces, created_at) VALUES (?, ?, ?, ?)")
    .run(id, name, JSON.stringify(requiredPieces), now.toISOString());
  return getCampaign(db, id);
}

export function getDelivery(db: DatabaseSync, id: string) {
  const delivery = db.prepare("SELECT * FROM deliveries WHERE id = ?").get(id) as DeliveryRow | undefined;
  if (!delivery) throw new ReviewError("entrega não encontrada", 404);
  const campaign = getCampaign(db, delivery.campaign_id);
  const versions = db.prepare("SELECT * FROM versions WHERE delivery_id = ? ORDER BY number").all(id) as VersionRow[];
  const comments = db.prepare(`
    SELECT comments.* FROM comments JOIN versions ON versions.id = comments.version_id
    WHERE versions.delivery_id = ? ORDER BY comments.rowid
  `).all(id) as CommentRow[];

  const pieces = pieceTypes
    .filter((type) => campaign.required_pieces.includes(type) || versions.some((version) => version.piece_type === type))
    .map((type) => {
      const history = versions.filter((version) => version.piece_type === type).map((version) => ({
        ...version,
        comments: comments.filter((comment) => comment.version_id === version.id),
      }));
      const current = history.at(-1);
      return {
        type,
        required: campaign.required_pieces.includes(type),
        current_version: current?.number ?? null,
        status: current?.status ?? "missing",
        versions: history,
      };
    });
  const pendingPieces: PendingPiece[] = pieces
    .filter((piece) => piece.required && piece.status !== "approved")
    .map((piece) => ({ piece_type: piece.type, reason: piece.status === "missing" ? "missing" : "not_approved" }));

  return {
    ...delivery,
    required_pieces: campaign.required_pieces,
    status: pendingPieces.length === 0 ? "approved" as const : "in_production" as const,
    pending_pieces: pendingPieces,
    pieces,
  };
}

export function createDelivery(db: DatabaseSync, campaignId: string, creatorId: string, now: Date) {
  getCampaign(db, campaignId);
  const id = randomUUID();
  db.prepare("INSERT INTO deliveries (id, campaign_id, creator_id, created_at) VALUES (?, ?, ?, ?)")
    .run(id, campaignId, creatorId, now.toISOString());
  return getDelivery(db, id);
}

export function getVersion(db: DatabaseSync, id: string) {
  const version = db.prepare("SELECT * FROM versions WHERE id = ?").get(id) as VersionRow | undefined;
  if (!version) throw new ReviewError("versão não encontrada", 404);
  const comments = db.prepare("SELECT * FROM comments WHERE version_id = ? ORDER BY rowid").all(id) as CommentRow[];
  return { ...version, comments };
}

export function submitVersion(db: DatabaseSync, deliveryId: string, type: PieceType, input: VersionInput, now: Date) {
  return transaction(db, () => {
    getDelivery(db, deliveryId);
    const current = db.prepare("SELECT MAX(number) AS number FROM versions WHERE delivery_id = ? AND piece_type = ?")
      .get(deliveryId, type) as { number: number | null };
    const id = randomUUID();
    db.prepare(`
      INSERT INTO versions (id, delivery_id, piece_type, number, content, url, duration_seconds, status, submitted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(id, deliveryId, type, (current.number ?? 0) + 1, input.content, input.url, input.duration_seconds, now.toISOString());
    return getVersion(db, id);
  });
}

export function approveVersion(db: DatabaseSync, id: string, now: Date) {
  return transaction(db, () => {
    const version = getVersion(db, id);
    const current = db.prepare("SELECT MAX(number) AS number FROM versions WHERE delivery_id = ? AND piece_type = ?")
      .get(version.delivery_id, version.piece_type) as { number: number };
    if (version.number !== current.number) throw new ReviewError("só a versão atual pode ser aprovada", 409);
    if (version.status === "pending") {
      db.prepare("UPDATE versions SET status = 'approved', approved_at = ? WHERE id = ?")
        .run(now.toISOString(), id);
    }
    return getVersion(db, id);
  });
}

export function approveDelivery(db: DatabaseSync, id: string) {
  const delivery = getDelivery(db, id);
  if (delivery.status !== "approved") {
    throw new ReviewError("entrega tem peças obrigatórias pendentes", 409, delivery.pending_pieces);
  }
  return delivery;
}

export function addComment(db: DatabaseSync, versionId: string, input: { second: number; text: string }, now: Date) {
  const version = getVersion(db, versionId);
  if (version.piece_type !== "video") throw new ReviewError("comentários por segundo são permitidos apenas em vídeos", 400);
  if (input.second > version.duration_seconds!) throw new ReviewError("segundo do comentário ultrapassa a duração do vídeo", 400);
  const comment = { id: randomUUID(), version_id: versionId, ...input, created_at: now.toISOString() };
  db.prepare("INSERT INTO comments (id, version_id, second, text, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(comment.id, comment.version_id, comment.second, comment.text, comment.created_at);
  return comment;
}
