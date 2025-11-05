import { MongoClient, Db, Collection } from "mongodb";

declare global {
  // eslint-disable-next-line @typescript-eslint/naming-convention
  // allow caching on globalThis in Next.js to reuse the Mongo client between invocations
  // (prevents exhausting Atlas connections during cold-starts)
  // eslint-disable-next-line no-var
  var _mongoClientPromise: Promise<MongoClient> | undefined;
  // eslint-disable-next-line no-var
  var _mongoClient: MongoClient | undefined;
}

export type DbResult = {
  client: MongoClient;
  db: Db;
  listings: Collection;
};

export async function connectToDatabase(): Promise<DbResult> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI environment variable is not set");
  }

  const dbName = process.env.MONGODB_DB_NAME || "zillow_scraper";

  if (!global._mongoClientPromise) {
    // Create a new MongoClient and cache the promise
    const client = new MongoClient(uri, {
      // Recommended options can be added here
    });
    global._mongoClient = client;
    global._mongoClientPromise = client.connect();
  }

  const client = global._mongoClient!;
  // Wait for connect to finish
  await global._mongoClientPromise;

  const db = client.db(dbName);
  const listings = db.collection("listings");

  // Ensure simple indexes to avoid duplicates and enable queries
  try {
    await listings.createIndex({ url: 1 });
    // Ensure detailUrl is unique (sparse to allow older docs without the field)
    await listings.createIndex(
      { detailUrl: 1 },
      { unique: true, sparse: true }
    );
    await listings.createIndex({ scraped_at: -1 });
    await listings.createIndex({ city: 1, state: 1 });
  } catch (e) {
    // Ignore index creation errors in serverless warm starts
    // console.warn('Index creation failed:', e);
  }

  return { client, db, listings };
}

export async function closeClient() {
  if (global._mongoClient) {
    await global._mongoClient.close();
    global._mongoClient = undefined;
    global._mongoClientPromise = undefined;
  }
}
