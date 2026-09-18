const riskCapabilityMatrix: Record<string, readonly string[]> = {
  FRONTEND: ['UI_INTERACTION'],
  API_READ: ['API_READ'],
  API_WRITE: ['API_INTEGRATION', 'READ_AFTER_WRITE'],
  DATABASE: ['DATABASE_PERSISTENCE'],
  MIGRATION: ['MIGRATION'],
  PRIVATE_DATA: ['PRIVACY_NEGATIVE'],
  MULTI_TENANT: ['TENANT_ISOLATION'],
  REALTIME: ['REALTIME_RECONCILIATION'],
  ASYNC_JOB: ['ASYNC_CONSISTENCY'],
  EXTERNAL_INTEGRATION: ['EXTERNAL_CONTRACT'],
  VISUAL_ONLY: ['UI_INTERACTION'],
};

export type ValidationRequirementAssessment = {
  status: 'OK' | 'BLOCKED';
  riskTags: string[];
  requiredCapabilities: string[];
  coveredCapabilities: string[];
  missingCapabilities: string[];
  unknownRiskTags: string[];
  missingProfileKeys: string[];
};

export function deriveValidationRequirements(riskTags: readonly string[]) {
  const normalizedRiskTags = unique(riskTags);
  const unknownRiskTags = normalizedRiskTags.filter((riskTag) => !riskCapabilityMatrix[riskTag]);
  const requiredCapabilities = unique(
    normalizedRiskTags.flatMap((riskTag) => riskCapabilityMatrix[riskTag] ?? []),
  );

  return {
    riskTags: normalizedRiskTags,
    requiredCapabilities,
    unknownRiskTags,
  };
}

export function assessValidationCoverage(input: {
  riskTags: readonly string[];
  tests: Array<{ runnerProfileKey?: string | null }>;
  profiles: Array<{ key: string; capabilities: readonly string[] }>;
}): ValidationRequirementAssessment {
  const requirements = deriveValidationRequirements(input.riskTags);
  const profilesByKey = new Map(input.profiles.map((profile) => [profile.key, profile]));
  const referencedProfileKeys = unique(
    input.tests
      .map((test) => test.runnerProfileKey ?? '')
      .filter(Boolean),
  );
  const missingProfileKeys = referencedProfileKeys.filter((key) => !profilesByKey.has(key));
  const coveredCapabilities = unique(
    referencedProfileKeys.flatMap((key) => profilesByKey.get(key)?.capabilities ?? []),
  );
  const missingCapabilities = requirements.requiredCapabilities.filter(
    (capability) => !coveredCapabilities.includes(capability),
  );

  return {
    status: requirements.unknownRiskTags.length || missingCapabilities.length || missingProfileKeys.length
      ? 'BLOCKED'
      : 'OK',
    riskTags: requirements.riskTags,
    requiredCapabilities: requirements.requiredCapabilities,
    coveredCapabilities,
    missingCapabilities,
    unknownRiskTags: requirements.unknownRiskTags,
    missingProfileKeys,
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
