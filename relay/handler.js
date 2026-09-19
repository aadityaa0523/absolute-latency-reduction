// Lambda entry point (Node.js 22, response streaming via a function URL).
import { serve, isWarmEvent } from './serve.js';
import { loadWorkload } from './workload.js';
import { bedrockProvider } from './providers/bedrock.js';
import { dynamoCache, MemoryCache } from './cache.js';
import { loadWeb } from './web.js';
import { DEFAULT_TIERS } from './core.js';
import { MODELS } from './models.js';

const region = process.env.AWS_REGION;
const tiers = { fast: process.env.TIER_FAST ?? DEFAULT_TIERS.fast, strong: process.env.TIER_STRONG ?? DEFAULT_TIERS.strong };
for (const [tier, handle] of Object.entries(tiers)) if (!MODELS[handle]) throw new Error(`TIER_${tier.toUpperCase()} "${handle}" is not an allowlisted model`);
const deps = {
  region,
  tiers,
  budgetMs: Number(process.env.BUDGET_MS ?? 2500),
  web: await loadWeb(),
  workload: await loadWorkload(),
  provider: await bedrockProvider(region),
  cache: process.env.CACHE_TABLE ? await dynamoCache(process.env.CACHE_TABLE, region) : new MemoryCache(),
};

export const handler = awslambda.streamifyResponse(async (event, stream) => {
  if (isWarmEvent(event)) { stream.end(); return; }
  let out = stream;
  const sink = {
    head: (statusCode, headers) => { out = awslambda.HttpResponseStream.from(stream, { statusCode, headers }); },
    write: (s) => out.write(s),
    end: () => out.end(),
  };
  const raw = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '';
  await serve({ method: event.requestContext?.http?.method ?? 'GET', path: event.rawPath ?? '/', rawBody: raw }, sink, deps);
});
