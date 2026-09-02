export type HistoryRecord = {
  key: string;
  order: number;
  state: string;
};

export type HistoryRetentionOptions = {
  activeKey: string;
  keepRecent: number;
  pinnedKeys?: string[];
  unresolvedKeys?: string[];
};

export type HistoryRetentionResult = {
  keepDetailed: string[];
  compact: string[];
};

export function selectHistoryRetention(
  records: HistoryRecord[],
  options: HistoryRetentionOptions,
): HistoryRetentionResult {
  const ordered = [...records].sort((left, right) => left.order - right.order);
  const activeIndex = ordered.findIndex((record) => record.key === options.activeKey);

  if (activeIndex === -1) {
    throw new Error('ACTIVE_RECORD_NOT_FOUND');
  }

  const protectedKeys = new Set([
    options.activeKey,
    ...(options.pinnedKeys ?? []),
    ...(options.unresolvedKeys ?? []),
  ]);

  const recentKeys = options.keepRecent > 0
    ? ordered
        .slice(0, activeIndex)
        .filter((record) => record.state === 'CLOSED')
        .slice(-options.keepRecent)
        .map((record) => record.key)
    : [];

  const keepKeys = new Set([...protectedKeys, ...recentKeys]);

  return {
    keepDetailed: ordered
      .filter((record) => keepKeys.has(record.key) || record.state !== 'CLOSED')
      .map((record) => record.key),
    compact: ordered
      .filter((record) => record.state === 'CLOSED' && !keepKeys.has(record.key))
      .map((record) => record.key),
  };
}
