// ============================================================
// Sincronização de avaliações do Google via Outscraper
// Super Carros Gramado — BI Avaliações
//
// Roda dentro do GitHub Actions (repo já clonado no workspace).
// Lê reviews.json, busca avaliações novas na API do Outscraper
// (só as mais recentes que o já sincronizado, pra economizar
// créditos), faz merge e regrava reviews.json. O commit/push é
// feito por um passo separado no workflow.
// ============================================================

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import crypto from "node:crypto";

const OUTSCRAPER_API_KEY = process.env.OUTSCRAPER_API_KEY;
const PLACE_QUERY = process.env.PLACE_QUERY;
const REVIEWS_PATH = process.env.REVIEWS_PATH || "reviews.json";
const REVIEWS_LIMIT = parseInt(process.env.REVIEWS_LIMIT || "150", 10);
const DEBUG = process.env.DEBUG === "true";

// Backfill manual: quando IGNORE_CUTOFF=true, ignora a data de corte e busca
// as REVIEWS_LIMIT avaliações mais recentes do zero (mesmo se já existirem
// avaliações sincronizadas). Usado só quando alguém dispara o workflow
// manualmente preenchendo "backfill_limit" — a rodada agendada de todo dia
// nunca liga essa opção, então o consumo diário automático continua igual.
const IGNORE_CUTOFF = process.env.IGNORE_CUTOFF === "true";

if (!OUTSCRAPER_API_KEY) {
  console.error("Faltou o secret OUTSCRAPER_API_KEY.");
  process.exit(1);
}
if (!PLACE_QUERY) {
  console.error("Faltou a variável PLACE_QUERY (link ou ID do Google Maps).");
  process.exit(1);
}

// ---------- Utilidades ----------

function hashId(...parts) {
  return crypto.createHash("sha1").update(parts.join("|")).digest("hex").substring(0, 20);
}

function pickReviewId(raw) {
  return (
    raw.review_id ||
    raw.id ||
    hashId(raw.review_link || "", raw.author_id || raw.author_title || "", raw.review_datetime_utc || raw.review_timestamp || "")
  );
}

function pickAuthorName(raw) {
  return raw.author_title || raw.author_name || raw.name || "Desconhecido";
}

function pickRating(raw) {
  const r = raw.review_rating ?? raw.rating ?? null;
  return r === null ? null : Number(r);
}

function pickText(raw) {
  return raw.review_text || raw.text || raw.snippet || "";
}

function pickReviewTime(raw) {
  // Outscraper costuma trazer review_datetime_utc como string ISO,
  // ou review_timestamp como epoch (segundos). Tentamos os dois.
  if (raw.review_datetime_utc) {
    const d = new Date(raw.review_datetime_utc);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  if (raw.review_timestamp) {
    const d = new Date(Number(raw.review_timestamp) * 1000);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

function extractReviewsFromResponse(json) {
  // A API pode devolver formatos ligeiramente diferentes dependendo do
  // modo (síncrono/assíncrono). Tentamos cobrir os formatos mais comuns.
  let places = json;
  if (json && Array.isArray(json.data)) places = json.data;
  if (!Array.isArray(places)) {
    if (DEBUG) console.log("Resposta bruta (não veio como lista):", JSON.stringify(json).substring(0, 2000));
    return [];
  }

  const allReviews = [];
  places.forEach(place => {
    const reviews = place.reviews_data || place.reviews || [];
    reviews.forEach(r => allReviews.push(r));
  });
  return allReviews;
}

// ---------- Outscraper ----------

async function fetchReviews(cutoffUnixSeconds) {
  const params = new URLSearchParams({
    query: PLACE_QUERY,
    reviewsLimit: String(REVIEWS_LIMIT),
    sort: "newest",
    async: "false"
  });
  if (cutoffUnixSeconds) params.set("cutoff", String(cutoffUnixSeconds));

  const url = `https://api.app.outscraper.com/maps/reviews-v3?${params.toString()}`;
  console.log("Chamando Outscraper:", url.replace(PLACE_QUERY, "[PLACE_QUERY]"));

  const res = await fetch(url, {
    headers: { "X-API-KEY": OUTSCRAPER_API_KEY }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Outscraper respondeu HTTP ${res.status}: ${body.substring(0, 500)}`);
  }

  let json = await res.json();

  // Modo assíncrono: a API às vezes devolve um "task" com results_location
  // pra consultar depois, em vez do resultado direto.
  if (json && json.status && json.status !== "Success" && json.results_location) {
    console.log("Resposta assíncrona detectada, aguardando processamento...");
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const pollRes = await fetch(json.results_location, {
        headers: { "X-API-KEY": OUTSCRAPER_API_KEY }
      });
      const pollJson = await pollRes.json();
      if (pollJson.status === "Success") {
        json = pollJson;
        break;
      }
      if (i === 9) throw new Error("Tempo esgotado esperando o resultado assíncrono do Outscraper.");
    }
  }

  if (DEBUG) console.log("Resposta completa (debug):", JSON.stringify(json).substring(0, 3000));

  return extractReviewsFromResponse(json);
}

// ---------- Main ----------

async function main() {
  let existing = [];
  if (existsSync(REVIEWS_PATH)) {
    const raw = await readFile(REVIEWS_PATH, "utf-8");
    existing = raw.trim() ? JSON.parse(raw) : [];
  }

  console.log(`Reviews já sincronizadas: ${existing.length}`);

  // cutoff: pega a mais recente já sincronizada, com 2 dias de folga
  // (evita perder avaliações por causa de fuso/latência da API)
  let cutoffUnixSeconds = null;
  if (IGNORE_CUTOFF) {
    console.log(`Backfill manual: ignorando cutoff, buscando as ${REVIEWS_LIMIT} avaliações mais recentes do zero.`);
  } else if (existing.length > 0) {
    const maxTime = existing
      .map(r => (r.review_time ? new Date(r.review_time).getTime() : 0))
      .reduce((a, b) => Math.max(a, b), 0);
    if (maxTime > 0) {
      cutoffUnixSeconds = Math.floor(maxTime / 1000) - 2 * 24 * 60 * 60;
    }
  }

  const rawReviews = await fetchReviews(cutoffUnixSeconds);
  console.log(`Avaliações recebidas do Outscraper nesta rodada: ${rawReviews.length}`);

  const existingIds = new Set(existing.map(r => r.review_id));
  let addedCount = 0;

  rawReviews.forEach(raw => {
    const review_id = pickReviewId(raw);
    if (existingIds.has(review_id)) return;

    existing.push({
      review_id,
      author_name: pickAuthorName(raw),
      rating: pickRating(raw),
      review_text: pickText(raw),
      review_time: pickReviewTime(raw)
    });
    existingIds.add(review_id);
    addedCount++;
  });

  existing.sort((a, b) => (b.review_time || "").localeCompare(a.review_time || ""));

  await writeFile(REVIEWS_PATH, JSON.stringify(existing, null, 2) + "\n", "utf-8");

  console.log(`Novas avaliações adicionadas: ${addedCount}`);
  console.log(`Total em reviews.json agora: ${existing.length}`);

  // Expõe pro workflow saber se precisa comitar
  if (process.env.GITHUB_OUTPUT) {
    await writeFile(process.env.GITHUB_OUTPUT, `added_count=${addedCount}\n`, { flag: "a" });
  }
}

main().catch(err => {
  console.error("Erro na sincronização:", err);
  process.exit(1);
});
