/** Refined Archetype Viability — Quality-Thresholded Calibration
 *
 *  First diagnostic showed eligibility alone is too loose for port-economy
 *  (17 eligible spots per map vs ~7 for expansion). That makes port-economy
 *  trivially "viable" on every map — the opposite of the original problem.
 *
 *  This pass computes per-archetype quality scores AND sweeps thresholds to
 *  find calibrated viability bars where:
 *    - the median map has ~3-5 viable spots per archetype (room to flag
 *      genuinely deficient maps without collapsing under typical ones)
 *    - thresholds are absolute (per-archetype quality units), so the bar
 *      means the same thing across all maps
 *
 *  Output:
 *    - Per-archetype quality distribution (across ALL eligible spots)
 *    - Per-map best / top-3-avg quality per archetype
 *    - Sweep of thresholds (1.0 increments) showing viable-count distributions
 *    - Recommended threshold per archetype (where median per-map count ≈ 5)
 *    - With recommended thresholds: smallest k such that ≥70% of maps have
 *      ≥3 archetypes meeting the bar
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

const RUN = process.env.RUN_VIABILITY_CAL === '1';

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

/** Per-spot per-archetype: structural eligibility + quality score. */
interface SpotArchData {
  spotId: string;
  rank: number;             // rank in global total ordering
  eligible: Record<Archetype, boolean>;
  quality: Record<Archetype, number>;
}

interface MapData {
  pc: PlayerCount;
  spots: SpotArchData[];
}

function analyzeMap(map: Awaited<ReturnType<typeof generateMap>>['map']): MapData {
  const scored = scoreMap(map.hexes, map.ports, map.playerCount);
  const hexById = new Map(map.hexes.map(h => [h.id, h] as const));

  const portByInter = new Map<string, { type: string; resource?: ProducingResource }>();
  for (const port of map.ports) {
    const idA = scored.graph.byHexCorner.get(`${port.hexId}:${port.side}`);
    const idB = scored.graph.byHexCorner.get(`${port.hexId}:${(port.side + 1) % 6}`);
    const meta = { type: port.type, resource: port.type === 'generic' ? undefined : (port.type as ProducingResource) };
    if (idA) portByInter.set(idA, meta);
    if (idB) portByInter.set(idB, meta);
  }
  const supportByInter = new Map<string, number>();
  for (const p of scored.ports) {
    for (const id of p.intersectionIds) {
      supportByInter.set(id, Math.max(supportByInter.get(id) ?? 0, p.supportScore));
    }
  }
  const shareRatio: Record<ProducingResource, number> = { wood:1, brick:1, wheat:1, sheep:1, ore:1 };
  for (const h of scored.health) {
    shareRatio[h.resource] = h.expectedShare > 0 ? h.productionShare / h.expectedShare : 1;
  }

  const sorted = Array.from(scored.spots.values()).sort((a, b) => b.total - a.total);
  const result: SpotArchData[] = [];

  for (let rank = 0; rank < sorted.length; rank++) {
    const spot = sorted[rank];
    const inter = scored.graph.intersections.get(spot.intersectionId);
    if (!inter) continue;

    const pipByResource = new Map<ProducingResource, number>();
    const adj = new Set<ProducingResource>();
    for (const hexId of inter.hexIds) {
      const h = hexById.get(hexId);
      if (!h || h.resource === 'desert' || h.number === null) continue;
      const r = h.resource as ProducingResource;
      adj.add(r);
      pipByResource.set(r, (pipByResource.get(r) ?? 0) + (PIP_VALUE[h.number] ?? 0));
    }
    const pip = (r: ProducingResource) => pipByResource.get(r) ?? 0;
    const has = (r: ProducingResource) => adj.has(r);

    const eligible: Record<Archetype, boolean> = {
      expansion:   has('brick') && has('wood'),
      cityRush:    has('ore')   && has('wheat'),
      devCards:    has('sheep') && (has('wheat') || has('ore')),
      portEconomy: portByInter.has(spot.intersectionId) && adj.size >= 1,
      balanced:    adj.size >= 3,
    };

    const quality: Record<Archetype, number> = {
      expansion: eligible.expansion ? (pip('brick') + pip('wood')) * 1.5 : 0,
      cityRush:  eligible.cityRush  ? (pip('ore')   + pip('wheat')) * 1.5 : 0,
      devCards:  eligible.devCards  ? pip('sheep') * 1.5 + pip('wheat') * 0.5 + pip('ore') * 0.5 : 0,
      balanced:  eligible.balanced  ? (pip('brick')+pip('wood')+pip('wheat')+pip('sheep')+pip('ore')) * 0.7 : 0,
      portEconomy: 0,
    };
    if (eligible.portEconomy) {
      const portMeta = portByInter.get(spot.intersectionId)!;
      const portStrength = supportByInter.get(spot.intersectionId) ?? 0;
      let production = 0;
      let surplus = 1;
      if (portMeta.resource) {
        production = pip(portMeta.resource);
        surplus = shareRatio[portMeta.resource];
      } else {
        production = Array.from(adj).reduce((s, r) => s + pip(r), 0);
        const ss = Array.from(adj).map(r => shareRatio[r]);
        surplus = ss.length ? ss.reduce((a, b) => a + b, 0) / ss.length : 1;
      }
      const surplusFactor = Math.max(0.5, Math.min(2.0, surplus));
      quality.portEconomy = portStrength * 0.4 + production * 1.2 + (surplusFactor - 1.0) * 3;
    }

    result.push({ spotId: spot.intersectionId, rank, eligible, quality });
  }

  return { pc: map.playerCount, spots: result };
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

describe('viability calibration', () => {
  it.runIf(RUN)('per-archetype quality thresholds + k search', () => {
    const N = Number(process.env.SAMPLES ?? 600);
    const PCs: PlayerCount[] = [4, 6];

    for (const pc of PCs) {
      console.log(`\n================================================`);
      console.log(`     pc=${pc}   n=${N}`);
      console.log(`================================================`);
      const t0 = Date.now();
      const maps: MapData[] = [];
      for (let i = 0; i < N; i++) {
        try {
          const r = generateMap({ playerCount: pc, variants: v() });
          maps.push(analyzeMap(r.map));
        } catch {}
      }
      console.log(`Generated ${maps.length} maps in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

      // 1) Quality distribution per archetype across ALL eligible spots
      console.log('========== 1) QUALITY DISTRIBUTION (all eligible spots, per archetype) ==========');
      console.log('Archetype       n eligible      p10     p25     p50     p75     p90     p95');
      for (const arch of ALL) {
        const qs: number[] = [];
        for (const m of maps) for (const s of m.spots) if (s.eligible[arch]) qs.push(s.quality[arch]);
        if (qs.length === 0) { console.log(`  ${arch.padEnd(14)} 0`); continue; }
        console.log(`  ${arch.padEnd(14)} ${qs.length.toString().padStart(7)}    ${quantile(qs, 0.10).toFixed(2).padStart(6)}  ${quantile(qs, 0.25).toFixed(2).padStart(6)}  ${quantile(qs, 0.50).toFixed(2).padStart(6)}  ${quantile(qs, 0.75).toFixed(2).padStart(6)}  ${quantile(qs, 0.90).toFixed(2).padStart(6)}  ${quantile(qs, 0.95).toFixed(2).padStart(6)}`);
      }

      // 2) Per-map: best, top-3 avg, top-5 avg quality per archetype
      console.log('\n========== 2) PER-MAP QUALITY: best / top-3 avg / top-5 avg ==========');
      for (const arch of ALL) {
        const bests: number[] = []; const t3: number[] = []; const t5: number[] = [];
        for (const m of maps) {
          const eligible = m.spots.filter(s => s.eligible[arch]).map(s => s.quality[arch]).sort((a, b) => b - a);
          if (eligible.length === 0) { bests.push(0); t3.push(0); t5.push(0); continue; }
          bests.push(eligible[0]);
          t3.push(mean(eligible.slice(0, 3)));
          t5.push(mean(eligible.slice(0, 5)));
        }
        console.log(`  ${arch.padEnd(14)} best p50=${quantile(bests, 0.5).toFixed(2)}  p25=${quantile(bests, 0.25).toFixed(2)}   top3 p50=${quantile(t3, 0.5).toFixed(2)}  p25=${quantile(t3, 0.25).toFixed(2)}   top5 p50=${quantile(t5, 0.5).toFixed(2)}  p25=${quantile(t5, 0.25).toFixed(2)}`);
      }

      // 3) Threshold sweep — for each archetype, find threshold where median
      //    per-map count = 5 (calibration target). Reports candidate thresholds
      //    and the resulting per-map count distribution.
      console.log('\n========== 3) THRESHOLD SWEEP (find threshold for median count ≈ 5) ==========');
      const recommendedThresholds: Record<Archetype, number> = { expansion:0, cityRush:0, portEconomy:0, devCards:0, balanced:0 };
      for (const arch of ALL) {
        // Search threshold ∈ [0, max quality observed] for median per-map count ≈ 5
        const allQ: number[] = [];
        for (const m of maps) for (const s of m.spots) if (s.eligible[arch]) allQ.push(s.quality[arch]);
        if (allQ.length === 0) continue;
        const maxQ = Math.max(...allQ);
        let bestThreshold = 0;
        let bestDistFrom5 = Infinity;
        const candidates: Array<{ t: number; medianCount: number; p25Count: number; p75Count: number }> = [];
        for (let t = 0; t <= maxQ; t += 0.5) {
          const perMapCount = maps.map(m => m.spots.filter(s => s.eligible[arch] && s.quality[arch] >= t).length);
          const medianCount = quantile(perMapCount, 0.5);
          const p25Count = quantile(perMapCount, 0.25);
          const p75Count = quantile(perMapCount, 0.75);
          candidates.push({ t, medianCount, p25Count, p75Count });
          const dist = Math.abs(medianCount - 5);
          if (dist < bestDistFrom5) { bestDistFrom5 = dist; bestThreshold = t; }
        }
        recommendedThresholds[arch] = bestThreshold;
        // Print sweep around the recommended threshold
        console.log(`  ${arch.padEnd(14)} recommended t=${bestThreshold.toFixed(1)} (median count ≈ 5):`);
        for (const c of candidates) {
          if (Math.abs(c.t - bestThreshold) <= 2.0) {
            const marker = c.t === bestThreshold ? '  ←' : '';
            console.log(`     t=${c.t.toFixed(1).padStart(5)}    median count=${c.medianCount.toFixed(1).padStart(4)}    p25-p75=${c.p25Count.toFixed(0)}-${c.p75Count.toFixed(0)}${marker}`);
          }
        }
      }

      // 4) With recommended thresholds — k search
      console.log('\n========== 4) k SEARCH WITH CALIBRATED THRESHOLDS ==========');
      console.log('Calibrated thresholds:');
      for (const arch of ALL) console.log(`  ${arch.padEnd(14)} ≥ ${recommendedThresholds[arch].toFixed(1)}`);

      console.log('\nViable count = eligible AND quality ≥ threshold');
      console.log('Per-map distribution of "archetypes meeting bar at k":');
      console.log('k    | ≥3 archetypes meeting bar   | avg archetypes covered per map');
      let chosen_k: number | null = null;
      for (let k = 1; k <= 10; k++) {
        let mapsMeeting = 0;
        let archCovered = 0;
        for (const m of maps) {
          let n = 0;
          for (const arch of ALL) {
            const count = m.spots.filter(s => s.eligible[arch] && s.quality[arch] >= recommendedThresholds[arch]).length;
            if (count >= k) n++;
          }
          if (n >= 3) mapsMeeting++;
          archCovered += n;
        }
        const pct = (mapsMeeting / maps.length) * 100;
        const avgArch = archCovered / maps.length;
        const marker = pct >= 70 && chosen_k === null ? '   ← chosen' : '';
        if (pct >= 70 && chosen_k === null) chosen_k = k;
        console.log(`  ${k.toString().padStart(2)}   | ${pct.toFixed(1).padStart(5)}%                       | ${avgArch.toFixed(2)}${marker}`);
      }
      console.log(`\nSmallest k meeting ≥70%: ${chosen_k}`);

      // 5) For the chosen k: which archetypes most-often fall below?
      if (chosen_k !== null) {
        console.log(`\n========== 5) WITH k=${chosen_k}: WHICH ARCHETYPES MISS THE BAR? ==========`);
        const archMissCount: Record<Archetype, number> = { expansion:0, cityRush:0, portEconomy:0, devCards:0, balanced:0 };
        for (const m of maps) {
          for (const arch of ALL) {
            const count = m.spots.filter(s => s.eligible[arch] && s.quality[arch] >= recommendedThresholds[arch]).length;
            if (count < chosen_k) archMissCount[arch]++;
          }
        }
        for (const arch of ALL) {
          const pct = (archMissCount[arch] / maps.length) * 100;
          console.log(`  ${arch.padEnd(14)} ${archMissCount[arch].toString().padStart(4)} / ${maps.length}  (${pct.toFixed(1)}%) maps fail this archetype`);
        }
      }

      // 6) Comparison: current top-20 metric vs proposed calibrated metric
      console.log('\n========== 6) COMPARISON: CURRENT TOP-20 vs PROPOSED CALIBRATED ==========');
      console.log('Archetype       top-20 mean    calibrated mean    diff');
      for (const arch of ALL) {
        const top20Count: number[] = [];
        const calibCount: number[] = [];
        for (const m of maps) {
          top20Count.push(m.spots.filter(s => s.rank < 20 && s.eligible[arch]).length);
          calibCount.push(m.spots.filter(s => s.eligible[arch] && s.quality[arch] >= recommendedThresholds[arch]).length);
        }
        const m1 = mean(top20Count), m2 = mean(calibCount);
        console.log(`  ${arch.padEnd(14)} ${m1.toFixed(2).padStart(8)}      ${m2.toFixed(2).padStart(8)}        ${(m2 - m1 >= 0 ? '+' : '') + (m2 - m1).toFixed(2)}`);
      }
    }
  }, 30 * 60 * 1000);
});
