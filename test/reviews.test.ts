import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import type { getDelivery, getVersion, PieceType } from "../src/reviews.ts";

type Delivery = ReturnType<typeof getDelivery>;
type Version = ReturnType<typeof getVersion>;
const inputs = {
  script: { content: "Mostrar o produto em uso." },
  video: { url: "https://example.com/video.mp4", duration_seconds: 30 },
  cover: { url: "https://example.com/cover.jpg" },
  caption: { content: "Conheça o produto." },
};

describe("revisão de vídeos", () => {
  let db: DatabaseSync;
  let app: ReturnType<typeof createApp>;
  let time: string;
  let directory: string | undefined;

  beforeEach(() => {
    db = openDatabase();
    time = "2026-10-10T12:00:00.000Z";
    app = createApp(db, () => new Date(time));
  });

  afterEach(() => {
    db.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  function post(path: string, body?: unknown, headers: Record<string, string> = {}) {
    return app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function create(requiredPieces: PieceType[] = ["video"]): Promise<string> {
    const campaignResponse = await post("/campaigns", { name: "Campanha de exemplo", required_pieces: requiredPieces });
    expect(campaignResponse.status).toBe(201);
    const campaign = await campaignResponse.json() as { id: string };
    const response = await post("/deliveries", { campaign_id: campaign.id, creator_id: "crt_ana" });
    expect(response.status).toBe(201);
    return (await response.json() as Delivery).id;
  }

  async function submit(deliveryId: string, type: PieceType = "video", input = inputs[type]): Promise<Version> {
    const response = await post(`/deliveries/${deliveryId}/pieces/${type}/versions`, input);
    expect(response.status).toBe(201);
    return response.json() as Promise<Version>;
  }

  async function approve(versionId: string): Promise<Version> {
    const response = await post(`/versions/${versionId}/approve`);
    expect(response.status).toBe(200);
    return response.json() as Promise<Version>;
  }

  async function read(id: string): Promise<Delivery> {
    const response = await app.request(`/deliveries/${id}`);
    expect(response.status).toBe(200);
    return response.json() as Promise<Delivery>;
  }

  async function readVersion(id: string): Promise<Version> {
    const response = await app.request(`/versions/${id}`);
    expect(response.status).toBe(200);
    return response.json() as Promise<Version>;
  }

  it("aprova uma campanha só de vídeo sem exigir roteiro", async () => {
    const id = await create();
    await approve((await submit(id)).id);
    const delivery = await read(id);
    expect(delivery).toMatchObject({ status: "approved", required_pieces: ["video"], pending_pieces: [] });
    expect((await post(`/deliveries/${id}/approve`)).status).toBe(200);
    expect(await (await app.request(`/campaigns/${delivery.campaign_id}`)).json())
      .toMatchObject({ required_pieces: ["video"] });
  });

  it("retorna as peças ausentes e sem aprovação sem aprovar nada por engano", async () => {
    const id = await create(["video", "cover"]);
    const video = await submit(id);
    const before = await read(id);
    const response = await post(`/deliveries/${id}/approve`);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "entrega tem peças obrigatórias pendentes",
      pending_pieces: [
        { piece_type: "video", reason: "not_approved" },
        { piece_type: "cover", reason: "missing" },
      ],
    });
    expect(await read(id)).toEqual(before);
    await approve(video.id);
    expect(await read(id)).toMatchObject({
      status: "in_production", pending_pieces: [{ piece_type: "cover", reason: "missing" }],
    });
    await submit(id, "cover");
    expect(await (await post(`/deliveries/${id}/approve`)).json()).toMatchObject({
      pending_pieces: [{ piece_type: "cover", reason: "not_approved" }],
    });
  });

  it("aprova uma entrega com as quatro peças e preserva texto e URLs", async () => {
    const types: PieceType[] = ["script", "video", "cover", "caption"];
    const id = await create(types);
    for (const type of types) {
      const version = await submit(id, type);
      expect(version).toMatchObject({ ...inputs[type], number: 1, status: "pending" });
      await approve(version.id);
    }
    expect(await read(id)).toMatchObject({ status: "approved", pending_pieces: [] });
    expect((await post(`/deliveries/${id}/approve`)).status).toBe(200);
  });

  it.each(["video", "cover"] as const)("uma nova versão de %s desfaz a aprovação até ser revisada", async (type) => {
    const id = await create(["video", "cover"]);
    const video = await submit(id);
    const cover = await submit(id, "cover");
    const old = await approve(type === "video" ? video.id : cover.id);
    const unchanged = await approve(type === "video" ? cover.id : video.id);
    expect((await read(id)).status).toBe("approved");

    time = "2026-10-11T12:00:00.000Z";
    const current = await submit(id, type);
    expect(current).toMatchObject({ number: 2, status: "pending", approved_at: null });
    expect(await read(id)).toMatchObject({
      status: "in_production", pending_pieces: [{ piece_type: type, reason: "not_approved" }],
    });
    expect((await post(`/deliveries/${id}/approve`)).status).toBe(409);
    expect((await post(`/versions/${old.id}/approve`)).status).toBe(409);
    expect(await readVersion(old.id)).toEqual(old);
    expect(await readVersion(unchanged.id)).toEqual(unchanged);

    const approved = await approve(current.id);
    const result = await read(id);
    expect(result.status).toBe("approved");
    expect(result.pieces.find((piece) => piece.type === type)).toMatchObject({
      current_version: 2, versions: [old, approved],
    });
  });

  it("não bloqueia por peça opcional, nem por uma nova versão dela", async () => {
    const id = await create();
    const optional = await submit(id, "cover");
    await approve((await submit(id)).id);
    expect((await read(id)).status).toBe("approved");
    await approve(optional.id);
    await submit(id, "cover");
    const result = await read(id);
    expect(result).toMatchObject({ status: "approved", pending_pieces: [] });
    expect(result.pieces.find((piece) => piece.type === "cover"))
      .toMatchObject({ required: false, current_version: 2, status: "pending" });
    expect((await post(`/deliveries/${id}/approve`)).status).toBe(200);
  });

  it("substitui uma versão pendente e rejeita sua aprovação atrasada", async () => {
    const id = await create();
    const first = await submit(id);
    const second = await submit(id);
    expect((await post(`/versions/${first.id}/approve`)).status).toBe(409);
    expect(await readVersion(first.id)).toMatchObject({ status: "pending" });
    await approve(second.id);
    expect((await read(id)).status).toBe("approved");
  });

  it("não renova a data ao repetir a aprovação da versão atual", async () => {
    const version = await submit(await create());
    const firstApproval = await approve(version.id);
    time = "2026-10-12T12:00:00.000Z";
    expect(await approve(version.id)).toEqual(firstApproval);
  });

  it("repete um envio sem criar outra versão nem desfazer sua aprovação", async () => {
    const id = await create();
    const path = `/deliveries/${id}/pieces/video/versions`;
    const headers = { "Idempotency-Key": "video-1" };
    const response = await post(path, inputs.video, headers);
    expect(response.status).toBe(201);
    const version = await response.json() as Version;
    await approve(version.id);
    await post(`/versions/${version.id}/comments`, { second: 12, text: "Rever a embalagem." });
    const before = await read(id);

    time = "2026-10-12T12:00:00.000Z";
    const repeated = await post(path, { duration_seconds: 30, url: ` ${inputs.video.url} ` }, headers);
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual(await readVersion(version.id));
    expect(await read(id)).toEqual(before);
    expect(before.status).toBe("approved");

    const nextResponse = await post(path, inputs.video, { "Idempotency-Key": "video-2" });
    expect(nextResponse.status).toBe(201);
    expect(await nextResponse.json()).toMatchObject({ number: 2, status: "pending" });
    const afterNewVersion = await read(id);
    const lateRetry = await post(path, inputs.video, headers);
    expect(lateRetry.status).toBe(200);
    expect(await lateRetry.json()).toMatchObject({ id: version.id, number: 1 });
    expect(await read(id)).toEqual(afterNewVersion);
    expect(afterNewVersion.status).toBe("in_production");
  });

  it.each([
    ["video", { ...inputs.video, url: "https://example.com/outro.mp4" }],
    ["video", { ...inputs.video, duration_seconds: 31 }],
    ["script", { content: "Outro roteiro." }],
  ] as const)("rejeita a mesma chave com dados diferentes de %s", async (type, input) => {
    const id = await create([type]);
    const path = `/deliveries/${id}/pieces/${type}/versions`;
    const headers = { "Idempotency-Key": "envio-1" };
    const first = await post(path, inputs[type], headers);
    expect(first.status).toBe(201);
    await approve((await first.json() as Version).id);
    const before = await read(id);
    const response = await post(path, input, headers);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "chave de idempotência já usada com dados diferentes" });
    expect(await read(id)).toEqual(before);
    expect((await post(path, inputs[type], headers)).status).toBe(200);
  });

  it("isola a chave por entrega e tipo de peça", async () => {
    const firstId = await create();
    const secondId = await create();
    const headers = { "Idempotency-Key": "envio-1" };
    const versions: string[] = [];
    for (const [id, type] of [[firstId, "video"], [firstId, "cover"], [secondId, "video"]] as const) {
      const path = `/deliveries/${id}/pieces/${type}/versions`;
      const response = await post(path, inputs[type], headers);
      expect(response.status).toBe(201);
      const version = await response.json() as Version;
      expect(version.number).toBe(1);
      versions.push(version.id);
      const repeated = await post(path, inputs[type], headers);
      expect(repeated.status).toBe(200);
      expect(await repeated.json()).toEqual(version);
    }
    expect(new Set(versions).size).toBe(3);
  });

  it("rejeita chave vazia e permite corrigir um envio inválido com a mesma chave", async () => {
    const id = await create();
    const path = `/deliveries/${id}/pieces/video/versions`;
    const empty = await post(path, inputs.video, { "Idempotency-Key": " " });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: "Idempotency-Key não pode ser vazio" });
    const headers = { "Idempotency-Key": "envio-1" };
    expect((await post(path, { ...inputs.video, duration_seconds: 0 }, headers)).status).toBe(400);
    expect((await read(id)).pieces[0].versions).toEqual([]);
    const response = await post(path, inputs.video, headers);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ number: 1 });
  });

  it("mantém comentários na versão original, inclusive comentários feitos depois da substituição", async () => {
    const id = await create();
    const first = await submit(id);
    expect((await post(`/versions/${first.id}/comments`, { second: 12.5, text: "Mostrar a embalagem." })).status).toBe(201);
    await approve(first.id);
    const second = await submit(id, "video", { ...inputs.video, duration_seconds: 5 });
    expect((await post(`/versions/${first.id}/comments`, { second: 20, text: "Rever o final da v1." })).status).toBe(201);
    expect((await post(`/versions/${second.id}/comments`, { second: 12.5, text: "Fora da v2." })).status).toBe(400);
    expect((await readVersion(first.id)).comments).toMatchObject([
      { version_id: first.id, second: 12.5, text: "Mostrar a embalagem." },
      { version_id: first.id, second: 20, text: "Rever o final da v1." },
    ]);
    expect((await readVersion(second.id)).comments).toEqual([]);
    const result = await read(id);
    expect(result.status).toBe("in_production");
    expect(result.pieces[0].versions.map((version) => version.comments.length)).toEqual([2, 0]);
  });

  it("valida o segundo pela duração da versão comentada e não muda a aprovação", async () => {
    const version = await submit(await create());
    await approve(version.id);
    for (const second of [0, 30]) {
      expect((await post(`/versions/${version.id}/comments`, { second, text: "Comentário no limite." })).status).toBe(201);
    }
    for (const second of [-1, 30.1, "12", null]) {
      const response = await post(`/versions/${version.id}/comments`, { second, text: "Inválido." });
      expect(response.status).toBe(400);
    }
    expect((await readVersion(version.id)).comments).toHaveLength(2);
    expect((await read(version.delivery_id)).status).toBe("approved");
  });

  it("rejeita comentário vazio e comentário por segundo em outra peça", async () => {
    const id = await create();
    const video = await submit(id);
    const cover = await submit(id, "cover");
    expect((await post(`/versions/${video.id}/comments`, { second: 1, text: " " })).status).toBe(400);
    expect((await post(`/versions/${cover.id}/comments`, { second: 1, text: "Comentário." })).status).toBe(400);
  });

  it.each([
    { required: [] },
    { required: ["video", "video"] },
    { required: ["audio"] },
    { required: "video" },
  ])("rejeita lista inválida de peças: $required", async ({ required }) => {
    expect((await post("/campaigns", { name: "Campanha", required_pieces: required })).status).toBe(400);
    expect(db.prepare("SELECT COUNT(*) AS count FROM campaigns").get()).toEqual({ count: 0 });
  });

  it.each([
    ["video", { url: "https://example.com/video.mp4", duration_seconds: 0 }],
    ["video", { url: "https://example.com/video.mp4" }],
    ["cover", { url: "javascript:alert(1)" }],
    ["cover", { url: "endereço inválido" }],
    ["caption", { content: " " }],
    ["audio", { url: "https://example.com/audio.mp3" }],
  ])("rejeita dados inválidos de %s sem criar uma versão", async (type, input) => {
    const id = await create();
    expect((await post(`/deliveries/${id}/pieces/${type}/versions`, input)).status).toBe(400);
    expect((await read(id)).pieces[0].versions).toEqual([]);
  });

  it("retorna 400 para JSON malformado", async () => {
    const response = await app.request("/campaigns", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "corpo deve ser um objeto JSON" });
  });

  it("retorna 404 para campanha, entrega e versão inexistentes", async () => {
    expect((await post("/deliveries", { campaign_id: "missing", creator_id: "crt_ana" })).status).toBe(404);
    expect((await post("/deliveries/missing/pieces/video/versions", inputs.video)).status).toBe(404);
    expect((await post("/deliveries/missing/approve")).status).toBe(404);
    expect((await post("/versions/missing/approve")).status).toBe(404);
    expect((await post("/versions/missing/comments", { second: 1, text: "Comentário." })).status).toBe(404);
    for (const path of ["campaigns", "deliveries", "versions"]) {
      expect((await app.request(`/${path}/missing`)).status).toBe(404);
    }
  });

  it("mantém versões e aprovações isoladas entre entregas da mesma campanha", async () => {
    const firstId = await create();
    const first = await read(firstId);
    const response = await post("/deliveries", { campaign_id: first.campaign_id, creator_id: "crt_bruno" });
    const second = await response.json() as Delivery;
    const firstVersion = await submit(firstId);
    const secondVersion = await submit(second.id);
    expect(secondVersion.number).toBe(1);
    await approve(firstVersion.id);
    expect((await read(second.id)).status).toBe("in_production");
    await submit(second.id);
    expect((await read(firstId)).status).toBe("approved");
  });

  it("preserva versões, comentários, pendências e chaves ao reabrir o banco", async () => {
    directory = mkdtempSync(join(tmpdir(), "conty-video-review-"));
    const path = join(directory, "reviews.sqlite");
    db.close();
    db = openDatabase(path);
    app = createApp(db, () => new Date(time));
    const id = await create(["video", "cover"]);
    const first = await submit(id);
    await post(`/versions/${first.id}/comments`, { second: 12, text: "Comentário da primeira versão." });
    await approve(first.id);
    await approve((await submit(id, "cover")).id);
    const versionPath = `/deliveries/${id}/pieces/video/versions`;
    const headers = { "Idempotency-Key": "video-2" };
    const response = await post(versionPath, inputs.video, headers);
    expect(response.status).toBe(201);
    const next = await response.json() as Version;
    const before = await read(id);
    db.close();
    db = openDatabase(path);
    app = createApp(db, () => new Date(time));
    expect(await read(id)).toEqual(before);
    await approve(next.id);
    const approved = await read(id);
    expect(approved.status).toBe("approved");
    const repeated = await post(versionPath, inputs.video, headers);
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual(await readVersion(next.id));
    expect(await read(id)).toEqual(approved);
  });
});
