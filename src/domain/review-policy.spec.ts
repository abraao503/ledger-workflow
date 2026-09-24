import { independentReviewRisks } from './review-policy.js';

describe('review policy', () => {
  it('requires independent review only for sensitive governed risks', () => {
    expect(independentReviewRisks([
      'FRONTEND', 'ROLE_VISIBILITY', 'AUTHORIZATION', 'MULTI_TENANT', 'AUTHORIZATION',
    ])).toEqual(['AUTHORIZATION', 'MULTI_TENANT']);
    expect(independentReviewRisks(['FRONTEND', 'VISUAL_ONLY'])).toEqual([]);
  });
});
