import assert from "node:assert/strict";
import { createApp } from "./app.ts";
import { openDatabase } from "./db.ts";
import type { getDelivery, getVersion } from "./reviews.ts";

type Delivery = ReturnType<typeof getDelivery>;
type Version = ReturnType<typeof getVersion>;
const db = openDatabase();
const app = createApp(db);

async function request<T = unknown>(method: string, path: string, status: number, body?: unknown): Promise<T> {
  const response = await app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
  return data as T;
}

async function showDelivery(id: string, step: string, expected: Delivery["status"]) {
  const delivery = await request<Delivery>("GET", `/deliveries/${id}`, 200);
  assert.equal(delivery.status, expected);
  console.log(`${step}: ${delivery.status}`);
  for (const pending of delivery.pending_pieces) {
    console.log(`   Pendente: ${pending.piece_type} (${pending.reason})`);
  }
}

try {
  const campaign = await request<{ id: string }>("POST", "/campaigns", 201, {
    name: "Demonstração", required_pieces: ["video", "cover"],
  });
  const delivery = await request<Delivery>("POST", "/deliveries", 201, {
    campaign_id: campaign.id, creator_id: "crt_ana",
  });
  console.log("1. Campanha criada: exige vídeo e capa.");

  const video = await request<Version>("POST", `/deliveries/${delivery.id}/pieces/video/versions`, 201, {
    url: "https://example.com/video-v1.mp4", duration_seconds: 30,
  });
  await request("POST", `/versions/${video.id}/comments`, 201, { second: 12, text: "Mostrar a embalagem." });
  await request("POST", `/versions/${video.id}/approve`, 200);
  const blocked = await request<{ pending_pieces: Delivery["pending_pieces"] }>("POST", `/deliveries/${delivery.id}/approve`, 409);
  assert.deepEqual(blocked.pending_pieces, [{ piece_type: "cover", reason: "missing" }]);
  console.log("2. Vídeo v1 aprovado, mas falta a capa: aprovar a entrega retorna HTTP 409.");

  const cover = await request<Version>("POST", `/deliveries/${delivery.id}/pieces/cover/versions`, 201, {
    url: "https://example.com/cover.jpg",
  });
  await request("POST", `/versions/${cover.id}/approve`, 200);
  await request("POST", `/deliveries/${delivery.id}/approve`, 200);
  await showDelivery(delivery.id, "3. Capa aprovada, entrega completa", "approved");

  const next = await request<Version>("POST", `/deliveries/${delivery.id}/pieces/video/versions`, 201, {
    url: "https://example.com/video-v2.mp4", duration_seconds: 20,
  });
  await showDelivery(delivery.id, "4. Vídeo v2 enviado, aprovação desfeita", "in_production");
  await request("POST", `/deliveries/${delivery.id}/approve`, 409);

  const oldVersion = await request<Version>("GET", `/versions/${video.id}`, 200);
  assert.equal(oldVersion.comments.length, 1);
  assert.equal(oldVersion.comments[0].second, 12);
  assert.deepEqual(next.comments, []);
  console.log("5. O comentário no segundo 12 continua na v1. A v2 não tem comentários.");

  await request("POST", `/versions/${next.id}/approve`, 200);
  await showDelivery(delivery.id, "6. Vídeo v2 aprovado, aprovação restaurada", "approved");
} finally {
  db.close();
}
