// Re-export canonical math from shared module.
// This file preserves the original import paths for existing consumers.
export { normalPdf, normalCdf, binaryCallPrice, probToCents } from "../../shared/src/pricer.js";
