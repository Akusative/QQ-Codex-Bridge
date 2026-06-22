import type { ApprovedMemoryEntry } from "./memory-repository.js";
import { NEGATIVE_EMOTIONS } from "./memory-emotion.js";

interface IntrusionDecayRecord {
  referenceCount?: number;
  lastReferencedAt?: string;
}

export interface IntrusionOptions {
  rate: number;
  minAgeDays: number;
  decay?: (path: string) => IntrusionDecayRecord | undefined;
  emotionsOf?: (path: string) => string[];
  now?: Date;
  rng?: () => number;
}

/**
 * 反刍 / 侵入念头：低概率从"阁楼"（又老又带情绪的旧伤）随机翻涌一条记忆，
 * 跟当前话题未必相关。复用衰减(refCount/时间)+情绪标签，无 LLM。
 */
export function maybeIntrude(
  candidates: ReadonlyArray<ApprovedMemoryEntry>,
  selected: ReadonlyArray<ApprovedMemoryEntry>,
  options: IntrusionOptions,
): ApprovedMemoryEntry | undefined {
  const rng = options.rng ?? Math.random;
  if (options.rate <= 0 || rng() >= options.rate) return undefined;

  const now = options.now ?? new Date();
  const selectedPaths = new Set(selected.map((entry) => entry.relativePath));

  // 阁楼基础池：非 preference/rule、未被本轮选中、够老。
  const attic = candidates.filter((entry) => {
    if (entry.category === "preference" || entry.category === "rule") return false;
    if (selectedPaths.has(entry.relativePath)) return false;
    return ageInDays(entry, options.decay?.(entry.relativePath), now) > options.minAgeDays;
  });
  if (attic.length === 0) return undefined;

  let pool = attic;
  if (options.emotionsOf) {
    const emotionsOf = options.emotionsOf;
    const negative = attic.filter((entry) =>
      emotionsOf(entry.relativePath).some((label) => NEGATIVE_EMOTIONS.has(label)),
    );
    const anyEmotional = attic.filter((entry) => emotionsOf(entry.relativePath).length > 0);
    pool = negative.length > 0 ? negative : anyEmotional.length > 0 ? anyEmotional : attic;
  }

  // 加权随机：被反复强化的旧伤更易翻涌。
  const weights = pool.map((entry) => 1 + (options.decay?.(entry.relativePath)?.referenceCount ?? 0));
  const total = weights.reduce((sum, w) => sum + w, 0);
  let target = rng() * total;
  for (let index = 0; index < pool.length; index += 1) {
    target -= weights[index];
    if (target < 0) return pool[index];
  }
  return pool[pool.length - 1];
}

function ageInDays(entry: ApprovedMemoryEntry, record: IntrusionDecayRecord | undefined, now: Date): number {
  const reference = record?.lastReferencedAt || entry.updatedAt;
  const then = new Date(reference).getTime();
  if (Number.isNaN(then)) return 0;
  return (now.getTime() - then) / 86_400_000;
}
