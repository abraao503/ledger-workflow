import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { GitReadAdapter, type GitCommandPort } from './git-read-adapter.js';

const execFileAsync = promisify(execFile);

async function runRawGit(args: string[], cwd: string): Promise<string> {
  const result = await execFileAsync('rtk', ['proxy', 'git', ...args], {
    cwd,
    encoding: 'utf8',
  });

  return result.stdout;
}

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

  it('lists committed files in the candidate diff', async () => {
    const calls: string[][] = [];
    const command: GitCommandPort = {
      run: async (args) => {
        calls.push(args);
        return args.includes('--name-only') ? 'src/b.ts\0src/a.ts\0' : '';
      },
    };

    await expect(new GitReadAdapter(command).diffFiles('/workspace/api', 'base', 'candidate'))
      .resolves.toEqual(['src/a.ts', 'src/b.ts']);
    expect(calls).toEqual([[
      'git', 'diff', '--name-only', '-z', '--no-ext-diff', 'base...candidate', '--',
    ]]);
  });

  it('keeps RTK presentation text out of machine-readable diff paths', async () => {
    const repositoryPath = await mkdtemp(path.join(os.tmpdir(), 'workflow-git-read-'));

    try {
      await runRawGit(['init', '--quiet'], repositoryPath);
      await runRawGit(['config', 'user.email', 'workflow-tests@example.com'], repositoryPath);
      await runRawGit(['config', 'user.name', 'Workflow tests'], repositoryPath);
      await mkdir(path.join(repositoryPath, 'src'), { recursive: true });
      await writeFile(path.join(repositoryPath, 'src/changed.ts'), 'base\n');
      await runRawGit(['add', '--', 'src/changed.ts'], repositoryPath);
      await runRawGit(['commit', '--quiet', '-m', 'base'], repositoryPath);
      const baseSha = (await runRawGit(['rev-parse', 'HEAD'], repositoryPath)).trim();

      await writeFile(path.join(repositoryPath, 'src/changed.ts'), 'candidate\n');
      await runRawGit(['add', '--', 'src/changed.ts'], repositoryPath);
      await runRawGit(['commit', '--quiet', '-m', 'candidate'], repositoryPath);
      const candidateSha = (await runRawGit(['rev-parse', 'HEAD'], repositoryPath)).trim();

      await expect(new GitReadAdapter().diffFiles(repositoryPath, baseSha, candidateSha))
        .resolves.toEqual(['src/changed.ts']);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it('treats an already removed worktree as a successful cleanup retry', async () => {
    let removeAttempted = false;
    const command: GitCommandPort = {
      run: async (args) => {
        if (args.includes('worktree') && args.includes('remove')) {
          removeAttempted = true;
          throw new Error('worktree is not registered');
        }
        if (args.includes('worktree') && args.includes('list')) {
          return 'worktree /workspace/other\nHEAD abc\n';
        }
        return '';
      },
    };

    await expect(new GitReadAdapter(command).removeWorktree('/workspace/api', '/workspace/old'))
      .resolves.toBeUndefined();
    expect(removeAttempted).toBe(true);
  });
});
