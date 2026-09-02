import { GitReadAdapter, type GitCommandPort } from './git-read-adapter.js';

describe('GitReadAdapter', () => {
  it('captures the branch, commit and all working-tree changes', async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const command: GitCommandPort = {
      run: async (args, cwd) => {
        calls.push({ args, cwd });
        const commandLine = args.join(' ');

        if (commandLine.includes('--abbrev-ref')) {
          return 'dev\n';
        }

        if (commandLine === 'git rev-parse HEAD') {
          return 'abc123\n';
        }

        return ' M src/changed.ts\n?? test/new.spec.ts\nR  old.ts -> src/new.ts\n';
      },
    };

    const snapshot = await new GitReadAdapter(command).capture('/workspace/api');

    expect(snapshot).toEqual({
      branch: 'dev',
      sha: 'abc123',
      dirty: true,
      changedFiles: ['src/changed.ts', 'test/new.spec.ts', 'src/new.ts'],
    });
    expect(calls).toEqual([
      { args: ['git', 'rev-parse', '--abbrev-ref', 'HEAD'], cwd: '/workspace/api' },
      { args: ['git', 'rev-parse', 'HEAD'], cwd: '/workspace/api' },
      {
        args: ['git', 'status', '--porcelain=v1', '--untracked-files=all'],
        cwd: '/workspace/api',
      },
    ]);
  });

  it('converts a git failure into an application error', async () => {
    const command: GitCommandPort = {
      run: async () => {
        throw new Error('not a repository');
      },
    };

    await expect(new GitReadAdapter(command).capture('/workspace/missing')).rejects.toMatchObject({
      code: 'GIT_COMMAND_FAILED',
    });
  });

  it('treats whitespace-only status as a clean baseline', async () => {
    const command: GitCommandPort = {
      run: async (args) => {
        if (args.includes('--abbrev-ref')) {
          return 'dev\n';
        }
        if (args[2] === 'HEAD') {
          return 'abc123\n';
        }
        return '  \n\n';
      },
    };

    await expect(new GitReadAdapter(command).capture('/workspace/api')).resolves.toEqual({
      branch: 'dev',
      sha: 'abc123',
      dirty: false,
      changedFiles: [],
    });
  });

  it('rejects a repository when branch or SHA cannot be resolved', async () => {
    const command: GitCommandPort = {
      run: async (args) => args.includes('--abbrev-ref') ? '\n' : 'abc123\n',
    };

    await expect(new GitReadAdapter(command).capture('/workspace/api')).rejects.toMatchObject({
      code: 'GIT_COMMAND_FAILED',
    });
  });
});
