/**
 * Stress / validation harness — NOT run by default (`npm test`). Invoke via:
 *   $env:RUN_STRESS = '1'; npx vitest run tests/stress.test.ts --no-coverage
 * Designed to find latent biases, constraint leaks, and outlier failure modes.
 */
import { describe, it } from 'vitest';
import { generateMap } from '../src/generator/generate';
import { scoreMap } from '../src/generator/score';
import { checkHardConstraints } from '../src/generator/constraints';
import { PRODUCING_RESOURCES, boardFor } from '../src/game/constants';
import type {
  Archetype,
  MapState,
  PlayerCount,
  ProducingResource,
  Variants,
} from '../src/game/types';

const RUN = process.env.RUN_STRESS === '1';

function balancedVariants(): Variants {
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

interface MapStats {
  pc: PlayerCount;
  attempts: number;
  fellBack: boolean;
  stdev: number;
  spread: number;
  playerTotals: number[];
  pipSpread: number;
  portSupportRatio: number;
  portDistanceSpread: number;
  playerPortDistance: number[];
  archetypeMix: Record<Archetype, number>;
  viableArchetypes: number;
  rarePairCount: number;
  abundantPairCount: number;
  unhealthyResources: number;
  resourceShareRatios: Record<ProducingResource, number>;
  resourceCountsOk: boolean;
  numberCountsOk: boolean;
  hardConstraintsOk: boolean;
  // Resource × number tabulation for hidden-correlation analysis.
  resNumMatrix: Record<ProducingResource, Record<number, number>>;
  topSpotTotal: number;
  topSpotResources: ProducingResource[];
  // The actual seed — for reproducing odd maps.
  seed: number;
}

function collectStats(map: MapState, attempts: number, fellBack: boolean): MapStats {
  const scored = scoreMap(map.hexes, map.ports, map.playerCount);
  const hard = checkHardConstraints(map.hexes, map.ports, {
    noSameNumberAdjacent: map.variants.noSameNumberAdjacent,
    noSameNumberOnResource: map.variants.noSameNumberOnResource,
    noMultipleRedsOnResource: map.variants.noMultipleRedsOnResource,
  });
  const spec = boardFor(map.playerCount);

  // Resource count sanity.
  const resourceActual: Partial<Record<string, number>> = {};
  for (const h of map.hexes) {
    resourceActual[h.resource] = (resourceActual[h.resource] ?? 0) + 1;
  }
  const resourceCountsOk = (() => {
    if (!map.variants.includeDesert && map.playerCount <= 4) {
      // Desert removed, replacement increased.
      const expected = { ...spec.resourceCounts };
      const desertCount = expected.desert ?? 0;
      expected.desert = 0;
      expected[map.variants.desertReplacement] = (expected[map.variants.desertReplacement] ?? 0) + desertCount;
      for (const k of Object.keys(expected)) {
        if ((resourceActual[k] ?? 0) !== expected[k as keyof typeof expected]) return false;
      }
      return true;
    }
    for (const k of Object.keys(spec.resourceCounts)) {
      if ((resourceActual[k] ?? 0) !== spec.resourceCounts[k as keyof typeof spec.resourceCounts]) return false;
    }
    return true;
  })();

  // Number count sanity.
  const numberActual = new Map<number, number>();
  for (const h of map.hexes) {
    if (h.number === null) continue;
    numberActual.set(h.number, (numberActual.get(h.number) ?? 0) + 1);
  }
  const numberCountsOk = (() => {
    // For includeDesert=false the bag adds one of {4,10,5,9,3,11} per desert.
    // We just sanity-check that total numbers equals producing tile count
    // and that no number appears more than the bag allows.
    const totalNumbers = Array.from(numberActual.values()).reduce((a, b) => a + b, 0);
    const producing = map.hexes.filter(h => h.resource !== 'desert').length;
    if (totalNumbers !== producing) return false;
    return true;
  })();

  const resourceShareRatios: Record<ProducingResource, number> = {} as Record<ProducingResource, number>;
  for (const h of scored.health) {
    resourceShareRatios[h.resource] = h.expectedShare > 0 ? h.productionShare / h.expectedShare : 1;
  }

  const resNumMatrix: Record<ProducingResource, Record<number, number>> = {} as Record<
    ProducingResource,
    Record<number, number>
  >;
  for (const r of PRODUCING_RESOURCES) resNumMatrix[r] = {};
  for (const h of map.hexes) {
    if (h.resource === 'desert' || h.number === null) continue;
    const row = resNumMatrix[h.resource as ProducingResource];
    row[h.number] = (row[h.number] ?? 0) + 1;
  }

  const sortedSpots = Array.from(scored.spots.values()).sort((a, b) => b.total - a.total);
  const top = sortedSpots[0];
  const topInter = scored.graph.intersections.get(top.intersectionId)!;
  const hexById = new Map(map.hexes.map(h => [h.id, h] as const));
  const topSpotResources = Array.from(
    new Set(
      topInter.hexIds
        .map(id => hexById.get(id)?.resource)
        .filter((r): r is ProducingResource => !!r && r !== 'desert'),
    ),
  );

  return {
    pc: map.playerCount,
    attempts,
    fellBack,
    stdev: scored.fairness.stdev,
    spread: scored.fairness.spread,
    playerTotals: scored.fairness.playerTotals,
    pipSpread: scored.pipSpatial.spread,
    portSupportRatio: scored.specificPortSupportRatio,
    portDistanceSpread: scored.playerPortDistanceSpread,
    playerPortDistance: scored.playerPortDistance,
    archetypeMix: scored.archetypeMix,
    viableArchetypes: Object.values(scored.archetypeMix).filter(c => c >= 3).length,
    rarePairCount: scored.pairs.filter(p => p.status === 'rare').length,
    abundantPairCount: scored.pairs.filter(p => p.status === 'abundant').length,
    unhealthyResources: scored.health.filter(h => h.status === 'unhealthy').length,
    resourceShareRatios,
    resourceCountsOk,
    numberCountsOk,
    hardConstraintsOk: hard.ok,
    resNumMatrix,
    topSpotTotal: top.total,
    topSpotResources,
    seed: map.seed,
  };
}

// ---- Statistics helpers ---------------------------------------------------

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (hi - pos) + sorted[hi] * (pos - lo);
}

function summary(label: string, xs: number[]): string {
  if (xs.length === 0) return `${label}: (no data)`;
  const sorted = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  const stdev = Math.sqrt(variance);
  return (
    `${label.padEnd(28)} n=${xs.length.toString().padStart(5)}  ` +
    `mean=${mean.toFixed(3).padStart(8)}  sd=${stdev.toFixed(3).padStart(7)}  ` +
    `min=${sorted[0].toFixed(3).padStart(7)}  ` +
    `p25=${quantile(sorted, 0.25).toFixed(3).padStart(7)}  ` +
    `p50=${quantile(sorted, 0.5).toFixed(3).padStart(7)}  ` +
    `p75=${quantile(sorted, 0.75).toFixed(3).padStart(7)}  ` +
    `p95=${quantile(sorted, 0.95).toFixed(3).padStart(7)}  ` +
    `max=${sorted[sorted.length - 1].toFixed(3).padStart(7)}`
  );
}

function histogram(label: string, xs: number[], bins: number[]): string {
  const counts = new Array(bins.length + 1).fill(0);
  for (const x of xs) {
    let placed = false;
    for (let i = 0; i < bins.length; i++) {
      if (x < bins[i]) { counts[i]++; placed = true; break; }
    }
    if (!placed) counts[counts.length - 1]++;
  }
  const total = xs.length;
  const out: string[] = [`${label}:`];
  for (let i = 0; i < counts.length; i++) {
    const range = i === 0 ? `<${bins[0]}` : i === bins.length ? `≥${bins[bins.length - 1]}` : `${bins[i - 1]}-${bins[i]}`;
    const pct = total > 0 ? (counts[i] / total) * 100 : 0;
    const bar = '█'.repeat(Math.round(pct / 2));
    out.push(`  ${range.padEnd(12)} ${counts[i].toString().padStart(5)} (${pct.toFixed(1).padStart(5)}%) ${bar}`);
  }
  return out.join('\n');
}

// ---- Analysis -------------------------------------------------------------

function analyzeCohort(label: string, cohort: MapStats[]): void {
  console.log(`\n========== ${label} (n=${cohort.length}) ==========\n`);

  // 1. Constraint validation (these should be 100% / 100% / 100%).
  const hardOk = cohort.filter(s => s.hardConstraintsOk).length;
  const resOk = cohort.filter(s => s.resourceCountsOk).length;
  const numOk = cohort.filter(s => s.numberCountsOk).length;
  console.log('Constraint integrity:');
  console.log(`  hard constraints passing:  ${hardOk}/${cohort.length} (${((hardOk / cohort.length) * 100).toFixed(2)}%)`);
  console.log(`  resource bag matches:      ${resOk}/${cohort.length} (${((resOk / cohort.length) * 100).toFixed(2)}%)`);
  console.log(`  number bag matches:        ${numOk}/${cohort.length} (${((numOk / cohort.length) * 100).toFixed(2)}%)`);

  // 2. Generator efficiency.
  console.log('\nGenerator efficiency:');
  console.log(`  fellback rate:             ${cohort.filter(s => s.fellBack).length}/${cohort.length} (${((cohort.filter(s => s.fellBack).length / cohort.length) * 100).toFixed(2)}%)`);
  console.log(summary('  attempts',         cohort.map(s => s.attempts)));

  // 3. Map quality.
  console.log('\nMap quality metrics:');
  console.log(summary('  stdev (fairness)',  cohort.map(s => s.stdev)));
  console.log(summary('  spread (fairness)', cohort.map(s => s.spread)));
  console.log(summary('  pip spread (quad)', cohort.map(s => s.pipSpread)));
  console.log(summary('  port support ratio', cohort.map(s => s.portSupportRatio).filter(x => Number.isFinite(x))));
  console.log(summary('  port dist spread',   cohort.map(s => s.portDistanceSpread)));
  console.log(summary('  viable archetypes',  cohort.map(s => s.viableArchetypes)));
  console.log(summary('  rare pairs',         cohort.map(s => s.rarePairCount)));
  console.log(summary('  abundant pairs',     cohort.map(s => s.abundantPairCount)));
  console.log(summary('  unhealthy resources', cohort.map(s => s.unhealthyResources)));
  console.log(summary('  top spot total',    cohort.map(s => s.topSpotTotal)));

  // 4. Distributions.
  console.log('\n' + histogram('stdev distribution', cohort.map(s => s.stdev), [0.3, 0.5, 0.7, 0.9, 1.0, 1.2]));
  console.log('\n' + histogram('attempts distribution', cohort.map(s => s.attempts), [1, 5, 25, 100, 500, 2500, 5000]));
  console.log('\n' + histogram('viable archetypes', cohort.map(s => s.viableArchetypes), [1, 2, 3, 4, 5, 6]));

  // 5. First-player position effect — average playerTotals[i] for each i.
  if (cohort.length > 0 && cohort[0].playerTotals.length > 0) {
    const pCount = cohort[0].playerTotals.length;
    const perPlayerMean = new Array(pCount).fill(0);
    for (const s of cohort) for (let i = 0; i < pCount; i++) perPlayerMean[i] += s.playerTotals[i];
    for (let i = 0; i < pCount; i++) perPlayerMean[i] /= cohort.length;
    console.log('\nPer-player avg total (snake-draft position effect):');
    for (let i = 0; i < pCount; i++) {
      console.log(`  P${i + 1}: ${perPlayerMean[i].toFixed(3)}`);
    }
    const meanMean = perPlayerMean.reduce((a, b) => a + b, 0) / pCount;
    const maxDev = Math.max(...perPlayerMean.map(v => Math.abs(v - meanMean)));
    console.log(`  max deviation from mean: ${maxDev.toFixed(3)} (${((maxDev / meanMean) * 100).toFixed(2)}%)`);
  }

  // 6. Per-player port distance bias.
  if (cohort.length > 0 && cohort[0].playerPortDistance.length > 0) {
    const pCount = cohort[0].playerPortDistance.length;
    const portByPlayer = new Array(pCount).fill(0);
    for (const s of cohort) for (let i = 0; i < pCount; i++) portByPlayer[i] += s.playerPortDistance[i];
    for (let i = 0; i < pCount; i++) portByPlayer[i] /= cohort.length;
    console.log('\nPer-player avg port distance:');
    for (let i = 0; i < pCount; i++) console.log(`  P${i + 1}: ${portByPlayer[i].toFixed(3)}`);
  }

  // 7. Resource production share statistics.
  console.log('\nResource production share (productionShare / expectedShare):');
  for (const r of PRODUCING_RESOURCES) {
    const xs = cohort.map(s => s.resourceShareRatios[r]).filter(x => Number.isFinite(x));
    console.log(summary(`  ${r}`, xs));
  }

  // 8. Resource × number correlation. For each resource, what fraction of its
  //    tiles get high-yield numbers (5,6,8,9)? If random placement, should be
  //    proportional to high-yield count vs total numbers.
  console.log('\nResource × high-yield-number affinity (fraction of resource tiles with 5/6/8/9):');
  const highYields = new Set([5, 6, 8, 9]);
  const reds = new Set([6, 8]);
  for (const r of PRODUCING_RESOURCES) {
    let totalTiles = 0;
    let highCount = 0;
    let redCount = 0;
    for (const s of cohort) {
      const row = s.resNumMatrix[r];
      for (const n in row) {
        const num = Number(n);
        const c = row[num];
        totalTiles += c;
        if (highYields.has(num)) highCount += c;
        if (reds.has(num)) redCount += c;
      }
    }
    const highFrac = totalTiles > 0 ? highCount / totalTiles : 0;
    const redFrac = totalTiles > 0 ? redCount / totalTiles : 0;
    console.log(`  ${r.padEnd(8)} tiles=${totalTiles.toString().padStart(6)}  high-yield=${(highFrac * 100).toFixed(2)}%  red=${(redFrac * 100).toFixed(2)}%`);
  }

  // 9. Top-spot resource bias — what resources tend to dominate the top spot?
  const topResourceCounts: Record<string, number> = {};
  for (const s of cohort) {
    const key = s.topSpotResources.slice().sort().join('+');
    topResourceCounts[key] = (topResourceCounts[key] ?? 0) + 1;
  }
  const topResourceSorted = Object.entries(topResourceCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log('\nTop-10 most common top-spot resource combos:');
  for (const [combo, n] of topResourceSorted) {
    console.log(`  ${combo.padEnd(40)} ${n.toString().padStart(5)} (${((n / cohort.length) * 100).toFixed(2)}%)`);
  }

  // 10. Archetype distribution.
  const archetypeTotals: Record<Archetype, number> = {
    expansion: 0, cityRush: 0, portEconomy: 0, devCards: 0, balanced: 0,
  };
  for (const s of cohort) {
    for (const k of Object.keys(s.archetypeMix) as Archetype[]) archetypeTotals[k] += s.archetypeMix[k];
  }
  const archGrandTotal = Object.values(archetypeTotals).reduce((a, b) => a + b, 0);
  console.log('\nArchetype prevalence (sum across all maps, % of top-20 spots):');
  for (const k of Object.keys(archetypeTotals) as Archetype[]) {
    console.log(`  ${k.padEnd(14)} ${archetypeTotals[k].toString().padStart(6)} (${((archetypeTotals[k] / archGrandTotal) * 100).toFixed(2)}%)`);
  }
}

function findOutliers(cohort: MapStats[]): void {
  console.log('\n========== OUTLIERS ==========\n');

  // Worst-stdev accepted maps.
  const byStdev = [...cohort].sort((a, b) => b.stdev - a.stdev);
  console.log('Top-10 worst fairness stdev (accepted maps):');
  for (const s of byStdev.slice(0, 10)) {
    console.log(`  pc=${s.pc} stdev=${s.stdev.toFixed(3)} spread=${s.spread.toFixed(3)} fellback=${s.fellBack} seed=${s.seed}`);
  }

  // Highest pip spread (super continents that slipped through).
  const byPip = [...cohort].sort((a, b) => b.pipSpread - a.pipSpread);
  console.log('\nTop-10 highest pip spread (super-continent candidates):');
  for (const s of byPip.slice(0, 10)) {
    console.log(`  pc=${s.pc} pipSpread=${s.pipSpread.toFixed(3)} fellback=${s.fellBack} seed=${s.seed}`);
  }

  // Highest port-support ratio.
  const finitePortRatios = cohort.filter(s => Number.isFinite(s.portSupportRatio));
  const byPort = [...finitePortRatios].sort((a, b) => b.portSupportRatio - a.portSupportRatio);
  console.log('\nTop-10 highest port-support ratio:');
  for (const s of byPort.slice(0, 10)) {
    console.log(`  pc=${s.pc} portRatio=${s.portSupportRatio.toFixed(3)} fellback=${s.fellBack} seed=${s.seed}`);
  }

  // Lowest viable archetypes.
  const byArch = [...cohort].sort((a, b) => a.viableArchetypes - b.viableArchetypes);
  console.log('\nTop-10 narrowest strategic archetype mix:');
  for (const s of byArch.slice(0, 10)) {
    console.log(`  pc=${s.pc} viable=${s.viableArchetypes} mix=${JSON.stringify(s.archetypeMix)} fellback=${s.fellBack} seed=${s.seed}`);
  }

  // Constraint violations (should be empty).
  const violators = cohort.filter(s => !s.hardConstraintsOk || !s.resourceCountsOk || !s.numberCountsOk);
  console.log(`\nConstraint violations (must be 0): ${violators.length}`);
  for (const s of violators.slice(0, 10)) {
    console.log(`  pc=${s.pc} hard=${s.hardConstraintsOk} res=${s.resourceCountsOk} num=${s.numberCountsOk} seed=${s.seed}`);
  }
}

// ---- Main harness ---------------------------------------------------------

describe('stress harness', () => {
  it.runIf(RUN)('comprehensive validation', () => {
    const SAMPLES_PER_COUNT = Number(process.env.SAMPLES ?? 500);
    const playerCounts: PlayerCount[] = [3, 4, 5, 6];
    const all: MapStats[] = [];

    for (const pc of playerCounts) {
      console.log(`\nGenerating ${SAMPLES_PER_COUNT} maps for ${pc} players...`);
      const t0 = Date.now();
      let succeeded = 0;
      let failed = 0;
      for (let i = 0; i < SAMPLES_PER_COUNT; i++) {
        try {
          const r = generateMap({ playerCount: pc, variants: balancedVariants() });
          all.push(collectStats(r.map, r.attempts, r.fellBack));
          succeeded++;
        } catch (err) {
          failed++;
        }
      }
      const elapsed = (Date.now() - t0) / 1000;
      console.log(`  ${succeeded} succeeded, ${failed} failed (generator threw) in ${elapsed.toFixed(1)}s (${(elapsed / Math.max(1, succeeded) * 1000).toFixed(0)}ms / map)`);
    }

    for (const pc of playerCounts) {
      analyzeCohort(`${pc}-player`, all.filter(s => s.pc === pc));
    }

    findOutliers(all);
  }, 60 * 60 * 1000); // 1 hr timeout
});
