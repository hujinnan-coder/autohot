export interface ProductKeyed {
  productKey: string | null;
  majorNode: boolean | null;
}

/** 已出现的车型键，供日报补充看点时避开本期已经收录的车型。 */
export function productKeysOf<T extends ProductKeyed>(rows: T[]): Set<string> {
  const keys = new Set<string>();
  for (const row of rows) if (row.productKey !== null) keys.add(row.productKey);
  return keys;
}

/** 保持展示顺序。同车型有特别重大节点时只保留这些节点，否则只留第一条。没有车型键的事件各自保留。 */
export function dedupByProduct<T extends ProductKeyed>(rows: T[]): T[] {
  // 先找出所有特别重大节点，避免排序靠前的普通事件抢占名额。
  const seen = productKeysOf(rows.filter((row) => row.majorNode === true));
  return rows.filter(({ productKey, majorNode }) => {
    if (productKey === null || majorNode === true) return true;
    if (seen.has(productKey)) return false;
    seen.add(productKey);
    return true;
  });
}
