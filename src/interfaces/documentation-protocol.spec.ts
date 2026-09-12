import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('agent granularity protocol documentation', () => {
  const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), 'utf8');

  it('documents the stop, request and human approval flow in the workflow README', () => {
    const readme = read('README.md');

    expect(readme).toContain('### Granularidade, exceções e replanejamento');
    expect(readme).toContain('workflow_plan_check');
    expect(readme).toContain('workflow_request_slice_size_exception');
    expect(readme).toContain('human:<identidade>');
    expect(readme).toContain('workflow_replan_item');
    expect(readme).toContain('não aprova a própria exceção');
  });

  it('puts the same protocol in the workspace instructions used by agents', () => {
    const agents = read('../AGENTS.md');

    expect(agents).toContain('Protocolo obrigatório de granularidade');
    expect(agents).toContain('SPLIT_RECOMMENDED');
    expect(agents).toContain('EXCEPTION_REQUIRED');
    expect(agents).toContain('workflow_request_slice_size_exception');
    expect(agents).toContain('workflow_replan_item');
  });

  it('keeps discovery scoped and exposes the parallel coordination contract', () => {
    const readme = read('README.md');
    const agents = read('AGENTS.md');

    expect(readme).toContain('feature list --project <project-key>');
    expect(readme).toContain('feature show --project <project-key> --feature <feature-key>');
    expect(readme).toContain('UNCLASSIFIED');
    expect(readme).toContain('mapa de execução');
    expect(agents).toContain('decision list --project <project-key> --feature <feature-key> --item <item-key>');
    expect(agents).toContain('pending list --project <project-key> --feature <feature-key> --item <item-key>');
  });
});
