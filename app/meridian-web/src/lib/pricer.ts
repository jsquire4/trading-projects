// Re-export canonical math from shared module.
export { normalCdf, binaryCallPrice, probToCents } from "@shared/pricer";

// Re-export quote generation from shared module.
export { generateQuotes, shouldHalt, DEFAULT_CONFIG } from "@shared/quoter";
export type { QuoteConfig, QuoteResult } from "@shared/quoter";
