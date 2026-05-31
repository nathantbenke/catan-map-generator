/** Port-Economy Invisibility / Archetype Viability Investigation
 *
 *  Implements the hybrid intent model:
 *    - Structural eligibility (hard binary): is the spot architecturally
 *      a candidate for this archetype?
 *    - Strategic quality   (soft score):   how good is it at that purpose?
 *
 *  For port-economy specifically, uses a tiered model:
 *    Step 1: eligibility — on port + any production in influence radius
 *    Step 2: classification — port strength × local production relevance
 *            × surplus pressure (multi-dimensional)
 *    Step 3: reporting — distribution, not pass/fail
 *
 *  Diagnostic computes per-archetype viable-spot counts across the WHOLE
 *  spot pool (not just top-20) and reports histograms + percentiles so we
 *  can pick k empirically as the smallest value satisfying:
 *    "≥70% of maps have ≥3 archetypes with ≥k viable spots."
 */
import { describe, it } from 'vitest';
import { generateMap } from '../src/generator/generate';
import { scoreMap } from '../src/generator/score';
import { PIP_VALUE } from '../src/game/constants';
import type {
  Archetype,
  PlayerCount,
  ProducingResource,
  Variants,
} from '../src/game/types';

const RUN = process.env.RUN_VIABILITY === '1';

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

const ALL_ARCHETYPES: Archetype[] = ['expansion', 'cityRush', 'portEconomy', 'devCards', 'balanced'];

interface PerSpotEligibility {
  expansion: boolean;
  cityRush: boolean;
  portEconomy: boolean;
  devCards: boolean;
  balanced: boolean;
}

interface PerSpotQuality {
  expansion: number;
  cityRush: number;
  portEconomy: number;
  devCards: number;
  balanced: number;
}

interface MapAnalysis {
  pc: PlayerCount;
  /** Count of structurally-eligible spots per archetype. */
  eligibleCounts: Record<Archetype, number>;
  /** Total spots ranked in current top-20 by total score. */
  inTop20Counts: Record<Archetype, number>;
  /** Best (max) quality score per archetype across eligible spots. */
  bestQuality: Record<Archetype, number>;
  /** Quality of the 3rd-best eligible spot per archetype (null if fewer than 3). */
  third: Record<Archetype, number | null>;
  /** Per-archetype: ranks of top-3 eligible spots (-1 if fewer than 3). */
  ranks: Record<Archetype, number[]>;
  /** Port-economy quality distribution (multi-dim) across all eligible port spots. */
  portQuality: Array<{ spotId: string; portStrength: number; production: number; surplus: number; combined: number; rank: number }>;
}

function analyzeMap(map: Awaited<ReturnType<typeof generateMap>>['map']): MapAnalysis {
  const scored = scoreMap(map.hexes, map.ports, map.playerCount);
  const hexById = new Map(map.hexes.map(h => [h.id, h] as const));

  // Identify which intersections are port intersections.
  const portByIntersection = new Map<string, { type: string; resource?: ProducingResource }>();
  for (const port of map.ports) {
    const idA = scored.graph.byHexCorner.get(`${port.hexId}:${port.side}`);
    const idB = scored.graph.byHexCorner.get(`${port.hexId}:${(port.side + 1) % 6}`);
    const meta = { type: port.type, resource: port.type === 'generic' ? undefined : (port.type as ProducingResource) };
    if (idA) portByIntersection.set(idA, meta);
    if (idB) portByIntersection.set(idB, meta);
  }

  // Build a lookup of port hinterland support by port-intersection id.
  // scored.ports is per-port (one entry per Port object); each port has
  // 1-2 intersectionIds. We want max support across both.
  const supportByIntersection = new Map<string, number>();
  for (const p of scored.ports) {
    for (const id of p.intersectionIds) {
      const cur = supportByIntersection.get(id) ?? 0;
      if (p.supportScore > cur) supportByIntersection.set(id, p.supportScore);
    }
  }

  // Resource production share for surplus-pressure component.
  const shareRatio: Record<ProducingResource, number> = { wood: 1, brick: 1, wheat: 1, sheep: 1, ore: 1 };
  for (const h of scored.health) {
    shareRatio[h.resource] = h.expectedShare > 0 ? h.productionShare / h.expectedShare : 1;
  }

  const sortedSpots = Array.from(scored.spots.values()).sort((a, b) => b.total - a.total);
  const top20Ids = new Set(sortedSpots.slice(0, 20).map(s => s.intersectionId));

  const eligibleCounts: Record<Archetype, number> = { expansion:0, cityRush:0, portEconomy:0, devCards:0, balanced:0 };
  const inTop20Counts: Record<Archetype, number> = { expansion:0, cityRush:0, portEconomy:0, devCards:0, balanced:0 };
  const bestQuality: Record<Archetype, number> = { expansion:0, cityRush:0, portEconomy:0, devCards:0, balanced:0 };

  // Track eligible spots per archetype with their quality and rank.
  const perArchEligible: Record<Archetype, Array<{ spotId: string; quality: number; rank: number }>> = {
    expansion: [], cityRush: [], portEconomy: [], devCards: [], balanced: [],
  };

  const portQuality: MapAnalysis['portQuality'] = [];

  for (let rank = 0; rank < sortedSpots.length; rank++) {
    const spot = sortedSpots[rank];
    const inter = scored.graph.intersections.get(spot.intersectionId);
    if (!inter) continue;

    // Compute per-resource pip access for this spot.
    const pipByResource = new Map<ProducingResource, number>();
    const adjResources = new Set<ProducingResource>();
    for (const hexId of inter.hexIds) {
      const h = hexById.get(hexId);
      if (!h || h.resource === 'desert' || h.number === null) continue;
      const r = h.resource as ProducingResource;
      adjResources.add(r);
      pipByResource.set(r, (pipByResource.get(r) ?? 0) + (PIP_VALUE[h.number] ?? 0));
    }
    const pip = (r: ProducingResource) => pipByResource.get(r) ?? 0;
    const has = (r: ProducingResource) => adjResources.has(r);

    // -------- Structural eligibility (hard binary) --------
    const elig: PerSpotEligibility = {
      expansion:    has('brick') && has('wood'),
      cityRush:     has('ore')   && has('wheat'),
      // DevCards: sheep PLUS at least one of (wheat, ore)
      devCards:     has('sheep') && (has('wheat') || has('ore')),
      portEconomy:  portByIntersection.has(spot.intersectionId) && adjResources.size >= 1,
      balanced:     adjResources.size >= 3,
    };

    // -------- Strategic quality (soft score per archetype) --------
    const qual: PerSpotQuality = {
      expansion:    elig.expansion   ? (pip('brick') + pip('wood')) * 1.5 : 0,
      cityRush:     elig.cityRush    ? (pip('ore')   + pip('wheat')) * 1.5 : 0,
      devCards:     elig.devCards    ? pip('sheep') * 1.5 + pip('wheat') * 0.5 + pip('ore') * 0.5 : 0,
      balanced:     elig.balanced    ? (pip('brick')+pip('wood')+pip('wheat')+pip('sheep')+pip('ore')) * 0.7 : 0,
      portEconomy:  0, // computed below (multi-dim)
    };

    // Port-economy multi-dim quality:
    //   portStrength    = hinterland support of the port at this intersection
    //   production      = pip of matching-resource hexes adjacent (or all
    //                     producing pips if generic port)
    //   surplus         = how over-supplied the matching resource is on the map
    //                     (share ratio > 1 → surplus → port is more useful)
    if (elig.portEconomy) {
      const portMeta = portByIntersection.get(spot.intersectionId)!;
      const portStrength = supportByIntersection.get(spot.intersectionId) ?? 0;
      let production = 0;
      let surplus = 1;
      if (portMeta.resource) {
        // Matching port — production from matching-resource hexes adjacent
        production = pip(portMeta.resource);
        surplus = shareRatio[portMeta.resource];
      } else {
        // Generic port — production = total pip from any adjacent hex
        production = Array.from(adjResources).reduce((s, r) => s + pip(r), 0);
        // Use average surplus across adjacent resources
        const surpluses = Array.from(adjResources).map(r => shareRatio[r]);
        surplus = surpluses.length > 0 ? surpluses.reduce((a, b) => a + b, 0) / surpluses.length : 1;
      }
      // Combined: weighted product. Higher in all three dims means real
      // port-economy strength; if any dim is zero (no production, dead port,
      // etc.) the combined score collapses.
      // Surplus weighting: bias toward > 1 (over-supplied is good for trade).
      const surplusFactor = Math.max(0.5, Math.min(2.0, surplus));
      const combined = portStrength * 0.4 + production * 1.2 + (surplusFactor - 1.0) * 3;
      qual.portEconomy = combined;
      portQuality.push({ spotId: spot.intersectionId, portStrength, production, surplus, combined, rank });
    }

    // Accumulate per-archetype.
    for (const arch of ALL_ARCHETYPES) {
      if (elig[arch]) {
        eligibleCounts[arch]++;
        if (qual[arch] > bestQuality[arch]) bestQuality[arch] = qual[arch];
        perArchEligible[arch].push({ spotId: spot.intersectionId, quality: qual[arch], rank });
        if (top20Ids.has(spot.intersectionId)) inTop20Counts[arch]++;
      }
    }
  }

  // Top-3 per archetype (by quality), with ranks
  const third: Record<Archetype, number | null> = {
    expansion: null, cityRush: null, portEconomy: null, devCards: null, balanced: null,
  };
  const ranks: Record<Archetype, number[]> = {
    expansion: [], cityRush: [], portEconomy: [], devCards: [], balanced: [],
  };
  for (const arch of ALL_ARCHETYPES) {
    const sorted = perArchEligible[arch].slice().sort((a, b) => b.quality - a.quality);
    if (sorted.length >= 3) third[arch] = sorted[2].quality;
    ranks[arch] = sorted.slice(0, 3).map(x => x.rank);
  }

  return {
    pc: map.playerCount,
    eligibleCounts,
    inTop20Counts,
    bestQuality,
    third,
    ranks,
    portQuality: portQuality.sort((a, b) => b.combined - a.combined),
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
function histogram(xs: number[], bins: number[]) {
  const counts = new Array(bins.length + 1).fill(0);
  for (const x of xs) {
    let placed = false;
    for (let i = 0; i < bins.length; i++) {
      if (x < bins[i]) { counts[i]++; placed = true; break; }
    }
    if (!placed) counts[counts.length - 1]++;
  }
  return counts;
}

// --- Main harness ----------------------------------------------------------

describe('archetype viability investigation', () => {
  it.runIf(RUN)('per-archetype viability + port-economy distribution', () => {
    const N = Number(process.env.SAMPLES ?? 600);
    const PCs: PlayerCount[] = [4, 6];

    for (const pc of PCs) {
      console.log(`\n========================================`);
      console.log(`     pc=${pc}   n=${N}`);
      console.log(`========================================`);

      const t0 = Date.now();
      const analyses: MapAnalysis[] = [];
      for (let i = 0; i < N; i++) {
        try {
          const r = generateMap({ playerCount: pc, variants: v() });
          analyses.push(analyzeMap(r.map));
        } catch {}
      }
      console.log(`Generated ${analyses.length} maps in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

      // ----- 1) Per-archetype eligible-spot histograms + percentiles -----
      console.log('========== 1) PER-ARCHETYPE ELIGIBLE-SPOT COUNTS ==========');
      console.log('Archetype       mean    p25    p50    p75    p95');
      for (const arch of ALL_ARCHETYPES) {
        const xs = analyses.map(a => a.eligibleCounts[arch]);
        console.log(`  ${arch.padEnd(14)} ${mean(xs).toFixed(2).padStart(5)}   ${quantile(xs, 0.25).toFixed(1).padStart(4)}   ${quantile(xs, 0.5).toFixed(1).padStart(4)}   ${quantile(xs, 0.75).toFixed(1).padStart(4)}   ${quantile(xs, 0.95).toFixed(1).padStart(4)}`);
      }

      console.log('\nDistribution histograms (count of viable spots per map):');
      console.log('Archetype       0      1-2     3-4     5-7     8-12    13+');
      for (const arch of ALL_ARCHETYPES) {
        const xs = analyses.map(a => a.eligibleCounts[arch]);
        const h = histogram(xs, [1, 3, 5, 8, 13]);
        const total = xs.length;
        const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`.padStart(7);
        console.log(`  ${arch.padEnd(14)} ${pct(h[0])}${pct(h[1])}${pct(h[2])}${pct(h[3])}${pct(h[4])}${pct(h[5])}`);
      }

      // ----- 2) Current vs proposed metric — in-top-20 vs eligible -----
      console.log('\n========== 2) CURRENT (top-20) vs PROPOSED (eligible anywhere) ==========');
      console.log('Archetype       top-20 mean   eligible mean   ratio (eligible/top-20)');
      for (const arch of ALL_ARCHETYPES) {
        const t20 = analyses.map(a => a.inTop20Counts[arch]);
        const elig = analyses.map(a => a.eligibleCounts[arch]);
        const mt20 = mean(t20), me = mean(elig);
        const ratio = mt20 > 0 ? (me / mt20) : Infinity;
        console.log(`  ${arch.padEnd(14)} ${mt20.toFixed(2).padStart(8)}      ${me.toFixed(2).padStart(8)}        ${isFinite(ratio) ? ratio.toFixed(1) + '×' : '∞'}`);
      }

      // ----- 3) Find the optimal k empirically -----
      console.log('\n========== 3) OPTIMAL k SEARCH ==========');
      console.log('Question: smallest k such that ≥70% of maps have ≥3 archetypes with ≥k viable spots');
      console.log('k    | maps with ≥3 archetypes meeting bar   | archetype-coverage rate');
      let chosen_k: number | null = null;
      for (let k = 1; k <= 12; k++) {
        let mapsMeeting = 0;
        let totalArchCoverage = 0;
        for (const a of analyses) {
          const archesMeeting = ALL_ARCHETYPES.filter(arch => a.eligibleCounts[arch] >= k).length;
          if (archesMeeting >= 3) mapsMeeting++;
          totalArchCoverage += archesMeeting;
        }
        const pctMeeting = (mapsMeeting / analyses.length) * 100;
        const avgArchCoverage = totalArchCoverage / analyses.length;
        const marker = pctMeeting >= 70 && chosen_k === null ? '   ← passing' : '';
        if (pctMeeting >= 70 && chosen_k === null) chosen_k = k;
        console.log(`  ${k.toString().padStart(2)}   | ${pctMeeting.toFixed(1).padStart(5)}%                               | ${avgArchCoverage.toFixed(2).padStart(5)} archetypes per map${marker}`);
      }
      console.log(`\n  Smallest k meeting ≥70% threshold: ${chosen_k === null ? 'NONE' : chosen_k}`);

      // ----- 4) Port-economy distribution (the special case) -----
      console.log('\n========== 4) PORT-ECONOMY DISTRIBUTION (the diagnostic gate, distributional) ==========');
      const allPortQualities: number[] = [];
      const portCountsPerMap: number[] = [];
      for (const a of analyses) {
        portCountsPerMap.push(a.portQuality.length);
        for (const p of a.portQuality) allPortQualities.push(p.combined);
      }
      console.log('Eligible port spots per map (count):');
      const portCountSummary = `  n=${portCountsPerMap.length}  mean=${mean(portCountsPerMap).toFixed(2)}  p25=${quantile(portCountsPerMap, 0.25).toFixed(0)}  p50=${quantile(portCountsPerMap, 0.5).toFixed(0)}  p75=${quantile(portCountsPerMap, 0.75).toFixed(0)}  p95=${quantile(portCountsPerMap, 0.95).toFixed(0)}`;
      console.log(portCountSummary);

      console.log('\nPort-economy quality (combined score) — distribution across all eligible spots:');
      console.log(`  n=${allPortQualities.length}  mean=${mean(allPortQualities).toFixed(2)}  p25=${quantile(allPortQualities, 0.25).toFixed(2)}  p50=${quantile(allPortQualities, 0.5).toFixed(2)}  p75=${quantile(allPortQualities, 0.75).toFixed(2)}  p95=${quantile(allPortQualities, 0.95).toFixed(2)}  max=${Math.max(...allPortQualities).toFixed(2)}`);

      console.log('\nPer-map: max port quality + average port quality of top-3:');
      const maxPortQ: number[] = [];
      const top3PortQ: number[] = [];
      for (const a of analyses) {
        const sorted = a.portQuality.slice(0, 3).map(p => p.combined);
        maxPortQ.push(sorted[0] ?? 0);
        if (sorted.length > 0) top3PortQ.push(mean(sorted));
        else top3PortQ.push(0);
      }
      console.log(`  max port quality:        mean=${mean(maxPortQ).toFixed(2)}   p50=${quantile(maxPortQ, 0.5).toFixed(2)}   p95=${quantile(maxPortQ, 0.95).toFixed(2)}`);
      console.log(`  avg top-3 port quality:  mean=${mean(top3PortQ).toFixed(2)}   p50=${quantile(top3PortQ, 0.5).toFixed(2)}   p95=${quantile(top3PortQ, 0.95).toFixed(2)}`);

      // ----- 5) Where do top-3 eligible spots rank under current total ordering? -----
      console.log('\n========== 5) RANK OF TOP-3 ELIGIBLE SPOTS UNDER CURRENT TOTAL ORDERING ==========');
      console.log('Archetype       avg-best   avg-2nd    avg-3rd');
      for (const arch of ALL_ARCHETYPES) {
        const r1: number[] = [], r2: number[] = [], r3: number[] = [];
        for (const a of analyses) {
          const ranks = a.ranks[arch];
          if (ranks[0] !== undefined) r1.push(ranks[0]);
          if (ranks[1] !== undefined) r2.push(ranks[1]);
          if (ranks[2] !== undefined) r3.push(ranks[2]);
        }
        console.log(`  ${arch.padEnd(14)} ${mean(r1).toFixed(1).padStart(7)}    ${mean(r2).toFixed(1).padStart(7)}    ${mean(r3).toFixed(1).padStart(7)}`);
      }
      console.log('(Lower = higher in current ordering. Top-20 cutoff is rank=19.)');
    }
  }, 30 * 60 * 1000);
});
