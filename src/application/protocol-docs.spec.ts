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
      '| `SUPERSEDED` |',
      'Folhas efetivas e estados terminais',
      'Todos os comandos gerenciados exigem `--fence <generation>`',
    ]) {
      expect(documentation).toContain(term);
    }
  });

  it('orienta descoberta compacta e coordenação paralela sem reinterpretar o histórico', () => {
    const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), 'utf8');
    const documentation = `${read('README.md')}\n${read('AGENTS.md')}`;

    for (const term of [
      'feature list --project <project-key>',
      'feature show --project <project-key> --feature <feature-key>',
      'repository list --project <project-key> --repository <repository-key>',
      'decision list --project <project-key> --feature <feature-key> --item <item-key>',
      'pending list --project <project-key> --feature <feature-key> --item <item-key>',
      'UNCLASSIFIED',
      'mapa de execução',
      'MANAGED_WORKTREE',
    ]) {
      expect(documentation).toContain(term);
    }
  });
});
