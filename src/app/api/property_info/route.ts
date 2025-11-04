import { NextResponse } from "next/server";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { connectToDatabase } from "../../../lib/mongodb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

// Simple in-memory rate-limiting: if this endpoint is hit more than once
// within RATE_LIMIT_WINDOW_MS, the request will be rejected and the Zillow
// scraping logic will not run. This is sufficient for a cron job that runs
// every 15 minutes; it avoids accidental duplicate runs within a short window.
let lastRequestAt = 0;
const RATE_LIMIT_WINDOW_MS = 5_000; // 5 seconds

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CITIES_PATH = path.join(process.cwd(), "public", "cities.txt");

const UA =
  "Mozilla/5.0 (Linux; Android 8.0.0; SM-G960F Build/R16NW) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/62.0.3202.84 Mobile Safari/537.36";

const DEFAULT_HEADERS = {
  "user-agent": UA,
  referer: "https://www.google.com/",
} as const;

type PropertyInfo = {
  urls: string[];
  value: number;
  beds: string;
  baths: string;
  square_footage: string;
  address: string;
  city_state_zipcode: string;
  // detailUrl points to the Zillow property detail page (external)
  detailUrl?: string;
};

async function readCities(): Promise<string[]> {
  try {
    const raw = await fs.readFile(CITIES_PATH, "utf8");
    // eslint-disable-next-line no-console
    console.debug(`Loaded cities from ${CITIES_PATH}`);
    return raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (e) {
    throw new Error(`cities list not found at ${CITIES_PATH}`);
  }
}

async function fetchText(
  url: string
): Promise<{ ok: boolean; status: number; text?: string }> {
  try {
    const r = await fetch(url, {
      headers: DEFAULT_HEADERS,
      redirect: "manual",
      cache: "no-store",
    });
    const t = await r.text();
    return { ok: r.ok, status: r.status, text: t };
  } catch {
    return { ok: false, status: 0 };
  }
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function getValidDetailUrl(cities: string[]): Promise<string | null> {
  // Try up to MAX_ATTEMPTS city pages
  const MAX_ATTEMPTS = 8;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const city = pick(cities);
    const cityUrl = `https://www.zillow.com/${city}/`;
    const resp = await fetchText(cityUrl);
    if (!resp.ok || !resp.text) continue;

    const matches = Array.from(
      resp.text.matchAll(
        /"detailUrl":"(https:\/\/www\.zillow\.com\/homedetails\/[^"]+)"/g
      ),
      (m) => m[1]
    );

    if (matches.length) {
      const url = pick(matches);
      return url;
    }
  }
  return null;
}

function parsePropertyInfo(html: string): PropertyInfo | null {
  const imgPattern = /(https?:\/\/[^,\s]+_960\.jpg)/g;
  const urls = Array.from(
    new Set(Array.from(html.matchAll(imgPattern), (m) => m[1]))
  );

  // If there aren't at least 3 images, the result is unlikely to be meaningful for the game.
  if (urls.length <= 2) return null;

  const first = (re: RegExp, s: string, group = 1): string | null => {
    const m = re.exec(s);
    return m ? m[group] : null;
  };

  //    Try a tolerant, single-shot pattern first (covers both "Square Feet" and "sqft")
  //    Example snippets we might see in the page text:
  //    "$375,000 4 bd 2 ba 2,139 sqft ... 4933 W Melody Ln, Laveen, AZ 85339"
  //    "$375,000 4 beds, 2 baths, 2,139 Square Feet ... located at 4933 W Melody Ln, Laveen, AZ 85339"
  const combo =
    /(?<value>\$\d{1,3}(?:,\d{3})*)(?:[^$]{0,120}?)(?<beds>\d+(?:\.\d+)?)\s*(?:bd|beds?)(?:[^$]{0,120}?)(?<baths>\d+(?:\.\d+)?)\s*(?:ba|baths?)(?:[^$]{0,160}?)(?<sqft>[\d,]+)\s*(?:sqft|Square\s*Feet)(?:[^$]{0,200}?)(?<address>\d{1,6}[\w\s\.\-#']+?),(?:\s*)(?<city>[A-Za-z\.\-'\s]+?),(?:\s*)(?<state>[A-Z]{2})\s+(?<zipcode>\d{5})/is;

  const m = html.match(combo);

  let valueStr: string | null = null;
  let bedsStr: string | null = null;
  let bathsStr: string | null = null;
  let sqftStr: string | null = null;
  let address: string | null = null;
  let city: string | null = null;
  let state: string | null = null;
  let zipcode: string | null = null;

  if (m && m.groups) {
    valueStr = m.groups["value"];
    bedsStr = m.groups["beds"];
    bathsStr = m.groups["baths"];
    sqftStr = m.groups["sqft"];
    address = m.groups["address"];
    city = m.groups["city"];
    state = m.groups["state"];
    zipcode = m.groups["zipcode"];
  } else {
    // Fallback: parse fields independently
    // Price like "$375,000"
    valueStr = first(/\$(\d{1,3}(?:,\d{3})*)/i, html);

    // Beds "4 bd" or "4 beds"
    bedsStr = first(/(\d+(?:\.\d+)?)\s*(?:bd|beds?)/i, html);

    // Baths "2 ba" or "2 baths"
    bathsStr = first(/(\d+(?:\.\d+)?)\s*(?:ba|baths?)/i, html);

    // Sqft "2,139 sqft" or "2,139 Square Feet"
    sqftStr = first(/([\d,]+)\s*(?:sqft|Square\s*Feet)/i, html);

    // Address + City, ST ZIP:
    // Try "..., City, ST 12345" first, then prepend the street from <title>.
    // Many Zillow titles look like: "4933 W Melody Ln, Laveen, AZ 85339 | MLS #..."
    const title = first(/<title>([^<]+)<\/title>/i, html);
    const titleAddress = title
      ? first(/^(.+?),\s*[A-Za-z\.\-'\s]+,\s*[A-Z]{2}\s+\d{5}/, title)
      : null;

    const cityStateZip = first(
      /([A-Za-z\.\-'\s]+),\s*([A-Z]{2})\s+(\d{5})/i,
      html
    );
    if (cityStateZip) {
      const parts = /([A-Za-z\.\-'\s]+),\s*([A-Z]{2})\s+(\d{5})/i.exec(html)!;
      city = parts[1].trim();
      state = parts[2].trim();
      zipcode = parts[3].trim();

      // Find a likely street address:
      // Prefer the one from <title>, otherwise heuristically grab something that looks like "number + street"
      address =
        titleAddress ??
        first(
          /(\d{1,6}\s+[A-Za-z0-9\.\-#'\s]+)(?=,\s*[A-Za-z\.\-'\s]+,\s*[A-Z]{2}\s+\d{5})/,
          html
        );
    }

    // Final fallback: if we still don't have an address but we do have a full "Address, City, ST ZIP" in <title>,
    // split it from the title directly.
    if ((!address || !city || !state || !zipcode) && title) {
      const t = /(.+?),\s*([A-Za-z\.\-'\s]+),\s*([A-Z]{2})\s+(\d{5})/.exec(
        title
      );
      if (t) {
        address = address ?? t[1].trim();
        city = city ?? t[2].trim();
        state = state ?? t[3].trim();
        zipcode = zipcode ?? t[4].trim();
      }
    }
  }

  // 4) Validate and assemble
  if (
    !valueStr ||
    !bedsStr ||
    !bathsStr ||
    !sqftStr ||
    !address ||
    !city ||
    !state ||
    !zipcode
  ) {
    return null;
  }

  const value = Number(valueStr.replace(/\$|,/g, ""));
  if (!Number.isFinite(value) || value > 20_000_000) return null;

  const city_state_zipcode = `${city}, ${state} ${zipcode}`;

  return {
    urls,
    value,
    beds: bedsStr,
    baths: bathsStr,
    square_footage: sqftStr,
    address: address,
    city_state_zipcode,
  };
}

export async function GET() {
  // Rate limit: if this endpoint was hit within the last RATE_LIMIT_WINDOW_MS
  // milliseconds, skip performing any scraping or DB work and return 429.
  const now = Date.now();
  if (now - lastRequestAt < RATE_LIMIT_WINDOW_MS) {
    // eslint-disable-next-line no-console
    console.warn(
      `Rate-limited call to /api/property_info (only one allowed per ${RATE_LIMIT_WINDOW_MS}ms)`
    );
    return NextResponse.json(
      { error: "Rate limited. Try again later." },
      { status: 429 }
    );
  }
  // Accept this request and record the time immediately to prevent
  // near-simultaneous duplicate execution.
  lastRequestAt = now;
  // Goal: keep trying until we have a valid parsed property so the caller
  // always receives a successful JSON response. We still guard total time/attempts
  // to avoid infinite loops in case of persistent blocking.
  // Per request: try a limited number of times, then fail loudly (no DB writes).
  const MAX_TOTAL_ATTEMPTS = 5;
  const DELAY_MS = 10_000; // 10 seconds

  // Read cities up front
  let cities: string[];
  try {
    cities = await readCities();
    if (cities.length === 0) throw new Error("cities list is empty");
  } catch (e) {
    // Log the error but return a harmless successful JSON placeholder so callers
    // are not exposed to internal failures.
    // eslint-disable-next-line no-console
    console.error("Failed reading cities.txt:", e);
    return NextResponse.json(
      {
        urls: [],
        value: 0,
        beds: "0",
        baths: "0",
        square_footage: "0",
        address: "Unknown",
        city_state_zipcode: "Unknown",
        detailUrl: "",
      },
      { status: 200 }
    );
  }

  let lastParse: any = null;

  for (let attempt = 1; attempt <= MAX_TOTAL_ATTEMPTS; attempt++) {
    try {
      // 1) Resolve a detail URL (this itself tries a few city pages)
      const detailUrl = await getValidDetailUrl(cities);
      if (!detailUrl) {
        // eslint-disable-next-line no-console
        console.warn(`Attempt ${attempt}: no detail URL found`);
        await new Promise((r) => setTimeout(r, DELAY_MS));
        continue;
      }

      // 2) Fetch detail page
      const detailResp = await fetchText(detailUrl);
      if (!detailResp.ok || !detailResp.text) {
        // eslint-disable-next-line no-console
        console.warn(
          `Attempt ${attempt}: failed to fetch detail page (status ${detailResp.status}) for ${detailUrl}`
        );
        await new Promise((r) => setTimeout(r, DELAY_MS));
        continue;
      }

      // 3) Parse details
      const info = parsePropertyInfo(detailResp.text);
      if (!info) {
        // Keep the last parse for fallback if needed
        lastParse = { detailUrl, raw: undefined };
        // eslint-disable-next-line no-console
        console.warn(
          `Attempt ${attempt}: parse failed or value > $20M for ${detailUrl}`
        );
        await new Promise((r) => setTimeout(r, DELAY_MS));
        continue;
      }

      // Successful parse: attach the detailUrl and persist
      info.detailUrl = detailUrl;

      try {
        const { listings } = await connectToDatabase();
        const now = new Date();
        const doc = {
          ...info,
          detailUrl,
          scraped_at: now,
          version: "1.0",
        } as any;
        const res = await listings.insertOne(doc as any);
        (info as any)._insertedId = res.insertedId?.toString?.();
      } catch (e) {
        // Log DB errors but still return the parsed result
        // eslint-disable-next-line no-console
        console.error("Failed to persist to MongoDB:", e);
      }

      return NextResponse.json(info, { status: 200 });
    } catch (e) {
      // Catch any unexpected attempt-level errors, log and retry
      // eslint-disable-next-line no-console
      console.error(`Attempt ${attempt} - unexpected error:`, e);
      await new Promise((r) => setTimeout(r, DELAY_MS));
      continue;
    }
  }

  // Attempts exhausted: per your request, do NOT write anything to the DB and
  // return an error response so the caller can know the scrape failed.
  // This makes failures explicit after a small, bounded number of retries.
  return NextResponse.json(
    {
      error: `Failed to find a valid property after ${MAX_TOTAL_ATTEMPTS} attempts.`,
    },
    { status: 502 }
  );
}
