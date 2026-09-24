const independentReviewRiskTags = new Set([
  'AUTHORIZATION',
  'PRIVATE_DATA',
  'MULTI_TENANT',
  'MIGRATION',
  'EXTERNAL_INTEGRATION',
]);

export function independentReviewRisks(riskTags: readonly string[]): string[] {
  return [...new Set(riskTags)].filter((riskTag) => independentReviewRiskTags.has(riskTag));
}
