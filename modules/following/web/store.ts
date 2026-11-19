// 关注的品牌（主题 slug）存在浏览器的 localStorage 里：不登录、不上传。换设备或清除浏览器数据不会同步。
import { useSyncExternalStore } from "react";

const KEY = "autohot-following-topics";
/** 最多关注这么多个：每个都要请求一次品牌页。 */
export const FOLLOW_LIMIT = 20;

const EMPTY: readonly string[] = [];
let cache: { raw: string | null; list: readonly string[] } = { raw: null, list: EMPTY };
const listeners = new Set<() => void>();

function read(): readonly string[] {
  if (typeof window === "undefined") return EMPTY;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch {
    return EMPTY;
  }
  if (raw === cache.raw) return cache.list;
  let list: string[] = [];
  try {
    const parsed = JSON.parse(raw ?? "[]");
    if (Array.isArray(parsed)) list = [...new Set(parsed.filter((s): s is string => typeof s === "string" && /^[a-z0-9-]{1,60}$/.test(s)))].slice(0, FOLLOW_LIMIT);
  } catch {
    list = [];
  }
  cache = { raw, list };
  return list;
}

function write(next: string[]): boolean {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    return false;
  }
  for (const l of listeners) l();
  return true;
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** 关注的品牌，按关注先后排；服务端渲染时是空的。 */
export function useFollowing(): readonly string[] {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}

/** 关注或取消关注。满了、或者浏览器存不了时返回 false。 */
export function toggleFollow(slug: string): boolean {
  const list = read();
  if (list.includes(slug)) return write(list.filter((s) => s !== slug));
  if (list.length >= FOLLOW_LIMIT) return false;
  return write([...list, slug]);
}
