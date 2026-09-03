import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

import { fail } from './errors.js';
import type { GitReadPort, GitSnapshot } from './types.js';

const execFileAsync = promisify(execFile);

export type GitCommandPort = {
  run: (args: string[], cwd: string) => Promise<string>;
};

type GitStatusEntry = {
  code: string;
  paths: string[];
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
      const statusEntries = parseStatusEntries(status);
      const index = await this.command.run(
        ['git', 'ls-files', '--stage', '-z'],
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
      const contentFingerprint = await captureContentFingerprint(
        this.command,
        repositoryPath,
        index,
        statusEntries,
        untrackedHashes,
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
        contentFingerprint,
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
  return parseStatusEntries(status).flatMap((entry) => [entry.paths.at(-1) as string]);
}

function parseStatusEntries(status: string): GitStatusEntry[] {
  return status
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const code = line.slice(0, 2);
      const value = line.slice(3);
      const renameSeparator = value.lastIndexOf(' -> ');
      const paths = renameSeparator >= 0
        ? [value.slice(0, renameSeparator), value.slice(renameSeparator + 4)]
        : [value];
      return { code, paths };
    });
}

function parseIndexEntries(index: string): Map<string, string> {
  const entries = new Map<string, string>();

  for (const record of index.split('\0').filter(Boolean)) {
    const separator = record.indexOf('\t');
    if (separator < 0) {
      continue;
    }

    const metadata = record.slice(0, separator).split(' ');
    const hash = metadata[1];
    const file = record.slice(separator + 1);

    if (hash && file) {
      entries.set(file, hash);
    }
  }

  return entries;
}

async function captureContentFingerprint(
  command: GitCommandPort,
  repositoryPath: string,
  index: string,
  statusEntries: GitStatusEntry[],
  untrackedHashes: Array<{ file: string; hash: string }>,
): Promise<string> {
  const entries = parseIndexEntries(index);

  for (const entry of statusEntries) {
    const originalPath = entry.paths[0];
    const currentPath = entry.paths.at(-1) as string;
    const deleted = entry.code.includes('D');

    if (entry.paths.length > 1 || deleted) {
      entries.delete(originalPath);
    }

    if (!deleted) {
      const hash = await command.run(
        ['git', 'hash-object', '--no-filters', '--', currentPath],
        repositoryPath,
      );
      entries.set(currentPath, hash.trim());
    }
  }

  for (const entry of untrackedHashes) {
    entries.set(entry.file, entry.hash);
  }

  return createHash('sha256')
    .update(JSON.stringify([...entries.entries()].sort(([left], [right]) => left.localeCompare(right))))
    .digest('hex');
}
