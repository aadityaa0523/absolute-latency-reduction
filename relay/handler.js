// Lambda entry point (Node.js 22, response streaming via a function URL).
import { serve } from './serve.js';
import { loadWorkload } from './workload.js';
import { bedrockProvider } from './providers/bedrock.js';
import { dynamoCache, MemoryCache } from './cache.js';

const region = process.env.AWS_REGION;
const deps = {
  region,
  workload: await loadWorkload(),
  provider: await bedrockProvider(region),
  cache: process.env.CACHE_TABLE ? await dynamoCache(process.env.CACHE_TABLE, region) : new MemoryCache(),
};

export const handler = awslambda.streamifyResponse(async (event, stream) => {
  let out = stream;
  const sink = {
    head: (statusCode, headers) => { out = awslambda.HttpResponseStream.from(stream, { statusCode, headers }); },
    write: (s) => out.write(s),
    end: () => out.end(),
  };
  const raw = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '';
  await serve({ method: event.requestContext?.http?.method ?? 'GET', rawBody: raw }, sink, deps);
});
