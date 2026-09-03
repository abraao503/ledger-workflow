import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

import { fail } from './errors.js';
import type { GitReadPort, GitSnapshot } from './types.js';

const execFileAsync = promisify(execFile);

export type GitCommandPort = {
  run: (args: string[], cwd: string) => Promise<string>;
};

const defaultCommand: GitCommandPort = {
  async run(args, cwd) {
    const result = await execFileAsync(
      'rtk',
      args,
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: 2_000_000,
      },
    );

    return result.stdout;
  },
};

export class GitReadAdapter implements GitReadPort {
  constructor(private readonly command: GitCommandPort = defaultCommand) {}

  async capture(repositoryPath: string): Promise<GitSnapshot> {
    try {
      const branch = (await this.command.run(
        ['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
        repositoryPath,
      )).trim();
      const sha = (await this.command.run(
        ['git', 'rev-parse', 'HEAD'],
        repositoryPath,
      )).trim();
      const status = await this.command.run(
        ['git', 'status', '--porcelain=v1', '--untracked-files=all'],
        repositoryPath,
      );
      const trackedDiff = await this.command.run(
        ['git', 'diff', '--no-ext-diff', '--binary', 'HEAD', '--'],
        repositoryPath,
      );
      const untrackedOutput = await this.command.run(
        ['git', 'ls-files', '--others', '--exclude-standard', '-z'],
        repositoryPath,
      );
      const untrackedFiles = untrackedOutput.split('\0').filter(Boolean).sort();
      const untrackedHashes = await Promise.all(
        untrackedFiles.map(async (file) => ({
          file,
          hash: (await this.command.run(
            ['git', 'hash-object', '--no-filters', '--', file],
            repositoryPath,
          )).trim(),
        })),
      );

      if (!branch || !sha) {
        fail('GIT_COMMAND_FAILED', 'Git retornou um baseline vazio');
      }

      return {
        branch,
        sha,
        dirty: status.trim().length > 0,
        changedFiles: parseChangedFiles(status),
        fingerprint: createHash('sha256')
          .update(sha)
          .update('\0')
          .update(status)
          .update('\0')
          .update(trackedDiff)
          .update('\0')
          .update(JSON.stringify(untrackedHashes))
          .digest('hex'),
      };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'GIT_COMMAND_FAILED') {
        throw error;
      }

      return fail(
        'GIT_COMMAND_FAILED',
        `Não foi possível capturar o baseline Git em ${repositoryPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

function parseChangedFiles(status: string): string[] {
  return status
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((file) => {
      const renameSeparator = file.lastIndexOf(' -> ');
      return renameSeparator >= 0 ? file.slice(renameSeparator + 4) : file;
    });
}
