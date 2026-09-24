import {
  assessValidationCoverage,
  deriveValidationRequirements,
} from './validation-requirements.js';

describe('validation requirements', () => {
  it('derives a deterministic union of capabilities from risk tags', () => {
    expect(deriveValidationRequirements(['API_WRITE', 'DATABASE', 'API_WRITE'])).toEqual({
      riskTags: ['API_WRITE', 'DATABASE'],
      requiredCapabilities: ['API_INTEGRATION', 'READ_AFTER_WRITE', 'DATABASE_PERSISTENCE'],
      unknownRiskTags: [],
    });
  });

  it('reports unknown risks and missing coverage without duplicating capabilities', () => {
    expect(assessValidationCoverage({
      riskTags: ['API_WRITE', 'UNKNOWN_RISK'],
      tests: [{ runnerProfileKey: 'write' }, { runnerProfileKey: 'missing' }],
      profiles: [{ key: 'write', capabilities: ['API_INTEGRATION'] }],
    })).toEqual({
      status: 'BLOCKED',
      riskTags: ['API_WRITE', 'UNKNOWN_RISK'],
      requiredCapabilities: ['API_INTEGRATION', 'READ_AFTER_WRITE'],
      coveredCapabilities: ['API_INTEGRATION'],
      missingCapabilities: ['READ_AFTER_WRITE'],
      unknownRiskTags: ['UNKNOWN_RISK'],
      missingProfileKeys: ['missing'],
    });
  });

  it('releases a plan when every required capability is covered', () => {
    expect(assessValidationCoverage({
      riskTags: ['API_WRITE'],
      tests: [{ runnerProfileKey: 'write' }],
      profiles: [{
        key: 'write',
        capabilities: ['API_INTEGRATION', 'READ_AFTER_WRITE'],
      }],
    })).toEqual({
      status: 'OK',
      riskTags: ['API_WRITE'],
      requiredCapabilities: ['API_INTEGRATION', 'READ_AFTER_WRITE'],
      coveredCapabilities: ['API_INTEGRATION', 'READ_AFTER_WRITE'],
      missingCapabilities: [],
      unknownRiskTags: [],
      missingProfileKeys: [],
    });
  });

  it('does not require UI interaction for frontend or visual risk tags', () => {
    expect(deriveValidationRequirements(['FRONTEND', 'VISUAL_ONLY'])).toEqual({
      riskTags: ['FRONTEND', 'VISUAL_ONLY'],
      requiredCapabilities: [],
      unknownRiskTags: [],
    });
  });
});
