/** spreadHighYield bias investigation.
 *
 *  Hypothesis: the current 'byCount' spread strategy systematically gives
 *  3-tile resources (brick, ore) a higher per-tile high-yield rate than
 *  4-tile resources (wood, wheat, sheep). 8 high-yields / 5 resources ≈ 1.6
 *  each; for 4-tile resources that's 40% rate, for 3-tile it's 53% rate.
 *  This ~30% per-tile pip advantage may be the root structural cause of
 *  the remaining 36.6% brick+ore top-spot dominance after Config E.
 *
 *  Question we're answering: is the remaining 36.6% HEALTHY (real Catan
 *  asymmetry — brick/ore tiles are individually more valuable because the
 *  bag rules give them fewer tiles) or an ARTIFACT (the spread strategy
 *  amplifies a tiny edge into a 30% per-tile rate gap)?
 *
 *  3-way controlled regeneration:
 *    'off'     — no spread preference (uniform random placement)
 *    'byCount' — current production (equalize count per resource)
 *    'byRate'  — equalize per-tile rate (proportional to tile count)
 */
import { describe, it } from 'vitest';
import { generateMap } from '../src/generator/generate';
import { scoreMap } from '../src/generator/score';
import { PIP_VALUE } from '../src/game/constants';
import type {
  Archetype,
  Hex,
  PlayerCount,
  ProducingResource,
  Variants,
} from '../src/game/types';
import type { SpreadHighYieldMode } from '../src/generator/randomize';

const RUN = process.env.RUN_SPREAD === '1';

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

const HIGH_YIELDS = new Set([5, 6, 8, 9]);
const REDS = new Set([6, 8]);
const RESOURCES: ProducingResource[] = ['wood','brick','wheat','sheep','ore'];

interface MapStats {
  attempts: number;
  fellBack: boolean;
  stdev: number;
  spread: number;
  playerTotals: number[];
  resPipSum: Record<ProducingResource, number>;
  resTiles: Record<ProducingResource, number>;
  resHighYieldCount: Record<ProducingResource, number>;
  resRedCount: Record<ProducingResource, number>;
  resShareRatio: Record<ProducingResource, number>;
  archetypeMix: Record<Archetype, number>;
  topSpotCombo: string;
  topSpotPipValue: number;
  unhealthyResources: number;
  pipSpread: number;
  // For "top spot resource" analysis we record the actual #1 spot's
  // composition so we can tell what types of spots win.
}

function collect(map: Awaited<ReturnType<typeof generateMap>>['map'], attempts: number, fellBack: boolean): MapStats {
  const scored = scoreMap(map.hexes, map.ports, map.playerCount);
  const hexById = new Map(map.hexes.map(h => [h.id, h] as const));

  const resPipSum: Record<ProducingResource, number> = { wood:0, brick:0, wheat:0, sheep:0, ore:0 };
  const resTiles: Record<ProducingResource, number> = { wood:0, brick:0, wheat:0, sheep:0, ore:0 };
  const resHighYieldCount: Record<ProducingResource, number> = { wood:0, brick:0, wheat:0, sheep:0, ore:0 };
  const resRedCount: Record<ProducingResource, number> = { wood:0, brick:0, wheat:0, sheep:0, ore:0 };
  for (const h of map.hexes) {
    if (h.resource === 'desert' || h.number === null) continue;
    const r = h.resource as ProducingResource;
    resTiles[r]++;
    resPipSum[r] += PIP_VALUE[h.number] ?? 0;
    if (HIGH_YIELDS.has(h.number)) resHighYieldCount[r]++;
    if (REDS.has(h.number)) resRedCount[r]++;
  }
  const resShareRatio: Record<ProducingResource, number> = { wood:1, brick:1, wheat:1, sheep:1, ore:1 };
  for (const h of scored.health) {
    resShareRatio[h.resource] = h.expectedShare > 0 ? h.productionShare / h.expectedShare : 1;
  }

  const sortedSpots = Array.from(scored.spots.values()).sort((a, b) => b.total - a.total);
  const top = sortedSpots[0];
  const topInter = scored.graph.intersections.get(top.intersectionId)!;
  const topRes = Array.from(new Set(
    topInter.hexIds.map(id => hexById.get(id)?.resource).filter((r): r is ProducingResource => !!r && r !== 'desert'),
  )).sort();

  return {
    attempts, fellBack,
    stdev: scored.fairness.stdev,
    spread: scored.fairness.spread,
    playerTotals: scored.fairness.playerTotals,
    resPipSum, resTiles, resHighYieldCount, resRedCount, resShareRatio,
    archetypeMix: scored.archetypeMix,
    topSpotCombo: topRes.join('+'),
    topSpotPipValue: top.pipValue,
    unhealthyResources: scored.health.filter(h => h.status === 'unhealthy').length,
    pipSpread: scored.pipSpatial.spread,
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

describe('spread mode investigation', () => {
  it.runIf(RUN)('off vs byCount vs byRate — full regeneration', () => {
    const N = Number(process.env.SAMPLES ?? 1000);
    const PC: PlayerCount = 4;

    function runMode(label: string, mode: SpreadHighYieldMode): MapStats[] {
      console.log(`\nGenerating ${N} maps for pc=${PC} under spreadMode=${mode}...`);
      const t0 = Date.now();
      const out: MapStats[] = [];
      let failed = 0;
      for (let i = 0; i < N; i++) {
        try {
          const r = generateMap({
            playerCount: PC,
            variants: v(),
            spreadHighYieldMode: mode,
          });
          out.push(collect(r.map, r.attempts, r.fellBack));
        } catch { failed++; }
      }
      const elapsed = (Date.now() - t0) / 1000;
      console.log(`  ${out.length} succeeded, ${failed} threw, ${elapsed.toFixed(1)}s`);
      return out;
    }

    const off = runMode('off', 'off');
    const byCount = runMode('byCount', 'byCount');
    const byRate = runMode('byRate', 'byRate');

    // -------------------------------------------------------------------
    // 1) PER-TILE high-yield rate by resource (the structural bias)
    // -------------------------------------------------------------------
    console.log('\n========== 1) PER-TILE HIGH-YIELD RATE BY RESOURCE ==========');
    console.log('Resource       off             byCount         byRate');
    for (const r of RESOURCES) {
      const offTiles = off.reduce((s, m) => s + m.resTiles[r], 0);
      const offHy    = off.reduce((s, m) => s + m.resHighYieldCount[r], 0);
      const bcTiles  = byCount.reduce((s, m) => s + m.resTiles[r], 0);
      const bcHy     = byCount.reduce((s, m) => s + m.resHighYieldCount[r], 0);
      const brTiles  = byRate.reduce((s, m) => s + m.resTiles[r], 0);
      const brHy     = byRate.reduce((s, m) => s + m.resHighYieldCount[r], 0);
      const offPct = offTiles > 0 ? (offHy / offTiles * 100) : 0;
      const bcPct  = bcTiles > 0 ? (bcHy / bcTiles * 100) : 0;
      const brPct  = brTiles > 0 ? (brHy / brTiles * 100) : 0;
      console.log(`  ${r.padEnd(10)} ${offPct.toFixed(2).padStart(6)}% (HY/n=${(offHy / off.length).toFixed(2)})   ${bcPct.toFixed(2).padStart(6)}% (HY/n=${(bcHy / byCount.length).toFixed(2)})   ${brPct.toFixed(2).padStart(6)}% (HY/n=${(brHy / byRate.length).toFixed(2)})`);
    }

    // -------------------------------------------------------------------
    // 2) PER-TILE PIP AVERAGE by resource (the gameplay consequence)
    // -------------------------------------------------------------------
    console.log('\n========== 2) PER-TILE PIP AVERAGE BY RESOURCE ==========');
    console.log('Resource       off       byCount    byRate     Δ(byRate − byCount)');
    for (const r of RESOURCES) {
      const offAvg = off.reduce((s, m) => s + m.resPipSum[r], 0) / Math.max(1, off.reduce((s, m) => s + m.resTiles[r], 0));
      const bcAvg  = byCount.reduce((s, m) => s + m.resPipSum[r], 0) / Math.max(1, byCount.reduce((s, m) => s + m.resTiles[r], 0));
      const brAvg  = byRate.reduce((s, m) => s + m.resPipSum[r], 0) / Math.max(1, byRate.reduce((s, m) => s + m.resTiles[r], 0));
      const d = brAvg - bcAvg;
      console.log(`  ${r.padEnd(10)} ${offAvg.toFixed(3).padStart(7)}  ${bcAvg.toFixed(3).padStart(7)}    ${brAvg.toFixed(3).padStart(7)}    ${(d >= 0 ? '+' : '') + d.toFixed(3)}`);
    }

    // 2b) Coefficient of variation across resources (how uneven is the per-tile distribution?)
    console.log('\n  Per-tile pip COEFFICIENT OF VARIATION across resources:');
    function cv(stats: MapStats[]): number {
      const perRes: number[] = [];
      for (const r of RESOURCES) {
        const sum = stats.reduce((s, m) => s + m.resPipSum[r], 0);
        const tiles = stats.reduce((s, m) => s + m.resTiles[r], 0);
        if (tiles > 0) perRes.push(sum / tiles);
      }
      const mu = mean(perRes);
      const variance = perRes.reduce((a, b) => a + (b - mu) ** 2, 0) / perRes.length;
      const sd = Math.sqrt(variance);
      return mu > 0 ? sd / mu * 100 : 0;
    }
    console.log(`    off:     ${cv(off).toFixed(3)}%`);
    console.log(`    byCount: ${cv(byCount).toFixed(3)}%   ← current production`);
    console.log(`    byRate:  ${cv(byRate).toFixed(3)}%   ← experimental fix`);

    // -------------------------------------------------------------------
    // 3) TOP-SPOT brick+ore frequency
    // -------------------------------------------------------------------
    console.log('\n========== 3) TOP-SPOT COMPOSITION ==========');
    function comboBreakdown(stats: MapStats[]): { bo: number; bw: number; ow: number; sww: number; osw: number } {
      const total = stats.length;
      let bo = 0, bw = 0, ow = 0, sww = 0, osw = 0;
      for (const s of stats) {
        const c = s.topSpotCombo;
        if (c.includes('brick') && c.includes('ore')) bo++;
        if (c.includes('brick') && c.includes('wood') && !c.includes('ore')) bw++;
        if (c.includes('ore') && c.includes('wheat') && !c.includes('brick')) ow++;
        if (c === 'sheep+wheat+wood') sww++;
        if (c === 'ore+sheep+wheat') osw++;
      }
      return {
        bo: bo / total * 100, bw: bw / total * 100, ow: ow / total * 100,
        sww: sww / total * 100, osw: osw / total * 100,
      };
    }
    const offC = comboBreakdown(off), bcC = comboBreakdown(byCount), brC = comboBreakdown(byRate);
    console.log('  Combo                  off       byCount   byRate    Δ(byRate − byCount)');
    console.log(`  brick+ore              ${offC.bo.toFixed(1).padStart(5)}%   ${bcC.bo.toFixed(1).padStart(5)}%    ${brC.bo.toFixed(1).padStart(5)}%    ${(brC.bo - bcC.bo >= 0 ? '+' : '') + (brC.bo - bcC.bo).toFixed(1)}pp`);
    console.log(`  brick+wood (no ore)    ${offC.bw.toFixed(1).padStart(5)}%   ${bcC.bw.toFixed(1).padStart(5)}%    ${brC.bw.toFixed(1).padStart(5)}%    ${(brC.bw - bcC.bw >= 0 ? '+' : '') + (brC.bw - bcC.bw).toFixed(1)}pp`);
    console.log(`  ore+wheat (no brick)   ${offC.ow.toFixed(1).padStart(5)}%   ${bcC.ow.toFixed(1).padStart(5)}%    ${brC.ow.toFixed(1).padStart(5)}%    ${(brC.ow - bcC.ow >= 0 ? '+' : '') + (brC.ow - bcC.ow).toFixed(1)}pp`);
    console.log(`  sheep+wheat+wood       ${offC.sww.toFixed(2).padStart(5)}%   ${bcC.sww.toFixed(2).padStart(5)}%    ${brC.sww.toFixed(2).padStart(5)}%    ${(brC.sww - bcC.sww >= 0 ? '+' : '') + (brC.sww - bcC.sww).toFixed(2)}pp`);
    console.log(`  ore+sheep+wheat        ${offC.osw.toFixed(1).padStart(5)}%   ${bcC.osw.toFixed(1).padStart(5)}%    ${brC.osw.toFixed(1).padStart(5)}%    ${(brC.osw - bcC.osw >= 0 ? '+' : '') + (brC.osw - bcC.osw).toFixed(1)}pp`);

    // Top-10 most common top-spot combos
    console.log('\n  Top-10 most common top-spot combos:');
    function topCombos(stats: MapStats[], k = 10): Array<[string, number]> {
      const m = new Map<string, number>();
      for (const s of stats) m.set(s.topSpotCombo, (m.get(s.topSpotCombo) ?? 0) + 1);
      return Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, k);
    }
    const offL = topCombos(off), bcL = topCombos(byCount), brL = topCombos(byRate);
    console.log('  off                              byCount                          byRate');
    for (let i = 0; i < 10; i++) {
      const o = offL[i] ?? ['', 0], b = bcL[i] ?? ['', 0], r = brL[i] ?? ['', 0];
      console.log(
        `  ${o[0].padEnd(20)} ${((o[1] / off.length) * 100).toFixed(1).padStart(4)}%   ` +
        `${b[0].padEnd(20)} ${((b[1] / byCount.length) * 100).toFixed(1).padStart(4)}%   ` +
        `${r[0].padEnd(20)} ${((r[1] / byRate.length) * 100).toFixed(1).padStart(4)}%`,
      );
    }

    // -------------------------------------------------------------------
    // 4) Acceptance / attempts
    // -------------------------------------------------------------------
    console.log('\n========== 4) ACCEPTANCE / ATTEMPTS ==========');
    function attemptSummary(stats: MapStats[]) {
      return {
        n: stats.length,
        fellback: stats.filter(s => s.fellBack).length,
        mean: mean(stats.map(s => s.attempts)),
        p50: quantile(stats.map(s => s.attempts), 0.5),
        p95: quantile(stats.map(s => s.attempts), 0.95),
        max: Math.max(...stats.map(s => s.attempts)),
      };
    }
    const aO = attemptSummary(off), aBC = attemptSummary(byCount), aBR = attemptSummary(byRate);
    console.log('  Mode      n     fellback   mean   p50   p95   max');
    console.log(`  off      ${aO.n}   ${aO.fellback.toString().padStart(4)}      ${aO.mean.toFixed(0).padStart(5)}  ${aO.p50.toFixed(0).padStart(4)}  ${aO.p95.toFixed(0).padStart(4)}  ${aO.max.toString().padStart(4)}`);
    console.log(`  byCount  ${aBC.n}   ${aBC.fellback.toString().padStart(4)}      ${aBC.mean.toFixed(0).padStart(5)}  ${aBC.p50.toFixed(0).padStart(4)}  ${aBC.p95.toFixed(0).padStart(4)}  ${aBC.max.toString().padStart(4)}`);
    console.log(`  byRate   ${aBR.n}   ${aBR.fellback.toString().padStart(4)}      ${aBR.mean.toFixed(0).padStart(5)}  ${aBR.p50.toFixed(0).padStart(4)}  ${aBR.p95.toFixed(0).padStart(4)}  ${aBR.max.toString().padStart(4)}`);

    // -------------------------------------------------------------------
    // 5) Fairness
    // -------------------------------------------------------------------
    console.log('\n========== 5) FAIRNESS ==========');
    function fairSum(stats: MapStats[]) {
      return {
        stMean: mean(stats.map(s => s.stdev)),
        stP95: quantile(stats.map(s => s.stdev), 0.95),
        spMean: mean(stats.map(s => s.spread)),
        spP95: quantile(stats.map(s => s.spread), 0.95),
      };
    }
    const fO = fairSum(off), fBC = fairSum(byCount), fBR = fairSum(byRate);
    console.log('  Mode      stdev mean   stdev p95   spread mean   spread p95');
    console.log(`  off       ${fO.stMean.toFixed(3).padStart(10)}    ${fO.stP95.toFixed(3).padStart(7)}      ${fO.spMean.toFixed(3).padStart(7)}      ${fO.spP95.toFixed(3).padStart(7)}`);
    console.log(`  byCount   ${fBC.stMean.toFixed(3).padStart(10)}    ${fBC.stP95.toFixed(3).padStart(7)}      ${fBC.spMean.toFixed(3).padStart(7)}      ${fBC.spP95.toFixed(3).padStart(7)}`);
    console.log(`  byRate    ${fBR.stMean.toFixed(3).padStart(10)}    ${fBR.stP95.toFixed(3).padStart(7)}      ${fBR.spMean.toFixed(3).padStart(7)}      ${fBR.spP95.toFixed(3).padStart(7)}`);

    // Player position bias
    console.log('\n  Player position bias (P_last − P1 advantage):');
    function posBias(stats: MapStats[]): number {
      const sums = new Array(PC).fill(0);
      for (const s of stats) for (let i = 0; i < PC; i++) sums[i] += s.playerTotals[i];
      const m = sums.map(x => x / stats.length);
      return (m[PC - 1] - m[0]) / m[0] * 100;
    }
    console.log(`  off:     ${posBias(off).toFixed(2)}%`);
    console.log(`  byCount: ${posBias(byCount).toFixed(2)}%`);
    console.log(`  byRate:  ${posBias(byRate).toFixed(2)}%`);

    // -------------------------------------------------------------------
    // 6) Archetype mix
    // -------------------------------------------------------------------
    console.log('\n========== 6) ARCHETYPE MIX ==========');
    function archShare(stats: MapStats[]): Record<Archetype, number> {
      const t: Record<Archetype, number> = { expansion:0, cityRush:0, portEconomy:0, devCards:0, balanced:0 };
      for (const s of stats) for (const k of Object.keys(s.archetypeMix) as Archetype[]) t[k] += s.archetypeMix[k];
      const sum = Object.values(t).reduce((a, b) => a + b, 0) || 1;
      const out: Record<Archetype, number> = { expansion:0, cityRush:0, portEconomy:0, devCards:0, balanced:0 };
      for (const k of Object.keys(t) as Archetype[]) out[k] = t[k] / sum * 100;
      return out;
    }
    const aOff = archShare(off), aBC2 = archShare(byCount), aBR2 = archShare(byRate);
    console.log('  Archetype       off       byCount    byRate');
    for (const k of ['expansion','cityRush','portEconomy','devCards','balanced'] as Archetype[]) {
      console.log(`  ${k.padEnd(14)} ${aOff[k].toFixed(2).padStart(6)}%   ${aBC2[k].toFixed(2).padStart(6)}%    ${aBR2[k].toFixed(2).padStart(6)}%`);
    }

    // -------------------------------------------------------------------
    // 7) Production share by resource
    // -------------------------------------------------------------------
    console.log('\n========== 7) PRODUCTION SHARE RATIO BY RESOURCE ==========');
    console.log('Resource       off       byCount    byRate     Δ(byRate − byCount)');
    for (const r of RESOURCES) {
      const oR = mean(off.map(s => s.resShareRatio[r]));
      const bcR = mean(byCount.map(s => s.resShareRatio[r]));
      const brR = mean(byRate.map(s => s.resShareRatio[r]));
      const d = brR - bcR;
      console.log(`  ${r.padEnd(10)} ${oR.toFixed(3).padStart(6)}    ${bcR.toFixed(3).padStart(7)}    ${brR.toFixed(3).padStart(7)}    ${(d >= 0 ? '+' : '') + d.toFixed(3)}`);
    }

    // -------------------------------------------------------------------
    // 8) Quality
    // -------------------------------------------------------------------
    console.log('\n========== 8) QUALITY INDICATORS ==========');
    console.log(`  Avg unhealthy resources:  off=${mean(off.map(s => s.unhealthyResources)).toFixed(3)}   byCount=${mean(byCount.map(s => s.unhealthyResources)).toFixed(3)}   byRate=${mean(byRate.map(s => s.unhealthyResources)).toFixed(3)}`);
    console.log(`  Avg pip spread (quad):    off=${mean(off.map(s => s.pipSpread)).toFixed(3)}   byCount=${mean(byCount.map(s => s.pipSpread)).toFixed(3)}   byRate=${mean(byRate.map(s => s.pipSpread)).toFixed(3)}`);
    console.log(`  Avg top-spot pipValue:    off=${mean(off.map(s => s.topSpotPipValue)).toFixed(2)}   byCount=${mean(byCount.map(s => s.topSpotPipValue)).toFixed(2)}   byRate=${mean(byRate.map(s => s.topSpotPipValue)).toFixed(2)}`);

    // -------------------------------------------------------------------
    // 9) Health verdict on the question
    // -------------------------------------------------------------------
    console.log('\n========== HEALTH VERDICT ==========');
    const cvBC = cv(byCount);
    const cvBR = cv(byRate);
    const reductionPipCV = cvBC > 0 ? ((cvBC - cvBR) / cvBC * 100) : 0;
    const boBC = bcC.bo, boBR = brC.bo;
    const reductionBO = boBC > 0 ? ((boBC - boBR) / boBC * 100) : 0;
    console.log(`  Per-tile-pip CV across resources: byCount=${cvBC.toFixed(2)}%  →  byRate=${cvBR.toFixed(2)}%  (reduction ${reductionPipCV.toFixed(1)}%)`);
    console.log(`  Brick+ore top-spot frequency:    byCount=${boBC.toFixed(1)}%  →  byRate=${boBR.toFixed(1)}%  (reduction ${reductionBO.toFixed(1)}%)`);
  }, 60 * 60 * 1000);
});
