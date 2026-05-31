/** Re-run of the planner-bias diagnostic, now against the survival-discounted
 *  planner. Goal: confirm P-last advantage compresses toward a middle ground
 *  between greedy (~0%) and optimistic-pair (~3.5% at 6p). */
import { describe, it } from 'vitest';
import { generateMap } from '../src/generator/generate';
import { scoreMap } from '../src/generator/score';
import type { PlayerCount, SpotScore, Variants } from '../src/game/types';

const RUN = process.env.RUN_PLANNER_BIAS === '1';

function v(): Variants {
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

function simulateGreedy(
  spots: Map<string, SpotScore>,
  graph: ReturnType<typeof scoreMap>['graph'],
  playerCount: PlayerCount,
): number[] {
  const order: number[] = [];
  for (let i = 0; i < playerCount; i++) order.push(i);
  for (let i = playerCount - 1; i >= 0; i--) order.push(i);

  const blocked = new Set<string>();
  const totals = new Array(playerCount).fill(0);
  for (const playerIdx of order) {
    let best: SpotScore | null = null;
    let bestVal = -Infinity;
    for (const s of spots.values()) {
      if (blocked.has(s.intersectionId)) continue;
      if (s.total > bestVal) { bestVal = s.total; best = s; }
    }
    if (!best) break;
    totals[playerIdx] += best.total;
    blocked.add(best.intersectionId);
    const inter = graph.intersections.get(best.intersectionId)!;
    for (const nb of inter.neighbors) blocked.add(nb);
  }
  return totals;
}

describe('planner bias diagnostic', () => {
  it.runIf(RUN)('Mode A (current planner) vs Mode B (greedy local)', () => {
    const SAMPLES = Number(process.env.SAMPLES ?? 400);
    for (const pc of [3, 4, 5, 6] as PlayerCount[]) {
      console.log(`\n========== pc=${pc} (n=${SAMPLES}) ==========`);
      const sumA = new Array(pc).fill(0);
      const sumB = new Array(pc).fill(0);
      let succeeded = 0;
      const t0 = Date.now();
      for (let i = 0; i < SAMPLES; i++) {
        let map;
        try {
          map = generateMap({ playerCount: pc, variants: v() }).map;
        } catch { continue; }
        const scored = scoreMap(map.hexes, map.ports, pc);
        const totalsA = scored.fairness.playerTotals;
        const totalsB = simulateGreedy(scored.spots, scored.graph, pc);
        for (let j = 0; j < pc; j++) { sumA[j] += totalsA[j]; sumB[j] += totalsB[j]; }
        succeeded++;
      }
      const elapsed = (Date.now() - t0) / 1000;
      console.log(`  ${succeeded} maps in ${elapsed.toFixed(1)}s`);

      const meanA = sumA.map(s => s / succeeded);
      const meanB = sumB.map(s => s / succeeded);
      const overallA = meanA.reduce((a, b) => a + b, 0) / pc;
      const overallB = meanB.reduce((a, b) => a + b, 0) / pc;

      console.log('\n  Per-player avg total, centered on mode mean:');
      console.log('  player    Mode A (planner)        Mode B (greedy)        Δ(A-B)');
      for (let j = 0; j < pc; j++) {
        const devA = meanA[j] - overallA;
        const devB = meanB[j] - overallB;
        const pctA = (devA / overallA) * 100;
        const pctB = (devB / overallB) * 100;
        console.log(
          `  P${j + 1}        ${meanA[j].toFixed(3).padStart(7)}  (${(pctA >= 0 ? '+' : '') + pctA.toFixed(2)}%)` +
          `      ${meanB[j].toFixed(3).padStart(7)}  (${(pctB >= 0 ? '+' : '') + pctB.toFixed(2)}%)` +
          `   Δ ${((pctA - pctB) >= 0 ? '+' : '') + (pctA - pctB).toFixed(2)}%`,
        );
      }
      const lastVsFirstA = (meanA[pc - 1] - meanA[0]) / meanA[0] * 100;
      const lastVsFirstB = (meanB[pc - 1] - meanB[0]) / meanB[0] * 100;
      console.log(`\n  P${pc} − P1 advantage:`);
      console.log(`    Mode A (current planner): ${lastVsFirstA.toFixed(2)}%`);
      console.log(`    Mode B (greedy local):    ${lastVsFirstB.toFixed(2)}%`);
      console.log(`    Amplification (A − B):    ${(lastVsFirstA - lastVsFirstB).toFixed(2)}%`);
    }
  }, 10 * 60 * 1000);
});
