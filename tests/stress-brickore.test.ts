/** Brick+Ore Dominance Investigation
 *
 *  Goal: determine the share of the 47-58% top-spot brick+ore rate that is
 *  attributable to (a) the bonus stack, (b) the noMultipleRedsOnResource
 *  constraint distributing reds to 3-tile resources, and (c) genuine Catan
 *  economics. Approach: re-score baseline maps under various scoring configs
 *  (cheap — no regeneration), then regenerate under constraint-modified
 *  variants for the constraint experiment.
 */
import { describe, it } from 'vitest';
import { generateMap } from '../src/generator/generate';
import { scoreMap, type ScoredMap } from '../src/generator/score';
import { PIP_VALUE } from '../src/game/constants';
import type {
  Hex,
  PlayerCount,
  SpotScore,
  Variants,
} from '../src/game/types';

const RUN = process.env.RUN_BO === '1';

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

/** Re-compute spot.total with specific scoring components disabled.
 *  Cheap — uses the per-component fields already on SpotScore.
 *  Note: synergyBonus is a sum of road+city+settlement combos, so to
 *  isolate just road or city combo we subtract its hard-coded weight. */
function rescore(s: SpotScore, disable: Set<string>): number {
  let t = s.pipValue;
  if (!disable.has('diversity'))     t += s.diversityBonus;
  if (!disable.has('port'))          t += s.portBonus;
  if (!disable.has('scarcity'))      t += s.scarcityBonus;
  if (!disable.has('expansion'))     t += s.expansionBonus;
  if (!disable.has('roadPotential')) t += s.roadPotentialBonus;
  if (!disable.has('startingHand'))  t += s.startingHandBonus;
  if (!disable.has('pairScarcity'))  t += s.pairScarcityBonus;
  // sameNumberPenalty is always negative — always include
  t += s.sameNumberPenalty;
  // Synergy decomposition
  let synergy = s.synergyBonus;
  if (disable.has('roadCombo')       && s.hasRoadCombo)       synergy -= 1.5;
  if (disable.has('cityCombo')       && s.hasCityCombo)       synergy -= 1.5;
  if (disable.has('settlementCombo') && s.hasSettlementCombo) synergy -= 0.5;
  if (!disable.has('synergy')) t += synergy;
  return t;
}

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

function topSpotUnder(
  scored: ScoredMap,
  hexById: Map<string, Hex>,
  disable: Set<string>,
): { spot: SpotScore; combo: string; score: number } {
  let bestVal = -Infinity;
  let bestSpot: SpotScore | null = null;
  for (const s of scored.spots.values()) {
    const v = rescore(s, disable);
    if (v > bestVal) { bestVal = v; bestSpot = s; }
  }
  return {
    spot: bestSpot!,
    combo: comboKey(bestSpot!, scored, hexById),
    score: bestVal,
  };
}

interface MapCtx { map: ReturnType<typeof generateMap>['map']; scored: ScoredMap; hexById: Map<string, Hex>; }

function gen(pc: PlayerCount, v: Variants): MapCtx | null {
  try {
    const r = generateMap({ playerCount: pc, variants: v });
    const scored = scoreMap(r.map.hexes, r.map.ports, pc);
    const hexById = new Map(r.map.hexes.map(h => [h.id, h] as const));
    return { map: r.map, scored, hexById };
  } catch { return null; }
}

describe('brick+ore dominance investigation', () => {
  it.runIf(RUN)('attribution / counterfactual / diversity / constraint', () => {
    const N = Number(process.env.SAMPLES ?? 400);
    const PC: PlayerCount = 4;

    // -------------------------------------------------------------------
    // Phase 1 — baseline generation, used for re-scoring experiments.
    // -------------------------------------------------------------------
    console.log(`\nPhase 1 — generating ${N} baseline maps for pc=${PC}...`);
    const t0 = Date.now();
    const baseline: MapCtx[] = [];
    for (let i = 0; i < N; i++) {
      const c = gen(PC, defaultVariants());
      if (c) baseline.push(c);
    }
    console.log(`  ${baseline.length} succeeded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // -------------------------------------------------------------------
    // Phase 2 — resource-tile pip statistics (validate "brick/ore tiles
    // actually have more pip" hypothesis from the noMultipleReds rule).
    // -------------------------------------------------------------------
    console.log('\nPhase 2 — average pip per resource tile (across all baseline maps):\n');
    const resPipSum: Record<string, number> = { wood: 0, brick: 0, wheat: 0, sheep: 0, ore: 0 };
    const resTileCnt: Record<string, number> = { wood: 0, brick: 0, wheat: 0, sheep: 0, ore: 0 };
    for (const { map } of baseline) {
      for (const h of map.hexes) {
        if (h.resource === 'desert' || h.number === null) continue;
        resTileCnt[h.resource]++;
        resPipSum[h.resource] += PIP_VALUE[h.number] ?? 0;
      }
    }
    for (const r of Object.keys(resPipSum)) {
      const avg = resTileCnt[r] > 0 ? resPipSum[r] / resTileCnt[r] : 0;
      console.log(`  ${r.padEnd(8)} avg pip/tile = ${avg.toFixed(3)}  (n=${resTileCnt[r]} tiles)`);
    }
    // The fair baseline if reds were distributed proportionally: total pips
    // divided by total producing tiles = expected avg pip.
    const totalPips = Object.values(resPipSum).reduce((a, b) => a + b, 0);
    const totalTiles = Object.values(resTileCnt).reduce((a, b) => a + b, 0);
    console.log(`  ──────── board avg = ${(totalPips / totalTiles).toFixed(3)} pip/tile\n`);

    // -------------------------------------------------------------------
    // Phase 3 — Attribution: re-score under each disabled config.
    // -------------------------------------------------------------------
    const configs: Array<{ name: string; disable: Set<string> }> = [
      { name: 'baseline (full)',   disable: new Set() },
      { name: 'pure pipValue',     disable: new Set(['diversity','port','synergy','scarcity','expansion','roadPotential','startingHand','pairScarcity']) },
      { name: 'no synergy ALL',    disable: new Set(['synergy']) },
      { name: 'no roadCombo',      disable: new Set(['roadCombo']) },
      { name: 'no cityCombo',      disable: new Set(['cityCombo']) },
      { name: 'no roadPotential',  disable: new Set(['roadPotential']) },
      { name: 'no startingHand',   disable: new Set(['startingHand']) },
      { name: 'no expansion',      disable: new Set(['expansion']) },
      { name: 'no scarcity',       disable: new Set(['scarcity']) },
      { name: 'no pairScarcity',   disable: new Set(['pairScarcity']) },
      { name: 'no diversity',      disable: new Set(['diversity']) },
      { name: 'no port',           disable: new Set(['port']) },
    ];

    console.log('Phase 3 — Top-spot ATTRIBUTION:\n');
    console.log('  config              brick+ore%  sww%  Δ vs base  | most-common-combo');
    const baselineBOPct = (() => {
      let n = 0;
      for (const { scored, hexById } of baseline) {
        const c = topSpotUnder(scored, hexById, new Set()).combo;
        if (c.includes('brick') && c.includes('ore')) n++;
      }
      return (n / baseline.length) * 100;
    })();
    const contributionTable: Array<{ name: string; bo: number; sww: number; delta: number }> = [];
    for (const cfg of configs) {
      let bo = 0, sww = 0;
      const counts = new Map<string, number>();
      for (const { scored, hexById } of baseline) {
        const c = topSpotUnder(scored, hexById, cfg.disable).combo;
        if (c.includes('brick') && c.includes('ore')) bo++;
        if (c === 'sheep+wheat+wood') sww++;
        counts.set(c, (counts.get(c) ?? 0) + 1);
      }
      const boPct = (bo / baseline.length) * 100;
      const swwPct = (sww / baseline.length) * 100;
      const delta = boPct - baselineBOPct;
      contributionTable.push({ name: cfg.name, bo: boPct, sww: swwPct, delta });
      const top = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0];
      const deltaStr = (delta >= 0 ? '+' : '') + delta.toFixed(1) + 'pp';
      console.log(
        `  ${cfg.name.padEnd(20)} ${boPct.toFixed(1).padStart(5)}%  ${swwPct.toFixed(1).padStart(4)}%  ${deltaStr.padStart(9)}` +
        `  | ${top[0]} (${((top[1] / baseline.length) * 100).toFixed(1)}%)`,
      );
    }

    // Ranked by contribution magnitude (most reduction when disabled).
    const ranked = contributionTable
      .filter(c => c.name !== 'baseline (full)' && c.name !== 'pure pipValue')
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    console.log('\n  Components RANKED by contribution to brick+ore dominance:');
    for (const r of ranked) {
      console.log(`    ${r.name.padEnd(22)} disable → brick+ore drops by ${Math.abs(r.delta).toFixed(1)}pp ${r.delta < 0 ? '(real contributor)' : '(no effect / inverse)'}`);
    }

    // -------------------------------------------------------------------
    // Phase 4 — Counterfactual: what would #1 be if brick+ore were removed?
    // -------------------------------------------------------------------
    console.log('\n\nPhase 4 — COUNTERFACTUAL: top spot if brick+ore excluded.\n');
    const gaps: number[] = [];
    const replacementCombos = new Map<string, number>();
    let boFirstCount = 0;
    for (const { scored, hexById } of baseline) {
      const sorted = Array.from(scored.spots.values()).sort((a, b) => b.total - a.total);
      const top1 = sorted[0];
      const top1Combo = comboKey(top1, scored, hexById);
      if (!(top1Combo.includes('brick') && top1Combo.includes('ore'))) continue;
      boFirstCount++;
      let replacement: SpotScore | null = null;
      for (const s of sorted) {
        const c = comboKey(s, scored, hexById);
        if (c.includes('brick') && c.includes('ore')) continue;
        replacement = s;
        break;
      }
      if (replacement) {
        gaps.push(top1.total - replacement.total);
        const repCombo = comboKey(replacement, scored, hexById);
        replacementCombos.set(repCombo, (replacementCombos.get(repCombo) ?? 0) + 1);
      }
    }
    console.log(`  ${boFirstCount}/${baseline.length} maps (${(boFirstCount / baseline.length * 100).toFixed(1)}%) had brick+ore #1.`);
    if (gaps.length > 0) {
      gaps.sort((a, b) => a - b);
      const meanGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const medGap = gaps[Math.floor(gaps.length / 2)];
      const narrow = gaps.filter(g => g < 0.5).length;
      const wide = gaps.filter(g => g > 2.0).length;
      console.log(`\n  Gap from brick+ore #1 to next non-BO spot:`);
      console.log(`    mean = ${meanGap.toFixed(3)}, median = ${medGap.toFixed(3)}, min = ${gaps[0].toFixed(3)}, max = ${gaps[gaps.length - 1].toFixed(3)}`);
      console.log(`    "narrowly ahead" (gap < 0.5):    ${narrow}/${gaps.length} (${(narrow / gaps.length * 100).toFixed(1)}%)`);
      console.log(`    "overwhelmingly ahead" (>2.0):   ${wide}/${gaps.length} (${(wide / gaps.length * 100).toFixed(1)}%)`);
    }
    console.log(`\n  Replacement combos (top-10 most common):`);
    const sortedRep = Array.from(replacementCombos.entries()).sort((a, b) => b[1] - a[1]);
    for (const [combo, n] of sortedRep.slice(0, 10)) {
      console.log(`    ${combo.padEnd(30)} ${n.toString().padStart(4)} (${(n / boFirstCount * 100).toFixed(1)}%)`);
    }

    // -------------------------------------------------------------------
    // Phase 5 — Top-N diversity audit.
    // -------------------------------------------------------------------
    console.log('\n\nPhase 5 — TOP-N DIVERSITY AUDIT:\n');
    for (const N_TOP of [5, 10, 20]) {
      let totalEntropy = 0, totalUnique = 0, totalBO = 0, totalSWW = 0;
      for (const { scored, hexById } of baseline) {
        const top = Array.from(scored.spots.values()).sort((a, b) => b.total - a.total).slice(0, N_TOP);
        const combos = top.map(s => comboKey(s, scored, hexById));
        totalUnique += new Set(combos).size;
        const counts = new Map<string, number>();
        for (const c of combos) counts.set(c, (counts.get(c) ?? 0) + 1);
        let entropy = 0;
        for (const c of counts.values()) {
          const p = c / N_TOP;
          if (p > 0) entropy -= p * Math.log2(p);
        }
        totalEntropy += entropy;
        totalBO += combos.filter(c => c.includes('brick') && c.includes('ore')).length;
        totalSWW += combos.filter(c => c === 'sheep+wheat+wood').length;
      }
      console.log(`  Top-${N_TOP}:`);
      console.log(`    avg unique combos / map:       ${(totalUnique / baseline.length).toFixed(2)} / ${N_TOP}`);
      console.log(`    avg combo entropy (bits):      ${(totalEntropy / baseline.length).toFixed(3)} / ${Math.log2(N_TOP).toFixed(3)} max`);
      console.log(`    avg brick+ore spots / map:     ${(totalBO / baseline.length).toFixed(2)}`);
      console.log(`    avg sheep+wheat+wood / map:    ${(totalSWW / baseline.length).toFixed(2)}`);
    }

    // -------------------------------------------------------------------
    // Phase 6 — Constraint analysis: regenerate with noMultipleReds OFF.
    // -------------------------------------------------------------------
    const N_CONSTRAINT = Number(process.env.CONSTRAINT_SAMPLES ?? 200);
    console.log(`\n\nPhase 6 — CONSTRAINT: regenerate with noMultipleRedsOnResource=OFF (n=${N_CONSTRAINT}):\n`);
    const tC = Date.now();
    const noRedSpread: MapCtx[] = [];
    const variantsNoRedSpread: Variants = { ...defaultVariants(), noMultipleRedsOnResource: false };
    for (let i = 0; i < N_CONSTRAINT; i++) {
      const c = gen(PC, variantsNoRedSpread);
      if (c) noRedSpread.push(c);
    }
    console.log(`  ${noRedSpread.length} succeeded in ${((Date.now() - tC) / 1000).toFixed(1)}s`);

    let bo = 0, sww = 0;
    const counts = new Map<string, number>();
    const noredResPip: Record<string, number> = { wood: 0, brick: 0, wheat: 0, sheep: 0, ore: 0 };
    const noredResCnt: Record<string, number> = { wood: 0, brick: 0, wheat: 0, sheep: 0, ore: 0 };
    for (const { scored, hexById, map } of noRedSpread) {
      const top = Array.from(scored.spots.values()).sort((a, b) => b.total - a.total)[0];
      const c = comboKey(top, scored, hexById);
      if (c.includes('brick') && c.includes('ore')) bo++;
      if (c === 'sheep+wheat+wood') sww++;
      counts.set(c, (counts.get(c) ?? 0) + 1);
      for (const h of map.hexes) {
        if (h.resource === 'desert' || h.number === null) continue;
        noredResCnt[h.resource]++;
        noredResPip[h.resource] += PIP_VALUE[h.number] ?? 0;
      }
    }
    console.log('\n  Resource avg pip/tile (constraint OFF):');
    for (const r of Object.keys(noredResPip)) {
      const avg = noredResCnt[r] > 0 ? noredResPip[r] / noredResCnt[r] : 0;
      console.log(`    ${r.padEnd(8)} avg pip/tile = ${avg.toFixed(3)}`);
    }
    console.log(`\n  brick+ore top-spot rate: ${(bo / noRedSpread.length * 100).toFixed(1)}%   (baseline: ${baselineBOPct.toFixed(1)}%)`);
    console.log(`  sheep+wheat+wood rate:   ${(sww / noRedSpread.length * 100).toFixed(2)}%`);
    const sortedC = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log(`\n  Top-spot combos:`);
    for (const [c, n] of sortedC) {
      console.log(`    ${c.padEnd(30)} ${(n / noRedSpread.length * 100).toFixed(1)}%`);
    }

    // -------------------------------------------------------------------
    // Phase 7 — Per-resource pip total for the #1 spot, broken down by
    // which resource pip dominates. Tells us *what kind* of brick+ore spot
    // is winning — pure-pip dense vs synergy-driven.
    // -------------------------------------------------------------------
    console.log('\n\nPhase 7 — Composition of brick+ore #1 spots:\n');
    const compStats = {
      hasRoadCombo: 0,        // shared-number brick+wood at this spot
      hasCityCombo: 0,        // shared-number ore+wheat at this spot
      hasBothCombos: 0,
      hasNeitherCombo: 0,
      avgPipValue: 0,
      avgTotal: 0,
      n: 0,
    };
    for (const { scored, hexById } of baseline) {
      const sorted = Array.from(scored.spots.values()).sort((a, b) => b.total - a.total);
      const top = sorted[0];
      const combo = comboKey(top, scored, hexById);
      if (!(combo.includes('brick') && combo.includes('ore'))) continue;
      compStats.n++;
      compStats.avgPipValue += top.pipValue;
      compStats.avgTotal += top.total;
      const rc = top.hasRoadCombo;
      const cc = top.hasCityCombo;
      if (rc) compStats.hasRoadCombo++;
      if (cc) compStats.hasCityCombo++;
      if (rc && cc) compStats.hasBothCombos++;
      if (!rc && !cc) compStats.hasNeitherCombo++;
    }
    if (compStats.n > 0) {
      console.log(`  n=${compStats.n} brick+ore top spots`);
      console.log(`  avg pipValue:            ${(compStats.avgPipValue / compStats.n).toFixed(2)}`);
      console.log(`  avg total (with bonus):  ${(compStats.avgTotal / compStats.n).toFixed(2)}`);
      console.log(`  has shared-num roadCombo: ${compStats.hasRoadCombo} (${(compStats.hasRoadCombo / compStats.n * 100).toFixed(1)}%)`);
      console.log(`  has shared-num cityCombo: ${compStats.hasCityCombo} (${(compStats.hasCityCombo / compStats.n * 100).toFixed(1)}%)`);
      console.log(`  has BOTH combos:          ${compStats.hasBothCombos} (${(compStats.hasBothCombos / compStats.n * 100).toFixed(1)}%)`);
      console.log(`  has NEITHER combo:        ${compStats.hasNeitherCombo} (${(compStats.hasNeitherCombo / compStats.n * 100).toFixed(1)}%)`);
    }
  }, 30 * 60 * 1000);
});
