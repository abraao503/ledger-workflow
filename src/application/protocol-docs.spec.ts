import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('protocolo documentado do workflow', () => {
  it('explica a fronteira e o ciclo completo de leases protegidas', () => {
    const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), 'utf8');
    const documentation = `${read('README.md')}\n${read('AGENTS.md')}`;

    for (const term of [
      'workflow frontier',
      'executionFence',
      'item renew',
      'item release',
      'item reconcile',
    ]) {
      expect(documentation).toContain(term);
    }
  });
});
