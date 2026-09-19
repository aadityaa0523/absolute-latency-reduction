// Allowlist of models the public endpoint may call. Clients send the handle, never a raw model id,
// so a stranger with the URL cannot point the relay at an expensive model.
// cache: 'explicit' = accepts a cachePoint; 'implicit' = the service caches on its own; 'none' = no prompt cache.
// Availability from `aws bedrock list-foundation-models` in ap-south-1 (2026-09-19). Granted access is not
// verified yet; a refused model shows up as an error in the results, never as a silent fallback.
export const MODELS = {
  'claude-3-haiku-inregion': { id: 'anthropic.claude-3-haiku-20240307-v1:0', cache: 'none' },
  'claude-3-haiku-apac': { id: 'apac.anthropic.claude-3-haiku-20240307-v1:0', cache: 'none' },
  'nova-lite-apac': { id: 'apac.amazon.nova-lite-v1:0', cache: 'implicit' },
  'nova-micro-apac': { id: 'apac.amazon.nova-micro-v1:0', cache: 'implicit' },
  'haiku-4-5-global': { id: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', cache: 'explicit', minCacheTokens: 4096 },
  'sonnet-5-global': { id: 'global.anthropic.claude-sonnet-5', cache: 'explicit', minCacheTokens: 1024 },
};
