/** Scarcity Bonus Validation — Configs A through E.
 *
 *  Approach: generate 1500 baseline maps once, then for each config re-score
 *  every spot under the alternative scarcity formula and re-run the snake-
 *  draft simulator on the new scores. This isolates the scarcityBonus change
 *  as the only variable (same physical maps, different scoring lens).
 *
 *  The acceptance rate per config is approximated by counting the maps whose
 *  re-simulated fairness stdev would have passed the threshold (1.0). Since
 *  baseline acceptance was 100% in prior stress runs, this captures the
 *  meaningful difference: which maps would the new gate REJECT?
 */
import { describe, it } from 'vitest';
import { generateMap } from '../src/generator/generate';
import { scoreMap, type ScoredMap } from '../src/generator/score';
import { FAIRNESS_THRESHOLD, PIP_VALUE, PRODUCING_RESOURCES } from '../src/game/constants';
import type {
  Archetype,
  Hex,
  Intersection,
  PlayerCount,
  ProducingResource,
  SpotScore,
  Variants,
} from '../src/game/types';

const RUN = process.env.RUN_SCARCITY === '1';

interface ScarcityConfig {
  name: string;
  tileWeight: number; // multiplier on (maxTiles − tiles)
  pipWeight: number;  // multiplier on (maxPips − pips)
}

const CONFIGS: ScarcityConfig[] = [
  { name: 'A baseline (0.50 / 0.06)', tileWeight: 0.5,   pipWeight: 0.06 },
  { name: 'B no tile-count (0 / 0.06)', tileWeight: 0,     pipWeight: 0.06 },
  { name: 'C 50% tile (0.25 / 0.06)',  tileWeight: 0.25,  pipWeight: 0.06 },
  { name: 'D 25% tile (0.125 / 0.06)', tileWeight: 0.125, pipWeight: 0.06 },
  { name: 'E no tile + 0.10 pip',      tileWeight: 0,     pipWeight: 0.10 },
];

function defaultVariants(): Variants {
  return {
    includeDesert: true,
    desertReplacement: 'ore',
    shufflePorts: false,
    noSameNumberAdjacent: true,
    noSameNumberOnResource: true,
    noMultipleRedsOnResource: true,
    challenge: { flavor: 'none', targetResource: 'any' },
  };
}

// --- Re-scoring helpers ----------------------------------------------------

function uniqueAdjResources(
  inter: Intersection,
  hexById: Map<string, Hex>,
): Set<ProducingResource> {
  const out = new Set<ProducingResource>();
  for (const hexId of inter.hexIds) {
    const h = hexById.get(hexId);
    if (h && h.resource !== 'desert') out.add(h.resource as ProducingResource);
  }
  return out;
}

function altScarcity(
  inter: Intersection,
  hexById: Map<string, Hex>,
  tilesPerResource: Map<ProducingResource, number>,
  pipsPerResource: Map<ProducingResource, number>,
  maxTiles: number,
  maxPips: number,
  config: ScarcityConfig,
): number {
  let s = 0;
  for (const r of uniqueAdjResources(inter, hexById)) {
    const tiles = tilesPerResource.get(r) ?? 0;
    const pips = pipsPerResource.get(r) ?? 0;
    if (tiles > 0 && maxTiles > tiles) s += (maxTiles - tiles) * config.tileWeight;
    if (pips > 0 && maxPips > pips) s += (maxPips - pips) * config.pipWeight;
  }
  return s;
}

function rescoreMap(
  scored: ScoredMap,
  hexById: Map<string, Hex>,
  config: ScarcityConfig,
): Map<string, SpotScore> {
  // Recompute tilesPerResource and pipsPerResource from hexById.
  const tilesPerResource = new Map<ProducingResource, number>();
  const pipsPerResource = new Map<ProducingResource, number>();
  for (const h of hexById.values()) {
    if (h.resource === 'desert') continue;
    tilesPerResource.set(
      h.resource as ProducingResource,
      (tilesPerResource.get(h.resource as ProducingResource) ?? 0) + 1,
    );
    if (h.number !== null) {
      pipsPerResource.set(
        h.resource as ProducingResource,
        (pipsPerResource.get(h.resource as ProducingResource) ?? 0) + (PIP_VALUE[h.number] ?? 0),
      );
    }
  }
  const maxTiles = Math.max(0, ...tilesPerResource.values());
  const maxPips = Math.max(0, ...pipsPerResource.values());

  const out = new Map<string, SpotScore>();
  for (const spot of scored.spots.values()) {
    const inter = scored.graph.intersections.get(spot.intersectionId)!;
    const newScarcity = altScarcity(
      inter, hexById, tilesPerResource, pipsPerResource, maxTiles, maxPips, config,
    );
    const newTotal = spot.total - spot.scarcityBonus + newScarcity;
    out.set(spot.intersectionId, { ...spot, scarcityBonus: newScarcity, total: newTotal });
  }
  return out;
}

// Production-mirroring snake-draft simulator (copy of the survival-discounted
// pair-eval logic in score.ts simulateSnakeDraft). Runs against re-scored spots.
function firstPickValue(s: SpotScore): number {
  return s.total - s.roadPotentialBonus - s.startingHandBonus;
}
const TOP_K_R1 = 12;

function simulateSnakeDraft(
  spots: Map<string, SpotScore>,
  graph: ScoredMap['graph'],
  playerCount: PlayerCount,
  hexById: Map<string, Hex>,
): { playerTotals: number[]; stdev: number; spread: number } {
  const order: number[] = [];
  for (let i = 0; i < playerCount; i++) order.push(i);
  for (let i = playerCount - 1; i >= 0; i--) order.push(i);

  const intResources = new Map<string, Set<ProducingResource>>();
  for (const inter of graph.intersections.values()) {
    intResources.set(inter.id, uniqueAdjResources(inter, hexById));
  }

  const blocked = new Set<string>();
  const playerTotals = new Array(playerCount).fill(0);
  const playerResources: Set<ProducingResource>[] =
    Array.from({ length: playerCount }, () => new Set());

  for (let step = 0; step < order.length; step++) {
    const playerIdx = order[step];
    const isSecond = step >= playerCount;
    const available = Array.from(spots.values()).filter(s => !blocked.has(s.intersectionId));
    if (available.length === 0) break;

    let chosen: SpotScore;
    let value: number;

    if (isSecond) {
      const valueOf = (s: SpotScore) => {
        const adj = intResources.get(s.intersectionId) ?? new Set();
        let newRes = 0;
        for (const r of adj) if (!playerResources[playerIdx].has(r)) newRes++;
        return s.total + newRes * 0.5;
      };
      let bestVal = -Infinity, bestSpot = available[0];
      for (const s of available) {
        const v = valueOf(s);
        if (v > bestVal) { bestVal = v; bestSpot = s; }
      }
      chosen = bestSpot;
      value = bestVal;
    } else {
      const picksUntilR2 = 2 * playerCount - 2 * step - 2;
      const planningDiscount = Math.max(0.4, 1 - picksUntilR2 * 0.05);
      const topA = available
        .slice()
        .sort((a, b) => firstPickValue(b) - firstPickValue(a))
        .slice(0, TOP_K_R1);
      let bestA: SpotScore = topA[0] ?? available[0];
      let bestPair = -Infinity;
      for (const A of topA) {
        const interA = graph.intersections.get(A.intersectionId);
        if (!interA) continue;
        const aResSet = intResources.get(A.intersectionId) ?? new Set();
        const aNeighbors = new Set(interA.neighbors);
        let bestB = -Infinity;
        for (const B of available) {
          if (B.intersectionId === A.intersectionId) continue;
          if (aNeighbors.has(B.intersectionId)) continue;
          const bResSet = intResources.get(B.intersectionId) ?? new Set();
          let newRes = 0;
          for (const r of bResSet) if (!aResSet.has(r)) newRes++;
          const bVal = B.total + newRes * 0.5;
          if (bVal > bestB) bestB = bVal;
        }
        if (bestB === -Infinity) continue;
        const pair = firstPickValue(A) + bestB * planningDiscount;
        if (pair > bestPair) { bestPair = pair; bestA = A; }
      }
      chosen = bestA;
      value = firstPickValue(chosen);
    }

    playerTotals[playerIdx] += value;
    blocked.add(chosen.intersectionId);
    const interC = graph.intersections.get(chosen.intersectionId)!;
    for (const nb of interC.neighbors) blocked.add(nb);
    for (const r of intResources.get(chosen.intersectionId) ?? new Set()) {
      playerResources[playerIdx].add(r);
    }
  }

  const mean = playerTotals.reduce((a, b) => a + b, 0) / playerTotals.length;
  const variance = playerTotals.reduce((a, b) => a + (b - mean) ** 2, 0) / playerTotals.length;
  return {
    playerTotals,
    stdev: Math.sqrt(variance),
    spread: Math.max(...playerTotals) - Math.min(...playerTotals),
  };
}

// --- Metrics ---------------------------------------------------------------

function comboKey(spot: SpotScore, scored: ScoredMap, hexById: Map<string, Hex>): string {
  const inter = scored.graph.intersections.get(spot.intersectionId);
  if (!inter) return '?';
  const r = new Set<string>();
  for (const hexId of inter.hexIds) {
    const h = hexById.get(hexId);
    if (h && h.resource !== 'desert') r.add(h.resource);
  }
  return Array.from(r).sort().join('+');
}

function entropy(counts: Map<string, number>, n: number): number {
  let e = 0;
  for (const c of counts.values()) {
    const p = c / n;
    if (p > 0) e -= p * Math.log2(p);
  }
  return e;
}

// --- Main harness ----------------------------------------------------------

interface MapCtx {
  scored: ScoredMap;
  hexById: Map<string, Hex>;
  attempts: number;
}

interface ConfigResult {
  name: string;
  passSubsetSize: number;        // maps whose re-simulated fairness passes
  topSpot: Map<string, number>;  // combo → count
  top5Entropy: number[];         // per-map
  top10Entropy: number[];
  top20Entropy: number[];
  top5Unique: number[];
  top10Unique: number[];
  top20Unique: number[];
  fairnessStdevs: number[];
  fairnessSpreads: number[];
  playerSum: number[];           // P_i sums for averaging
  playerN: number;               // count for averaging
  archetypeMix: Record<Archetype, number>;
  // Specific combo counts of interest:
  brickOreCount: number;
  brickWoodCount: number;
  oreWheatCount: number;
  swwCount: number;
  oreSheepWheatCount: number;
}

function emptyResult(name: string): ConfigResult {
  return {
    name,
    passSubsetSize: 0,
    topSpot: new Map(),
    top5Entropy: [], top10Entropy: [], top20Entropy: [],
    top5Unique: [], top10Unique: [], top20Unique: [],
    fairnessStdevs: [], fairnessSpreads: [],
    playerSum: [], playerN: 0,
    archetypeMix: { expansion: 0, cityRush: 0, portEconomy: 0, devCards: 0, balanced: 0 },
    brickOreCount: 0, brickWoodCount: 0, oreWheatCount: 0, swwCount: 0, oreSheepWheatCount: 0,
  };
}

function mean(xs: number[]) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function quantile(xs: number[], q: number) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return s[lo];
  return s[lo] * (hi - pos) + s[hi] * (pos - lo);
}

describe('scarcity validation', () => {
  it.runIf(RUN)('5 configs × baseline maps', () => {
    const N = Number(process.env.SAMPLES ?? 1000);
    const PC: PlayerCount = 4;
    console.log(`\nGenerating ${N} baseline maps for pc=${PC}...`);
    const t0 = Date.now();
    const baselineMaps: MapCtx[] = [];
    for (let i = 0; i < N; i++) {
      try {
        const r = generateMap({ playerCount: PC, variants: defaultVariants() });
        const scored = scoreMap(r.map.hexes, r.map.ports, PC);
        const hexById = new Map(r.map.hexes.map(h => [h.id, h] as const));
        baselineMaps.push({ scored, hexById, attempts: r.attempts });
      } catch {}
    }
    console.log(`  ${baselineMaps.length} maps in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // Also gather map-level stats that don't depend on scarcity config —
    // these are properties of the underlying generated maps (same across configs).
    console.log('\n=== Underlying map properties (config-independent) ===');
    const resPipSum: Record<string, number> = { wood:0, brick:0, wheat:0, sheep:0, ore:0 };
    const resTileCnt: Record<string, number> = { wood:0, brick:0, wheat:0, sheep:0, ore:0 };
    for (const { hexById } of baselineMaps) {
      for (const h of hexById.values()) {
        if (h.resource === 'desert' || h.number === null) continue;
        resTileCnt[h.resource]++;
        resPipSum[h.resource] += PIP_VALUE[h.number] ?? 0;
      }
    }
    console.log('Resource avg pip/tile:');
    for (const r of Object.keys(resPipSum)) {
      const avg = resTileCnt[r] > 0 ? resPipSum[r] / resTileCnt[r] : 0;
      console.log(`  ${r.padEnd(8)} ${avg.toFixed(3)}`);
    }

    const threshold = FAIRNESS_THRESHOLD[PC];
    const results: ConfigResult[] = CONFIGS.map(c => emptyResult(c.name));

    console.log('\n=== Re-scoring each map under each config + re-simulating fairness ===\n');
    const tR = Date.now();
    for (const ctx of baselineMaps) {
      const { scored, hexById } = ctx;
      for (let ci = 0; ci < CONFIGS.length; ci++) {
        const config = CONFIGS[ci];
        const newSpots = rescoreMap(scored, hexById, config);
        const sim = simulateSnakeDraft(newSpots, scored.graph, PC, hexById);
        const passed = sim.stdev <= threshold;
        if (!passed) continue;

        const r = results[ci];
        r.passSubsetSize++;

        // Sort by new total
        const sorted = Array.from(newSpots.values()).sort((a, b) => b.total - a.total);
        const top1 = sorted[0];
        const top1Combo = comboKey(top1, scored, hexById);
        r.topSpot.set(top1Combo, (r.topSpot.get(top1Combo) ?? 0) + 1);

        if (top1Combo.includes('brick') && top1Combo.includes('ore')) r.brickOreCount++;
        if (top1Combo.includes('brick') && top1Combo.includes('wood') && !top1Combo.includes('ore')) r.brickWoodCount++;
        if (top1Combo.includes('ore') && top1Combo.includes('wheat') && !top1Combo.includes('brick')) r.oreWheatCount++;
        if (top1Combo === 'sheep+wheat+wood') r.swwCount++;
        if (top1Combo === 'ore+sheep+wheat') r.oreSheepWheatCount++;

        // Top-N entropy + uniqueness
        for (const [N_TOP, eArr, uArr] of [
          [5, r.top5Entropy, r.top5Unique],
          [10, r.top10Entropy, r.top10Unique],
          [20, r.top20Entropy, r.top20Unique],
        ] as Array<[number, number[], number[]]>) {
          const top = sorted.slice(0, N_TOP);
          const combos = top.map(s => comboKey(s, scored, hexById));
          uArr.push(new Set(combos).size);
          const counts = new Map<string, number>();
          for (const c of combos) counts.set(c, (counts.get(c) ?? 0) + 1);
          eArr.push(entropy(counts, N_TOP));
        }

        // Archetype mix for top-20
        const top20 = sorted.slice(0, 20);
        for (const s of top20) r.archetypeMix[s.archetype]++;

        // Fairness
        r.fairnessStdevs.push(sim.stdev);
        r.fairnessSpreads.push(sim.spread);
        if (r.playerSum.length === 0) r.playerSum = new Array(PC).fill(0);
        for (let i = 0; i < PC; i++) r.playerSum[i] += sim.playerTotals[i];
        r.playerN++;
      }
    }
    console.log(`Re-scoring took ${((Date.now() - tR) / 1000).toFixed(1)}s\n`);

    // --- Reporting ---------------------------------------------------------

    console.log('=== Pass subset size (maps whose re-simulated stdev ≤ threshold) ===');
    for (const r of results) {
      const pct = (r.passSubsetSize / baselineMaps.length) * 100;
      console.log(`  ${r.name.padEnd(40)} ${r.passSubsetSize.toString().padStart(5)} / ${baselineMaps.length} (${pct.toFixed(1)}%)`);
    }

    console.log('\n=== Top spot composition (of pass subset) ===');
    console.log('Config'.padEnd(40) + 'brick+ore  brick+wood  ore+wheat  sww    ore+sh+wh');
    for (const r of results) {
      const n = r.passSubsetSize || 1;
      const cells = [
        `${(r.brickOreCount / n * 100).toFixed(1)}%`.padStart(7),
        `${(r.brickWoodCount / n * 100).toFixed(1)}%`.padStart(7),
        `${(r.oreWheatCount / n * 100).toFixed(1)}%`.padStart(7),
        `${(r.swwCount / n * 100).toFixed(1)}%`.padStart(7),
        `${(r.oreSheepWheatCount / n * 100).toFixed(1)}%`.padStart(7),
      ].join('   ');
      console.log(`  ${r.name.padEnd(38)} ${cells}`);
    }

    console.log('\n=== Top-spot most-common combo ===');
    for (const r of results) {
      const sorted = Array.from(r.topSpot.entries()).sort((a, b) => b[1] - a[1]);
      const top3 = sorted.slice(0, 3).map(([k, v]) =>
        `${k} (${(v / r.passSubsetSize * 100).toFixed(1)}%)`,
      );
      console.log(`  ${r.name.padEnd(38)} ${top3.join(', ')}`);
    }

    console.log('\n=== Diversity (means across pass subset) ===');
    console.log('Config'.padEnd(40) + 'T5 entr  T10 entr  T20 entr  T5 uniq  T10 uniq  T20 uniq');
    for (const r of results) {
      const cells = [
        mean(r.top5Entropy).toFixed(3).padStart(7),
        mean(r.top10Entropy).toFixed(3).padStart(7),
        mean(r.top20Entropy).toFixed(3).padStart(7),
        mean(r.top5Unique).toFixed(2).padStart(6),
        mean(r.top10Unique).toFixed(2).padStart(7),
        mean(r.top20Unique).toFixed(2).padStart(7),
      ].join('  ');
      console.log(`  ${r.name.padEnd(38)} ${cells}`);
    }

    console.log('\n=== Fairness ===');
    console.log('Config'.padEnd(40) + 'stdev mean    p50    p95    spread mean   p95');
    for (const r of results) {
      const cells = [
        mean(r.fairnessStdevs).toFixed(3).padStart(11),
        quantile(r.fairnessStdevs, 0.5).toFixed(3).padStart(6),
        quantile(r.fairnessStdevs, 0.95).toFixed(3).padStart(6),
        mean(r.fairnessSpreads).toFixed(3).padStart(11),
        quantile(r.fairnessSpreads, 0.95).toFixed(3).padStart(6),
      ].join('  ');
      console.log(`  ${r.name.padEnd(38)} ${cells}`);
    }

    console.log('\n=== Per-player avg total (centered on mode mean) — position bias ===');
    for (const r of results) {
      const means = r.playerSum.map(s => s / r.playerN);
      const overall = means.reduce((a, b) => a + b, 0) / means.length;
      const devs = means.map(m => ((m - overall) / overall * 100));
      const last = devs[PC - 1] - devs[0];
      const dStr = devs.map((d, i) => `P${i + 1}:${(d >= 0 ? '+' : '') + d.toFixed(2)}%`).join('  ');
      console.log(`  ${r.name.padEnd(38)} ${dStr}   P_last-P1: ${last.toFixed(2)}%`);
    }

    console.log('\n=== Archetype share of top-20 (% of top-20 spots) ===');
    console.log('Config'.padEnd(40) + 'Expansion  CityRush  PortEcon  DevCards  Balanced');
    for (const r of results) {
      const tot = Object.values(r.archetypeMix).reduce((a, b) => a + b, 0) || 1;
      const cells: string[] = [];
      for (const k of ['expansion','cityRush','portEconomy','devCards','balanced'] as Archetype[]) {
        cells.push(`${(r.archetypeMix[k] / tot * 100).toFixed(1)}%`.padStart(8));
      }
      console.log(`  ${r.name.padEnd(38)} ${cells.join('  ')}`);
    }
  }, 60 * 60 * 1000);
});
