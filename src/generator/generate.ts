import { FAIRNESS_THRESHOLD, FAIRNESS_THRESHOLD_BALANCED, MAX_ATTEMPTS, PRODUCING_RESOURCES } from '../game/constants';
import type {
  ChallengeRolled,
  Hex,
  MapState,
  PlayerCount,
  Port,
  ProducingResource,
  Variants,
} from '../game/types';
import { checkHardConstraints } from './constraints';
import { mulberry32, makeSeed, pick } from './random';
import { randomizeMap, type SpreadHighYieldMode } from './randomize';
import {
  arePortsBalanced,
  computeHealth,
  DEFAULT_SCARCITY_CONFIG,
  hasBalancedPipDistribution,
  hasDroughtCluster,
  hasStrategicDiversity,
  isResourceHealthy,
  scoreMap,
  type ScarcityConfig,
} from './score';

export interface GenerateOptions {
  playerCount: PlayerCount;
  variants: Variants;
  seed?: number;
  maxAttempts?: number;
  /** Override the scarcityBonus weights — for controlled experiments only. */
  scarcityConfig?: ScarcityConfig;
  /** Override the high-yield placement strategy — for controlled experiments. */
  spreadHighYieldMode?: SpreadHighYieldMode;
}

export interface GenerateResult {
  map: MapState;
  attempts: number;
  fellBack: boolean;
}

export function generateMap(opts: GenerateOptions): GenerateResult {
  const seed = opts.seed ?? makeSeed();
  const rng = mulberry32(seed);
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  // Balanced mode (no challenge flavor) uses the strict threshold so player
  // picks come out tight. Challenge modes deliberately introduce imbalance,
  // so they keep the looser 1.0 threshold.
  const isBalanced = opts.variants.challenge.flavor === 'none';
  const threshold = (isBalanced ? FAIRNESS_THRESHOLD_BALANCED : FAIRNESS_THRESHOLD)[opts.playerCount];
  let best: { hexes: Hex[]; ports: Port[]; score: number; rolled?: ChallengeRolled; rolledTarget?: ProducingResource } | null = null;
  let hardOnlyFallback: { hexes: Hex[]; ports: Port[] } | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const candidate = randomizeMap(opts.playerCount, opts.variants, rng, opts.spreadHighYieldMode);
    const hard = checkHardConstraints(candidate.hexes, candidate.ports, {
      noSameNumberAdjacent: opts.variants.noSameNumberAdjacent,
      noSameNumberOnResource: opts.variants.noSameNumberOnResource,
      noMultipleRedsOnResource: opts.variants.noMultipleRedsOnResource,
    });
    if (!hard.ok) continue;
    if (!hardOnlyFallback) hardOnlyFallback = { hexes: candidate.hexes, ports: candidate.ports };

    const challenge = resolveChallenge(opts.variants, rng);
    if (!challengeMatches(candidate.hexes, candidate.ports, opts.playerCount, challenge)) continue;

    const scored = scoreMap(
      candidate.hexes, candidate.ports, opts.playerCount,
      opts.scarcityConfig ?? DEFAULT_SCARCITY_CONFIG,
    );
    // Archetype diversity is checked post-scoring (it needs spot.archetype).
    // Only enforced in balanced mode — challenge modes intentionally bias
    // the strategic landscape (drought = no expansion, scarcity = nothing
    // but city rush, etc.) and shouldn't be rejected for narrowness.
    if (challenge.kind === 'none' && !hasStrategicDiversity(scored.spots)) continue;
    const fairnessOk = scored.fairness.stdev <= threshold;
    const score = scored.fairness.stdev;

    if (!best || score < best.score) {
      best = {
        hexes: candidate.hexes,
        ports: candidate.ports,
        score,
        rolled: challenge.kind === 'none' ? undefined : challenge.kind,
        rolledTarget: challenge.target,
      };
    }
    if (fairnessOk) {
      const variants: Variants = {
        ...opts.variants,
        challenge: {
          ...opts.variants.challenge,
          rolledFlavor: challenge.kind === 'none' ? undefined : challenge.kind,
          rolledTarget: challenge.target,
        },
      };
      return {
        map: { playerCount: opts.playerCount, hexes: candidate.hexes, ports: candidate.ports, variants, seed },
        attempts: attempt,
        fellBack: false,
      };
    }
  }

  if (best) {
    const variants: Variants = {
      ...opts.variants,
      challenge: { ...opts.variants.challenge, rolledFlavor: best.rolled, rolledTarget: best.rolledTarget },
    };
    return {
      map: { playerCount: opts.playerCount, hexes: best.hexes, ports: best.ports, variants, seed },
      attempts: maxAttempts,
      fellBack: true,
    };
  }
  if (hardOnlyFallback) {
    return {
      map: {
        playerCount: opts.playerCount,
        hexes: hardOnlyFallback.hexes,
        ports: hardOnlyFallback.ports,
        variants: opts.variants,
        seed,
      },
      attempts: maxAttempts,
      fellBack: true,
    };
  }
  throw new Error('Generator failed to produce any candidate satisfying hard constraints');
}

interface ResolvedChallenge {
  kind: 'none' | ChallengeRolled;
  target?: ProducingResource;
}

function resolveChallenge(variants: Variants, rng: () => number): ResolvedChallenge {
  const flavor = variants.challenge.flavor;
  if (flavor === 'none') return { kind: 'none' };
  let kind: ChallengeRolled;
  if (flavor === 'random') {
    kind = pick<ChallengeRolled>(['scarcity', 'boomOrBust', 'drought'], rng);
  } else {
    kind = flavor;
  }
  let target: ProducingResource | undefined;
  if (kind === 'scarcity' || kind === 'boomOrBust') {
    const pickedTarget = variants.challenge.targetResource;
    target = pickedTarget === 'any' || flavor === 'random'
      ? pick(PRODUCING_RESOURCES, rng)
      : pickedTarget;
  }
  return { kind, target };
}

function challengeMatches(
  hexes: Hex[],
  ports: Port[],
  playerCount: PlayerCount,
  challenge: ResolvedChallenge,
): boolean {
  if (challenge.kind === 'none') {
    const health = computeHealth(hexes);
    if (!isResourceHealthy(health, hexes, playerCount)) return false;
    if (!arePortsBalanced(ports, hexes)) return false;
    if (!hasBalancedPipDistribution(hexes)) return false;
    return true;
  }
  const health = computeHealth(hexes);
  if (challenge.kind === 'scarcity') {
    const targetHealth = health.find(h => h.resource === challenge.target);
    return !!targetHealth && targetHealth.totalPips <= 4;
  }
  if (challenge.kind === 'boomOrBust') {
    const targetHealth = health.find(h => h.resource === challenge.target);
    return !!targetHealth && targetHealth.concentration >= 0.6 && targetHealth.totalPips >= 5;
  }
  if (challenge.kind === 'drought') {
    return hasDroughtCluster(hexes);
  }
  return false;
}
