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

        if (commandLine.includes('status --porcelain')) {
          return ' M src/changed.ts\n?? test/new.spec.ts\nR  old.ts -> src/new.ts\n';
        }

        if (commandLine.includes('diff --no-ext-diff')) {
          return 'diff --git a/src/changed.ts b/src/changed.ts\n+changed\n';
        }

        if (commandLine.includes('ls-files --others')) {
          return 'test/new.spec.ts\0';
        }

        if (commandLine.includes('hash-object')) {
          return 'new-file-hash\n';
        }

        return '';
      },
    };

    const snapshot = await new GitReadAdapter(command).capture('/workspace/api');

    expect(snapshot).toMatchObject({
      branch: 'dev',
      sha: 'abc123',
      dirty: true,
      changedFiles: ['src/changed.ts', 'test/new.spec.ts', 'src/new.ts'],
      contentFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(calls).toEqual([
      { args: ['git', 'rev-parse', '--abbrev-ref', 'HEAD'], cwd: '/workspace/api' },
      { args: ['git', 'rev-parse', 'HEAD'], cwd: '/workspace/api' },
      {
        args: ['git', 'status', '--porcelain=v1', '--untracked-files=all'],
        cwd: '/workspace/api',
      },
      {
        args: ['git', 'ls-files', '--stage', '-z'],
        cwd: '/workspace/api',
      },
      {
        args: ['git', 'diff', '--no-ext-diff', '--binary', 'HEAD', '--'],
        cwd: '/workspace/api',
      },
      {
        args: ['git', 'ls-files', '--others', '--exclude-standard', '-z'],
        cwd: '/workspace/api',
      },
      {
        args: ['git', 'hash-object', '--no-filters', '--', 'test/new.spec.ts'],
        cwd: '/workspace/api',
      },
      {
        args: ['git', 'hash-object', '--no-filters', '--', 'src/changed.ts'],
        cwd: '/workspace/api',
      },
      {
        args: ['git', 'hash-object', '--no-filters', '--', 'test/new.spec.ts'],
        cwd: '/workspace/api',
      },
      {
        args: ['git', 'hash-object', '--no-filters', '--', 'src/new.ts'],
        cwd: '/workspace/api',
      },
    ]);
  });

  it('keeps the content fingerprint when the validated worktree is committed', async () => {
    let committed = false;
    const command: GitCommandPort = {
      run: async (args) => {
        const commandLine = args.join(' ');

        if (commandLine.includes('--abbrev-ref')) {
          return 'dev\n';
        }

        if (commandLine === 'git rev-parse HEAD') {
          return committed ? 'def456\n' : 'abc123\n';
        }

        if (commandLine.includes('status --porcelain')) {
          return committed ? '' : ' M src/changed.ts\n';
        }

        if (commandLine.includes('ls-files --stage')) {
          return committed
            ? '100644 worktree-hash 0\tsrc/changed.ts\0'
            : '100644 base-hash 0\tsrc/changed.ts\0';
        }

        if (commandLine.includes('diff --no-ext-diff')) {
          return committed ? '' : 'diff --git a/src/changed.ts b/src/changed.ts\n+changed\n';
        }

        if (commandLine.includes('ls-files --others')) {
          return '';
        }

        if (commandLine.includes('hash-object')) {
          return 'worktree-hash\n';
        }

        return '';
      },
    };
    const adapter = new GitReadAdapter(command);
    const beforeCommit = await adapter.capture('/workspace/api');
    committed = true;
    const afterCommit = await adapter.capture('/workspace/api');

    expect(beforeCommit.contentFingerprint).toBe(afterCommit.contentFingerprint);
    expect(beforeCommit.fingerprint).not.toBe(afterCommit.fingerprint);
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
        return args.includes('status') ? '  \n\n' : '';
      },
    };

    await expect(new GitReadAdapter(command).capture('/workspace/api')).resolves.toMatchObject({
      branch: 'dev',
      sha: 'abc123',
      dirty: false,
      changedFiles: [],
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
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
