import { execFile } from 'node:child_process';
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

      if (!branch || !sha) {
        fail('GIT_COMMAND_FAILED', 'Git retornou um baseline vazio');
      }

      return {
        branch,
        sha,
        dirty: status.trim().length > 0,
        changedFiles: parseChangedFiles(status),
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
