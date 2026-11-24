import { promises as fs } from "fs";
import { homedir } from "os";
import { join } from "path";
import { NextResponse } from "next/server";
import {
  flattenModelsDevCatalog,
  recommendModelCatalogPreset,
  searchModelCatalog,
  type ModelCatalogEntry,
} from "@/lib/model-catalog";
import { createRefreshingCache } from "@/lib/refreshing-cache";

export const dynamic = "force-dynamic";

const MODELS_DEV_URL = "https://models.dev/api.json";
/** This fork reads a local copy first (see loadCatalogRaw); models.dev over the network otherwise. */
const LOCAL_CATALOG_PATH = join(homedir(), ".pi", "models.dev.json");
const CATALOG_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

/** The catalog as published: a local `~/.pi/models.dev.json` when there is one, else models.dev itself. */
async function loadCatalogRaw(): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(LOCAL_CATALOG_PATH, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const response = await fetch(MODELS_DEV_URL, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
    return await response.json();
  }
}

async function fetchCatalog(): Promise<ModelCatalogEntry[]> {
  const entries = flattenModelsDevCatalog(await loadCatalogRaw());
  if (entries.length === 0) throw new Error("models.dev returned an empty catalog");
  return entries;
}

const loadCatalog = createRefreshingCache("pi-web:models-dev-catalog", CATALOG_TTL_MS, fetchCatalog);

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const query = (searchParams.get("q") ?? "").slice(0, 120);
  const provider = (searchParams.get("provider") ?? "").slice(0, 120);
  const baseUrl = (searchParams.get("baseUrl") ?? "").slice(0, 500);
  const parsedLimit = Number.parseInt(searchParams.get("limit") ?? "50", 10);
  const limit = Number.isFinite(parsedLimit) ? parsedLimit : 50;

  try {
    const entries = await loadCatalog();
    const models = searchModelCatalog(entries, query, provider, limit);
    const recommendation = recommendModelCatalogPreset(entries, query, provider, baseUrl);
    return NextResponse.json({ models, recommendation, source: MODELS_DEV_URL });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
