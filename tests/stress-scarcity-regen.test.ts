/** Full regeneration validation: Config A (current production, tile=0.5,
 *  pip=0.06) vs Config E (tile=0, pip=0.10). Two independent generation
 *  runs of N maps each. No re-scoring — every map's score is determined
 *  by the generator under that config, so the accepted-map population is
 *  what we measure.
 */
import { describe, it } from 'vitest';
import { generateMap } from '../src/generator/generate';
import { scoreMap, DEFAULT_SCARCITY_CONFIG, type ScarcityConfig } from '../src/generator/score';
import { PIP_VALUE } from '../src/game/constants';
import type {
  Archetype,
  Hex,
  PlayerCount,
  ProducingResource,
  Variants,
} from '../src/game/types';

const RUN = process.env.RUN_SCARCITY_REGEN === '1';

const CONFIG_A: ScarcityConfig = DEFAULT_SCARCITY_CONFIG;       // tile=0.5, pip=0.06
const CONFIG_E: ScarcityConfig = { tileWeight: 0, pipWeight: 0.10 };

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

interface MapStats {
  attempts: number;
  fellBack: boolean;
  stdev: number;
  spread: number;
  playerTotals: number[];
  pipSpread: number;
  portSupportRatio: number;
  portDistanceSpread: number;
  archetypeMix: Record<Archetype, number>;
  viableArchetypes: number;
  unhealthyResources: number;
  resourceShareRatios: Record<ProducingResource, number>;
  // Resource × number tabulation.
  resPipSum: Record<ProducingResource, number>;
  resTiles: Record<ProducingResource, number>;
  // High-yield count per resource.
  resHighYield: Record<ProducingResource, number>;
  resRed: Record<ProducingResource, number>;
  // Top-spot info.
  topSpotResources: ProducingResource[];
  topSpotPipValue: number;
  topSpotTotal: number;
  top5Combos: string[];
  top10Combos: string[];
  top20Combos: string[];
  // Port-economy presence in top-20.
  portEconomyInTop20: number;
}

const HIGH_YIELDS = new Set([5, 6, 8, 9]);
const REDS = new Set([6, 8]);

function collectStats(
  map: Awaited<ReturnType<typeof generateMap>>['map'],
  attempts: number,
  fellBack: boolean,
  scarcity: ScarcityConfig,
): MapStats {
  const scored = scoreMap(map.hexes, map.ports, map.playerCount, scarcity);
  const hexById = new Map(map.hexes.map(h => [h.id, h] as const));

  const resourceShareRatios: Record<ProducingResource, number> = {
    wood: 1, brick: 1, wheat: 1, sheep: 1, ore: 1,
  };
  for (const h of scored.health) {
    resourceShareRatios[h.resource] = h.expectedShare > 0 ? h.productionShare / h.expectedShare : 1;
  }

  const resPipSum: Record<ProducingResource, number> = { wood:0, brick:0, wheat:0, sheep:0, ore:0 };
  const resTiles: Record<ProducingResource, number> = { wood:0, brick:0, wheat:0, sheep:0, ore:0 };
  const resHighYield: Record<ProducingResource, number> = { wood:0, brick:0, wheat:0, sheep:0, ore:0 };
  const resRed: Record<ProducingResource, number> = { wood:0, brick:0, wheat:0, sheep:0, ore:0 };
  for (const h of map.hexes) {
    if (h.resource === 'desert' || h.number === null) continue;
    const r = h.resource as ProducingResource;
    resTiles[r]++;
    resPipSum[r] += PIP_VALUE[h.number] ?? 0;
    if (HIGH_YIELDS.has(h.number)) resHighYield[r]++;
    if (REDS.has(h.number)) resRed[r]++;
  }

  const sortedSpots = Array.from(scored.spots.values()).sort((a, b) => b.total - a.total);
  const top = sortedSpots[0];
  const topInter = scored.graph.intersections.get(top.intersectionId)!;
  const topSpotResources = Array.from(
    new Set(
      topInter.hexIds
        .map(id => hexById.get(id)?.resource)
        .filter((r): r is ProducingResource => !!r && r !== 'desert'),
    ),
  );

  function comboKey(spotId: string): string {
    const inter = scored.graph.intersections.get(spotId);
    if (!inter) return '?';
    const r = new Set<string>();
    for (const hexId of inter.hexIds) {
      const h = hexById.get(hexId);
      if (h && h.resource !== 'desert') r.add(h.resource);
    }
    return Array.from(r).sort().join('+');
  }

  return {
    attempts, fellBack,
    stdev: scored.fairness.stdev,
    spread: scored.fairness.spread,
    playerTotals: scored.fairness.playerTotals,
    pipSpread: scored.pipSpatial.spread,
    portSupportRatio: scored.specificPortSupportRatio,
    portDistanceSpread: scored.playerPortDistanceSpread,
    archetypeMix: scored.archetypeMix,
    viableArchetypes: Object.values(scored.archetypeMix).filter(c => c >= 3).length,
    unhealthyResources: scored.health.filter(h => h.status === 'unhealthy').length,
    resourceShareRatios,
    resPipSum, resTiles, resHighYield, resRed,
    topSpotResources,
    topSpotPipValue: top.pipValue,
    topSpotTotal: top.total,
    top5Combos: sortedSpots.slice(0, 5).map(s => comboKey(s.intersectionId)),
    top10Combos: sortedSpots.slice(0, 10).map(s => comboKey(s.intersectionId)),
    top20Combos: sortedSpots.slice(0, 20).map(s => comboKey(s.intersectionId)),
    portEconomyInTop20: sortedSpots.slice(0, 20).filter(s => s.archetype === 'portEconomy').length,
  };
}

// --- Stats helpers ---------------------------------------------------------

function mean(xs: number[]) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function quantile(xs: number[], q: number) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return s[lo];
  return s[lo] * (hi - pos) + s[hi] * (pos - lo);
}

function summary(xs: number[]) {
  return {
    mean: mean(xs),
    p50: quantile(xs, 0.5),
    p95: quantile(xs, 0.95),
    min: xs.length ? Math.min(...xs) : 0,
    max: xs.length ? Math.max(...xs) : 0,
  };
}

function comboKey(rs: ProducingResource[]) { return [...rs].sort().join('+'); }

function comparisonRow(label: string, a: number, e: number, fmt: (n: number) => string = n => n.toFixed(3)) {
  const delta = e - a;
  const sign = delta >= 0 ? '+' : '';
  return `  ${label.padEnd(38)} A=${fmt(a).padStart(8)}  E=${fmt(e).padStart(8)}  Δ=${sign}${fmt(delta).padStart(7)}`;
}

// --- Main harness ----------------------------------------------------------

describe('scarcity regeneration', () => {
  it.runIf(RUN)('Config A vs Config E — full regeneration', () => {
    const N = Number(process.env.SAMPLES ?? 1000);
    const PC: PlayerCount = 4;

    function runConfig(label: string, scarcity: ScarcityConfig): MapStats[] {
      console.log(`\nGenerating ${N} maps for pc=${PC} under ${label}...`);
      const t0 = Date.now();
      const out: MapStats[] = [];
      let failed = 0;
      for (let i = 0; i < N; i++) {
        try {
          const r = generateMap({ playerCount: PC, variants: defaultVariants(), scarcityConfig: scarcity });
          out.push(collectStats(r.map, r.attempts, r.fellBack, scarcity));
        } catch { failed++; }
      }
      const elapsed = (Date.now() - t0) / 1000;
      console.log(`  ${out.length} succeeded, ${failed} threw, ${elapsed.toFixed(1)}s (${(elapsed / Math.max(1, out.length) * 1000).toFixed(0)} ms/map)`);
      return out;
    }

    const A = runConfig('Config A (baseline: tile=0.5, pip=0.06)', CONFIG_A);
    const E = runConfig('Config E (tile=0,   pip=0.10)', CONFIG_E);

    // -------------------------------------------------------------------
    // 1) Acceptance rate (= fellBack RATE inverted; throwing rate)
    // -------------------------------------------------------------------
    console.log('\n========== 1) ACCEPTANCE METRICS ==========');
    const A_fb = A.filter(s => s.fellBack).length;
    const E_fb = E.filter(s => s.fellBack).length;
    console.log(`  Config A: ${A.length} accepted (n requested ${N}), fellback ${A_fb} (${(A_fb / A.length * 100).toFixed(2)}%)`);
    console.log(`  Config E: ${E.length} accepted (n requested ${N}), fellback ${E_fb} (${(E_fb / E.length * 100).toFixed(2)}%)`);

    // -------------------------------------------------------------------
    // 2) Attempts per accepted map
    // -------------------------------------------------------------------
    console.log('\n========== 2) ATTEMPTS PER MAP ==========');
    const aA = A.map(s => s.attempts), aE = E.map(s => s.attempts);
    const sA = summary(aA), sE = summary(aE);
    console.log(`  Config A: mean=${sA.mean.toFixed(1)}  p50=${sA.p50.toFixed(0)}  p95=${sA.p95.toFixed(0)}  max=${sA.max.toFixed(0)}`);
    console.log(`  Config E: mean=${sE.mean.toFixed(1)}  p50=${sE.p50.toFixed(0)}  p95=${sE.p95.toFixed(0)}  max=${sE.max.toFixed(0)}`);
    console.log(`  Δ mean: ${(sE.mean - sA.mean >= 0 ? '+' : '') + (sE.mean - sA.mean).toFixed(1)} attempts`);

    // -------------------------------------------------------------------
    // 3) Brick+Ore frequency  /  4) Sheep+Wheat+Wood
    // -------------------------------------------------------------------
    console.log('\n========== 3-4) TOP-SPOT COMBO FREQUENCIES ==========');
    function combine(stats: MapStats[], filter: (combo: string) => boolean): number {
      const n = stats.filter(s => filter(comboKey(s.topSpotResources))).length;
      return (n / stats.length) * 100;
    }
    const A_bo = combine(A, c => c.includes('brick') && c.includes('ore'));
    const E_bo = combine(E, c => c.includes('brick') && c.includes('ore'));
    const A_sww = combine(A, c => c === 'sheep+wheat+wood');
    const E_sww = combine(E, c => c === 'sheep+wheat+wood');
    const A_bw = combine(A, c => c.includes('brick') && c.includes('wood') && !c.includes('ore'));
    const E_bw = combine(E, c => c.includes('brick') && c.includes('wood') && !c.includes('ore'));
    const A_ow = combine(A, c => c.includes('ore') && c.includes('wheat') && !c.includes('brick'));
    const E_ow = combine(E, c => c.includes('ore') && c.includes('wheat') && !c.includes('brick'));
    const A_osw = combine(A, c => c === 'ore+sheep+wheat');
    const E_osw = combine(E, c => c === 'ore+sheep+wheat');
    console.log(comparisonRow('brick+ore (top spot)',          A_bo, E_bo, n => n.toFixed(1) + '%'));
    console.log(comparisonRow('brick+wood (no ore)',           A_bw, E_bw, n => n.toFixed(1) + '%'));
    console.log(comparisonRow('ore+wheat (no brick)',          A_ow, E_ow, n => n.toFixed(1) + '%'));
    console.log(comparisonRow('sheep+wheat+wood',              A_sww, E_sww, n => n.toFixed(2) + '%'));
    console.log(comparisonRow('ore+sheep+wheat',               A_osw, E_osw, n => n.toFixed(1) + '%'));

    // Top-10 most common top spots per config
    console.log('\n  Top-10 most-common TOP-SPOT combos:');
    function topComboList(stats: MapStats[]): Array<[string, number]> {
      const m = new Map<string, number>();
      for (const s of stats) {
        const k = comboKey(s.topSpotResources);
        m.set(k, (m.get(k) ?? 0) + 1);
      }
      return Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
    }
    const aL = topComboList(A), eL = topComboList(E);
    console.log('  Config A                                       Config E');
    for (let i = 0; i < 10; i++) {
      const a = aL[i] ?? ['', 0];
      const e = eL[i] ?? ['', 0];
      const aStr = `${a[0].padEnd(20)} ${((a[1] / A.length) * 100).toFixed(1).padStart(5)}%`;
      const eStr = `${e[0].padEnd(20)} ${((e[1] / E.length) * 100).toFixed(1).padStart(5)}%`;
      console.log(`  ${aStr}    ${eStr}`);
    }

    // -------------------------------------------------------------------
    // 5) Player position bias
    // -------------------------------------------------------------------
    console.log('\n========== 5) PLAYER POSITION BIAS ==========');
    function playerAvgs(stats: MapStats[]): number[] {
      const sums = new Array(PC).fill(0);
      for (const s of stats) for (let i = 0; i < PC; i++) sums[i] += s.playerTotals[i];
      return sums.map(x => x / stats.length);
    }
    const pA = playerAvgs(A), pE = playerAvgs(E);
    const ovA = pA.reduce((a, b) => a + b, 0) / PC;
    const ovE = pE.reduce((a, b) => a + b, 0) / PC;
    for (let i = 0; i < PC; i++) {
      const devA = (pA[i] - ovA) / ovA * 100;
      const devE = (pE[i] - ovE) / ovE * 100;
      console.log(`  P${i + 1}     A: ${pA[i].toFixed(3)} (${(devA >= 0 ? '+' : '') + devA.toFixed(2)}%)   E: ${pE[i].toFixed(3)} (${(devE >= 0 ? '+' : '') + devE.toFixed(2)}%)`);
    }
    const lastA = (pA[PC - 1] - pA[0]) / pA[0] * 100;
    const lastE = (pE[PC - 1] - pE[0]) / pE[0] * 100;
    console.log(`  P${PC} − P1 advantage:  A=${lastA.toFixed(2)}%   E=${lastE.toFixed(2)}%   Δ=${((lastE - lastA) >= 0 ? '+' : '') + (lastE - lastA).toFixed(2)}pp`);

    // -------------------------------------------------------------------
    // 6) Fairness stdev distribution
    // -------------------------------------------------------------------
    console.log('\n========== 6) FAIRNESS STDEV ==========');
    const stA = summary(A.map(s => s.stdev));
    const stE = summary(E.map(s => s.stdev));
    console.log(`  Config A  mean=${stA.mean.toFixed(3)}  p50=${stA.p50.toFixed(3)}  p95=${stA.p95.toFixed(3)}  max=${stA.max.toFixed(3)}`);
    console.log(`  Config E  mean=${stE.mean.toFixed(3)}  p50=${stE.p50.toFixed(3)}  p95=${stE.p95.toFixed(3)}  max=${stE.max.toFixed(3)}`);
    console.log(`  Δ mean: ${(stE.mean - stA.mean >= 0 ? '+' : '') + (stE.mean - stA.mean).toFixed(3)}`);
    const spA = summary(A.map(s => s.spread));
    const spE = summary(E.map(s => s.spread));
    console.log(`  Spread A  mean=${spA.mean.toFixed(3)}  p95=${spA.p95.toFixed(3)}`);
    console.log(`  Spread E  mean=${spE.mean.toFixed(3)}  p95=${spE.p95.toFixed(3)}`);

    // -------------------------------------------------------------------
    // 7) Resource production share
    // -------------------------------------------------------------------
    console.log('\n========== 7) RESOURCE PRODUCTION SHARE ==========');
    const resources: ProducingResource[] = ['wood','brick','wheat','sheep','ore'];
    console.log('  Resource    A pip/tile  A share-ratio    E pip/tile  E share-ratio    Δ pip/tile');
    for (const r of resources) {
      const Asum = A.reduce((s, m) => s + m.resPipSum[r], 0);
      const Atc = A.reduce((s, m) => s + m.resTiles[r], 0);
      const Aavg = Atc > 0 ? Asum / Atc : 0;
      const Asha = mean(A.map(s => s.resourceShareRatios[r]));

      const Esum = E.reduce((s, m) => s + m.resPipSum[r], 0);
      const Etc = E.reduce((s, m) => s + m.resTiles[r], 0);
      const Eavg = Etc > 0 ? Esum / Etc : 0;
      const Esha = mean(E.map(s => s.resourceShareRatios[r]));

      console.log(`  ${r.padEnd(10)} ${Aavg.toFixed(3).padStart(10)}  ${Asha.toFixed(3).padStart(13)}  ${Eavg.toFixed(3).padStart(13)}  ${Esha.toFixed(3).padStart(14)}  ${(Eavg - Aavg >= 0 ? '+' : '') + (Eavg - Aavg).toFixed(3)}`);
    }

    // -------------------------------------------------------------------
    // High-yield distribution
    // -------------------------------------------------------------------
    console.log('\n  Resource × high-yield (5/6/8/9) frequency:');
    console.log('  Resource      A high%   A red%      E high%   E red%      Δ high%');
    for (const r of resources) {
      const Atc = A.reduce((s, m) => s + m.resTiles[r], 0);
      const Ahy = A.reduce((s, m) => s + m.resHighYield[r], 0);
      const Ard = A.reduce((s, m) => s + m.resRed[r], 0);
      const Etc = E.reduce((s, m) => s + m.resTiles[r], 0);
      const Ehy = E.reduce((s, m) => s + m.resHighYield[r], 0);
      const Erd = E.reduce((s, m) => s + m.resRed[r], 0);
      const Ah = Atc > 0 ? (Ahy / Atc * 100) : 0;
      const Ar = Atc > 0 ? (Ard / Atc * 100) : 0;
      const Eh = Etc > 0 ? (Ehy / Etc * 100) : 0;
      const Er = Etc > 0 ? (Erd / Etc * 100) : 0;
      console.log(`  ${r.padEnd(10)}  ${Ah.toFixed(2).padStart(7)}%  ${Ar.toFixed(2).padStart(6)}%      ${Eh.toFixed(2).padStart(7)}%  ${Er.toFixed(2).padStart(6)}%      ${(Eh - Ah >= 0 ? '+' : '') + (Eh - Ah).toFixed(2)}pp`);
    }

    // -------------------------------------------------------------------
    // 8) Archetype diversity
    // -------------------------------------------------------------------
    console.log('\n========== 8) ARCHETYPE DIVERSITY ==========');
    function archShares(stats: MapStats[]): Record<Archetype, number> {
      const tot: Record<Archetype, number> = { expansion:0, cityRush:0, portEconomy:0, devCards:0, balanced:0 };
      for (const s of stats) for (const k of Object.keys(s.archetypeMix) as Archetype[]) tot[k] += s.archetypeMix[k];
      const sum = Object.values(tot).reduce((a, b) => a + b, 0) || 1;
      const out: Record<Archetype, number> = { expansion:0, cityRush:0, portEconomy:0, devCards:0, balanced:0 };
      for (const k of Object.keys(tot) as Archetype[]) out[k] = (tot[k] / sum) * 100;
      return out;
    }
    const ASh = archShares(A), ESh = archShares(E);
    console.log('  Archetype       Config A    Config E    Δ');
    for (const k of ['expansion','cityRush','portEconomy','devCards','balanced'] as Archetype[]) {
      console.log(`  ${k.padEnd(14)} ${ASh[k].toFixed(2).padStart(7)}%   ${ESh[k].toFixed(2).padStart(7)}%   ${(ESh[k] - ASh[k] >= 0 ? '+' : '') + (ESh[k] - ASh[k]).toFixed(2)}pp`);
    }

    console.log('\n  Viable archetypes (count ≥ 3):');
    console.log(comparisonRow('  avg viable archetypes per map',
      mean(A.map(s => s.viableArchetypes)), mean(E.map(s => s.viableArchetypes))));

    // -------------------------------------------------------------------
    // 9) Port economy visibility (top-20)
    // -------------------------------------------------------------------
    console.log('\n========== 9) PORT ECONOMY VISIBILITY ==========');
    const A_peTop20 = mean(A.map(s => s.portEconomyInTop20));
    const E_peTop20 = mean(E.map(s => s.portEconomyInTop20));
    console.log(`  avg portEconomy spots in top-20:  A=${A_peTop20.toFixed(2)}   E=${E_peTop20.toFixed(2)}   Δ=${(E_peTop20 - A_peTop20 >= 0 ? '+' : '') + (E_peTop20 - A_peTop20).toFixed(2)}`);

    // -------------------------------------------------------------------
    // 10) Distribution of top-5 and top-10 openings
    // -------------------------------------------------------------------
    console.log('\n========== 10) TOP-N OPENING DIVERSITY ==========');
    function topNDiversity(stats: MapStats[], n: 5 | 10 | 20): { entropy: number; unique: number; pctBO: number; pctSWW: number } {
      let totEnt = 0, totUniq = 0, totBO = 0, totSWW = 0;
      for (const s of stats) {
        const combos = (n === 5 ? s.top5Combos : n === 10 ? s.top10Combos : s.top20Combos);
        totUniq += new Set(combos).size;
        const cnt = new Map<string, number>();
        for (const c of combos) cnt.set(c, (cnt.get(c) ?? 0) + 1);
        let e = 0;
        for (const c of cnt.values()) { const p = c / n; if (p > 0) e -= p * Math.log2(p); }
        totEnt += e;
        totBO += combos.filter(c => c.includes('brick') && c.includes('ore')).length;
        totSWW += combos.filter(c => c === 'sheep+wheat+wood').length;
      }
      return {
        entropy: totEnt / stats.length,
        unique: totUniq / stats.length,
        pctBO: totBO / stats.length,
        pctSWW: totSWW / stats.length,
      };
    }
    for (const n of [5, 10, 20] as const) {
      const a = topNDiversity(A, n), e = topNDiversity(E, n);
      console.log(`  Top-${n}:`);
      console.log(`    entropy:        A=${a.entropy.toFixed(3)}  E=${e.entropy.toFixed(3)}  Δ=${(e.entropy - a.entropy >= 0 ? '+' : '') + (e.entropy - a.entropy).toFixed(3)}  (max ${Math.log2(n).toFixed(3)})`);
      console.log(`    unique combos:  A=${a.unique.toFixed(2)}  E=${e.unique.toFixed(2)}  Δ=${(e.unique - a.unique >= 0 ? '+' : '') + (e.unique - a.unique).toFixed(2)}`);
      console.log(`    avg brick+ore:  A=${a.pctBO.toFixed(2)}  E=${e.pctBO.toFixed(2)}  Δ=${(e.pctBO - a.pctBO >= 0 ? '+' : '') + (e.pctBO - a.pctBO).toFixed(2)}`);
      console.log(`    avg sww:        A=${a.pctSWW.toFixed(2)}  E=${e.pctSWW.toFixed(2)}  Δ=${(e.pctSWW - a.pctSWW >= 0 ? '+' : '') + (e.pctSWW - a.pctSWW).toFixed(2)}`);
    }

    // -------------------------------------------------------------------
    // Quality / regression detection
    // -------------------------------------------------------------------
    console.log('\n========== QUALITY / REGRESSION INDICATORS ==========');
    console.log(comparisonRow('avg pip spread (quadrant)',
      mean(A.map(s => s.pipSpread)), mean(E.map(s => s.pipSpread))));
    console.log(comparisonRow('avg port support ratio',
      mean(A.map(s => Number.isFinite(s.portSupportRatio) ? s.portSupportRatio : 0)),
      mean(E.map(s => Number.isFinite(s.portSupportRatio) ? s.portSupportRatio : 0))));
    console.log(comparisonRow('avg port distance spread',
      mean(A.map(s => s.portDistanceSpread)), mean(E.map(s => s.portDistanceSpread))));
    console.log(comparisonRow('avg unhealthy resources',
      mean(A.map(s => s.unhealthyResources)), mean(E.map(s => s.unhealthyResources))));
    console.log(comparisonRow('avg top-spot pipValue',
      mean(A.map(s => s.topSpotPipValue)), mean(E.map(s => s.topSpotPipValue))));
    console.log(comparisonRow('avg top-spot total',
      mean(A.map(s => s.topSpotTotal)), mean(E.map(s => s.topSpotTotal))));
  }, 60 * 60 * 1000);
});
