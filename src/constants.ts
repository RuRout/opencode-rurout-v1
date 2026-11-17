export const PROVIDER_ID = "rurout";
export const PROVIDER_NAME = "RuRout";
// Tried in order: some networks and VPN exits block one of the domains by SNI.
// rurout.com is the primary domain; .ru and .online are working reserves
// served by the same gateway.
export const DEFAULT_BASE_URLS = [
  "https://rurout.com/v1",
  "https://rurout.ru/v1",
  "https://rurout.online/v1",
];
// A domain that failed is tried last for this long, then primary order resumes.
export const DOMAIN_SUSPECT_MS = 5 * 60 * 1000;
export const DISCOVERY_TIMEOUT_MS = 15000;
export const PROVIDER_PACKAGE = "@opencode/ai/providers/openai";
export const FALLBACK_CONTEXT = 200000;
export const FALLBACK_OUTPUT = 32000;
