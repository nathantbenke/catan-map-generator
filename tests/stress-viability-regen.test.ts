/** Regen validation for the new k=5 viable-archetype-count diversity gate.
 *
 *  Goal: confirm the new gate
 *    (a) doesn't break the acceptance loop (no fellback spike)
 *    (b) actually counts port-economy as a viable archetype
 *    (c) doesn't introduce regressions in fairness or quality
 *
 *  Compares per-archetype viable counts and gate decisions against the
 *  current production state.
 */
import { describe, it } from 'vitest';
import { generateMap } from '../src/generator/generate';
import { scoreMap } from '../src/generator/score';
import type {
  Archetype,
  PlayerCount,
  Variants,
} from '../src/game/types';

const RUN = process.env.RUN_VIABILITY_REGEN === '1';

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

const ALL: Archetype[] = ['expansion', 'cityRush', 'portEconomy', 'devCards', 'balanced'];

function mean(xs: number[]) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function quantile(xs: number[], q: number) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return s[lo];
  return s[lo] * (hi - pos) + s[hi] * (pos - lo);
}

describe('viability regen validation', () => {
  it.runIf(RUN)('new k=5 gate — acceptance + port-economy visibility', () => {
    const N = Number(process.env.SAMPLES ?? 1000);
    for (const pc of [4, 6] as PlayerCount[]) {
      console.log(`\n===================== pc=${pc} n=${N} =====================`);
      const t0 = Date.now();
      const attempts: number[] = [];
      const fellbacks: number[] = [];
      const stdevs: number[] = [];
      const spreads: number[] = [];
      const viableCounts: Record<Archetype, number[]> = { expansion:[], cityRush:[], portEconomy:[], devCards:[], balanced:[] };
      const archMixCounts: Record<Archetype, number[]> = { expansion:[], cityRush:[], portEconomy:[], devCards:[], balanced:[] };
      const portOpeningCounts: number[] = [];
      const topPortStrengths: number[] = [];
      const archetypesMeetingBar: number[] = [];

      for (let i = 0; i < N; i++) {
        try {
          const r = generateMap({ playerCount: pc, variants: v() });
          attempts.push(r.attempts);
          fellbacks.push(r.fellBack ? 1 : 0);
          const scored = scoreMap(r.map.hexes, r.map.ports, pc);
          stdevs.push(scored.fairness.stdev);
          spreads.push(scored.fairness.spread);
          for (const a of ALL) {
            viableCounts[a].push(scored.viableArchetypeCounts[a]);
            archMixCounts[a].push(scored.archetypeMix[a]);
          }
          portOpeningCounts.push(scored.portEconomyOpenings.length);
          topPortStrengths.push(scored.portEconomyOpenings[0]?.strength ?? 0);
          const meeting = ALL.filter(a => scored.viableArchetypeCounts[a] >= 5).length;
          archetypesMeetingBar.push(meeting);
        } catch {}
      }
      const elapsed = (Date.now() - t0) / 1000;
      console.log(`Generated ${attempts.length} maps in ${elapsed.toFixed(1)}s (${(elapsed / attempts.length * 1000).toFixed(0)} ms/map)`);

      console.log(`\nAcceptance:`);
      console.log(`  attempts:    mean=${mean(attempts).toFixed(1)}  p50=${quantile(attempts, 0.5).toFixed(0)}  p95=${quantile(attempts, 0.95).toFixed(0)}  max=${Math.max(...attempts)}`);
      console.log(`  fellback:    ${fellbacks.reduce((a, b) => a + b, 0)} / ${fellbacks.length} (${(mean(fellbacks) * 100).toFixed(1)}%)`);

      console.log(`\nFairness:`);
      console.log(`  stdev:  mean=${mean(stdevs).toFixed(3)}  p50=${quantile(stdevs, 0.5).toFixed(3)}  p95=${quantile(stdevs, 0.95).toFixed(3)}`);
      console.log(`  spread: mean=${mean(spreads).toFixed(3)}  p50=${quantile(spreads, 0.5).toFixed(3)}  p95=${quantile(spreads, 0.95).toFixed(3)}`);

      console.log(`\nViable archetype counts (NEW gate metric, k=5 bar):`);
      console.log(`  archetype       mean    p25    p50    p75   maps with ≥5`);
      for (const a of ALL) {
        const xs = viableCounts[a];
        const pctMeeting = xs.filter(x => x >= 5).length / xs.length * 100;
        console.log(`  ${a.padEnd(14)} ${mean(xs).toFixed(2).padStart(5)}   ${quantile(xs, 0.25).toFixed(1).padStart(4)}   ${quantile(xs, 0.5).toFixed(1).padStart(4)}   ${quantile(xs, 0.75).toFixed(1).padStart(4)}   ${pctMeeting.toFixed(1)}%`);
      }

      console.log(`\nTop-20 archetypeMix (OLD UI display metric, kept for reference):`);
      console.log(`  archetype       mean    p50`);
      for (const a of ALL) {
        const xs = archMixCounts[a];
        console.log(`  ${a.padEnd(14)} ${mean(xs).toFixed(2).padStart(5)}   ${quantile(xs, 0.5).toFixed(1).padStart(4)}`);
      }

      console.log(`\nGate decision distribution:`);
      const at0 = archetypesMeetingBar.filter(c => c === 0).length;
      const at1 = archetypesMeetingBar.filter(c => c === 1).length;
      const at2 = archetypesMeetingBar.filter(c => c === 2).length;
      const at3 = archetypesMeetingBar.filter(c => c === 3).length;
      const at4 = archetypesMeetingBar.filter(c => c === 4).length;
      const at5 = archetypesMeetingBar.filter(c => c === 5).length;
      const totalMaps = archetypesMeetingBar.length;
      console.log(`  archetypes meeting k=5 bar:`);
      console.log(`    0: ${at0} (${(at0 / totalMaps * 100).toFixed(1)}%)`);
      console.log(`    1: ${at1} (${(at1 / totalMaps * 100).toFixed(1)}%)`);
      console.log(`    2: ${at2} (${(at2 / totalMaps * 100).toFixed(1)}%)`);
      console.log(`    3: ${at3} (${(at3 / totalMaps * 100).toFixed(1)}%)`);
      console.log(`    4: ${at4} (${(at4 / totalMaps * 100).toFixed(1)}%)`);
      console.log(`    5: ${at5} (${(at5 / totalMaps * 100).toFixed(1)}%)`);

      console.log(`\nPort-economy diagnostic surface:`);
      console.log(`  port-economy openings per map: mean=${mean(portOpeningCounts).toFixed(1)}  p50=${quantile(portOpeningCounts, 0.5).toFixed(0)}`);
      console.log(`  top port-economy strength:     mean=${mean(topPortStrengths).toFixed(2)}  p50=${quantile(topPortStrengths, 0.5).toFixed(2)}  p95=${quantile(topPortStrengths, 0.95).toFixed(2)}`);
    }
  }, 30 * 60 * 1000);
});
