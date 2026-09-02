import {
  selectHistoryRetention,
  type HistoryRecord,
} from './history-retention.js';

const records: HistoryRecord[] = [
  { key: '01', order: 1, state: 'CLOSED' },
  { key: '02', order: 2, state: 'CLOSED' },
  { key: '03', order: 3, state: 'CLOSED' },
  { key: '04', order: 4, state: 'CLOSED' },
  { key: '05', order: 5, state: 'AUTHORIZED' },
];

describe('selectHistoryRetention', () => {
  it('keeps the active item and two previous items detailed', () => {
    const result = selectHistoryRetention(records, {
      activeKey: '05',
      keepRecent: 2,
    });

    expect(result.keepDetailed).toEqual(['03', '04', '05']);
    expect(result.compact).toEqual(['01', '02']);
  });

  it('never compacts pinned or unresolved records', () => {
    const result = selectHistoryRetention(records, {
      activeKey: '05',
      keepRecent: 2,
      pinnedKeys: ['01'],
      unresolvedKeys: ['02'],
    });

    expect(result.keepDetailed).toEqual(['01', '02', '03', '04', '05']);
    expect(result.compact).toEqual([]);
  });

  it('rejects an active item that is not in the history set', () => {
    expect(() =>
      selectHistoryRetention(records, { activeKey: '99', keepRecent: 2 }),
    ).toThrow('ACTIVE_RECORD_NOT_FOUND');
  });

  it('keeps planned and blocked items detailed instead of compacting them', () => {
    const result = selectHistoryRetention([
      ...records,
      { key: '06', order: 6, state: 'DRAFT' },
      { key: '07', order: 7, state: 'BLOCKED' },
    ], {
      activeKey: '05',
      keepRecent: 0,
    });

    expect(result.keepDetailed).toEqual(['05', '06', '07']);
    expect(result.compact).toEqual(['01', '02', '03', '04']);
  });
});
