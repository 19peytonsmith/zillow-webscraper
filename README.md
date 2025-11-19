# Next.js Serverless Zillow Scraper

This repository contains a Next.js serverless route that scrapes a random Zillow property and (optionally) persists structured JSON to MongoDB.

It is used in conjunction with [PropertyGuessr](https://propertyguessr.vercel.app/)'s property info fetching on it's backend.

#### What this repo contains

- `src/app/api/property_info/route.ts` server-side TypeScript route that fetches a random Zillow listing, parses images/price/beds/baths/address, and inserts the result into MongoDB when configured.
- `src/lib/mongodb.ts` MongoDB connection helper used by the route.
- `src/app/api/property_info/cities.txt` newline list of Zillow city slugs used by the scraper.
- `vercel.json` Vercel configuration with a cron set to call `/api/property_info` every 10 minutes.

Quick run (local)

1. Install dependencies:

```powershell
npm install
```

2. Create a `.env` file in the project root with at least:

```properties
MONGODB_URI=<your mongodb connection string>
MONGODB_DB_NAME=<your db name>
```

3. Start the dev server:

```powershell
npm run dev
```

4. Hit the route:

```powershell
curl http://localhost:3000/api/property_info
```
