import { createHash } from 'node:crypto';

export const normalize = (s) => s.normalize('NFKC').replace(/\s+/g, ' ').trim();

// Every value that can change the answer goes into the key, so a hit is never a stale or foreign answer.
export const cacheKey = (parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

export class MemoryCache {
  #m = new Map();
  async get(k) { return this.#m.get(k) ?? null; }
  async put(k, v) { this.#m.set(k, v); }
}

const TTL_SECONDS = 24 * 3600;

export async function dynamoCache(table, region) {
  const { DynamoDBClient, GetItemCommand, PutItemCommand } = await import('@aws-sdk/client-dynamodb');
  const client = new DynamoDBClient({ region, maxAttempts: 2 });
  return {
    async get(k) {
      const r = await client.send(new GetItemCommand({ TableName: table, Key: { pk: { S: k } } }));
      return r.Item ? JSON.parse(r.Item.value.S) : null;
    },
    async put(k, v) {
      await client.send(new PutItemCommand({
        TableName: table,
        Item: { pk: { S: k }, value: { S: JSON.stringify(v) }, ttl: { N: String(Math.floor(Date.now() / 1000) + TTL_SECONDS) } },
      }));
    },
  };
}
