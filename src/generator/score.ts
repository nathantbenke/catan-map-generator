import { HIGH_YIELD_NUMBERS, LOW_YIELD_NUMBERS, PIP_VALUE, PRODUCING_RESOURCES } from '../game/constants';
import { axialToPixel, buildIntersectionGraph, IntersectionGraph } from '../game/coords';
import { buildHexIndex, hexNeighbors } from '../game/layout';
import type {
  Archetype,
  FairnessReport,
  Hex,
  Intersection,
  PipSpatial,
  PlayerCount,
  Port,
  PortSupport,
  ProducingResource,
  ResourceHealth,
  ResourcePair,
  SpotScore,
} from '../game/types';

export interface ScoredMap {
  graph: IntersectionGraph;
  spots: Map<string, SpotScore>;
  health: ResourceHealth[];
  pairs: ResourcePair[];
  pipSpatial: PipSpatial;
  /** Archetype counts among the top-20 highest-value spots. The metric
   *  guards against monocultural maps where every top corner pushes the
   *  same strategy — a "balanced" board that's actually 18/20 city rush
   *  forces every player into the same plan and kills strategic variety. */
  archetypeMix: Record<Archetype, number>;
  ports: PortSupport[];
  /** Max/min support across SPECIFIC-resource ports (excludes generic).
   *  Captures hidden bias: 9 sheep tiles around the sheep port vs 6
   *  middling ore tiles around the ore port → high ratio. */
  specificPortSupportRatio: number;
  /** Per-player minimum graph distance from any of their snake-draft picks
   *  to any port intersection. A player with min-distance 5 is port-starved
   *  relative to a player with min-distance 1, even if their settlement
   *  pip totals match. */
  playerPortDistance: number[];
  /** max − min across playerPortDistance. */
  playerPortDistanceSpread: number;
  fairness: FairnessReport;
}

function bfsFrom(
  graph: IntersectionGraph,
  starts: Iterable<string>,
  maxDepth = Infinity,
): Map<string, number> {
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const id of starts) {
    if (!dist.has(id)) {
      dist.set(id, 0);
      queue.push(id);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const curDist = dist.get(cur)!;
    if (curDist >= maxDepth) continue;
    const inter = graph.intersections.get(cur);
    if (!inter) continue;
    for (const nb of inter.neighbors) {
      if (!dist.has(nb)) {
        dist.set(nb, curDist + 1);
        queue.push(nb);
      }
    }
  }
  return dist;
}

function portCornerIntersections(
  port: Port,
  graph: IntersectionGraph,
): string[] {
  const idA = graph.byHexCorner.get(`${port.hexId}:${port.side}`);
  const idB = graph.byHexCorner.get(`${port.hexId}:${(port.side + 1) % 6}`);
  return [idA, idB].filter((x): x is string => !!x);
}

/** For each port, compute a "hinterland strength" score: weighted sum of
 *  nearby matching-resource hex pips (all producing hexes for generic ports),
 *  with weights 1.0 / 0.6 / 0.3 by graph distance (0 / 1 / 2 roads). Captures
 *  the hidden bias the user flagged: identical port counts can still favor
 *  one resource if its port lands next to better numbers. */
function computePortSupport(
  ports: Port[],
  graph: IntersectionGraph,
  hexById: Map<string, Hex>,
): PortSupport[] {
  const out: PortSupport[] = [];
  for (const port of ports) {
    const portInts = portCornerIntersections(port, graph);
    if (portInts.length === 0) {
      out.push({ type: port.type, intersectionIds: [], supportScore: 0 });
      continue;
    }
    const dist = bfsFrom(graph, portInts, 2);
    const matchResource = port.type === 'generic' ? null : port.type;
    const counted = new Set<string>();
    let support = 0;
    for (const [interId, d] of dist) {
      const inter = graph.intersections.get(interId);
      if (!inter) continue;
      for (const hexId of inter.hexIds) {
        if (counted.has(hexId)) continue;
        const hex = hexById.get(hexId);
        if (!hex || hex.resource === 'desert') continue;
        if (matchResource && hex.resource !== matchResource) continue;
        const pip = hex.number !== null ? (PIP_VALUE[hex.number] ?? 0) : 0;
        const weight = d === 0 ? 1.0 : d === 1 ? 0.6 : 0.3;
        support += pip * weight;
        counted.add(hexId);
      }
    }
    out.push({ type: port.type, intersectionIds: portInts, supportScore: support });
  }
  return out;
}

/** Per-player min distance from any of their snake-draft picks to any port. */
function computePlayerPortDistances(
  ports: Port[],
  graph: IntersectionGraph,
  picks: FairnessReport['picks'],
  playerCount: number,
): { byPlayer: number[]; spread: number } {
  const portIntersections = new Set<string>();
  for (const port of ports) {
    for (const id of portCornerIntersections(port, graph)) portIntersections.add(id);
  }
  const dist = bfsFrom(graph, portIntersections);
  const byPlayer = new Array(playerCount).fill(Infinity);
  for (const pick of picks) {
    const d = dist.get(pick.intersectionId) ?? Infinity;
    if (d < byPlayer[pick.playerIndex]) byPlayer[pick.playerIndex] = d;
  }
  const finite = byPlayer.filter(d => Number.isFinite(d));
  const spread = finite.length > 0 ? Math.max(...finite) - Math.min(...finite) : 0;
  return { byPlayer, spread };
}

function pairKey(a: ProducingResource, b: ProducingResource): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

/** Split the board into 4 quadrants around the centroid of hex pixel
 *  positions, then compare each quadrant's pip share to its tile share.
 *  Catches the "super continent" case the user described: 6/8/5/9 all
 *  legally placed but clustered into a single quadrant of the board,
 *  leaving the other half of the map productively dead. */
function computePipSpatial(hexes: Hex[]): PipSpatial {
  if (hexes.length === 0) {
    return {
      quadrantPips: [0, 0, 0, 0],
      quadrantTiles: [0, 0, 0, 0],
      quadrantRatios: [1, 1, 1, 1],
      spread: 0,
    };
  }
  // Quadrant boundary at the centroid of hex pixel centers (works for both
  // base game and the staggered expansion layout).
  let bcx = 0;
  let bcy = 0;
  for (const h of hexes) {
    const { x, y } = axialToPixel({ q: h.q, r: h.r });
    bcx += x;
    bcy += y;
  }
  bcx /= hexes.length;
  bcy /= hexes.length;

  const quadPips: [number, number, number, number] = [0, 0, 0, 0];
  const quadTiles: [number, number, number, number] = [0, 0, 0, 0];
  for (const h of hexes) {
    if (h.resource === 'desert') continue;
    const { x, y } = axialToPixel({ q: h.q, r: h.r });
    // SVG quadrants: 0 NW, 1 NE, 2 SW, 3 SE
    const left = x < bcx;
    const top = y < bcy;
    const idx = (top ? 0 : 2) + (left ? 0 : 1);
    quadTiles[idx]++;
    if (h.number !== null) {
      quadPips[idx] += PIP_VALUE[h.number] ?? 0;
    }
  }
  const totalPips = quadPips.reduce((a, b) => a + b, 0);
  const totalTiles = quadTiles.reduce((a, b) => a + b, 0);
  const ratios: [number, number, number, number] = [1, 1, 1, 1];
  for (let i = 0; i < 4; i++) {
    const tileShare = totalTiles > 0 ? quadTiles[i] / totalTiles : 0;
    const pipShare = totalPips > 0 ? quadPips[i] / totalPips : 0;
    ratios[i] = tileShare > 0 ? pipShare / tileShare : 0;
  }
  const spread = Math.max(...ratios) - Math.min(...ratios);
  return { quadrantPips: quadPips, quadrantTiles: quadTiles, quadrantRatios: ratios, spread };
}

/** Macro pair distribution: count observed adjacencies of each producing-
 *  resource pair on the map, compare to the count you'd expect under a
 *  proportional-to-tile-product baseline. A board with very few brick-wood
 *  adjacencies plays differently from one with many — road-rush becomes
 *  harder regardless of brick or wood being healthy individually. */
function computeResourcePairs(
  hexes: Hex[],
  tilesPerResource: Map<ProducingResource, number>,
): ResourcePair[] {
  const byKey = buildHexIndex(hexes);
  const observed = new Map<string, number>();
  let totalEdges = 0;
  for (const hex of hexes) {
    if (hex.resource === 'desert') continue;
    for (const n of hexNeighbors(hex, byKey)) {
      if (n.resource === 'desert') continue;
      if (hex.id >= n.id) continue; // count each edge once
      const k = pairKey(hex.resource as ProducingResource, n.resource as ProducingResource);
      observed.set(k, (observed.get(k) ?? 0) + 1);
      totalEdges++;
    }
  }

  const resources = (Array.from(tilesPerResource.keys()) as ProducingResource[]).sort();
  let weightSum = 0;
  const weights = new Map<string, number>();
  for (let i = 0; i < resources.length; i++) {
    for (let j = i + 1; j < resources.length; j++) {
      const w = (tilesPerResource.get(resources[i]) ?? 0) * (tilesPerResource.get(resources[j]) ?? 0);
      weights.set(pairKey(resources[i], resources[j]), w);
      weightSum += w;
    }
  }

  const out: ResourcePair[] = [];
  for (let i = 0; i < resources.length; i++) {
    for (let j = i + 1; j < resources.length; j++) {
      const a = resources[i];
      const b = resources[j];
      const k = pairKey(a, b);
      const obs = observed.get(k) ?? 0;
      const w = weights.get(k) ?? 0;
      const exp = weightSum > 0 ? (totalEdges * w) / weightSum : 0;
      const delta = obs - exp;
      let status: ResourcePair['status'];
      if (exp < 1) status = 'normal'; // too little signal to call
      else if (obs <= exp * 0.45) status = 'rare';
      else if (obs >= exp * 1.6) status = 'abundant';
      else status = 'normal';
      out.push({ a, b, observed: obs, expected: exp, delta, status });
    }
  }
  return out;
}

function pip(hex: Hex): number {
  return hex.number !== null ? PIP_VALUE[hex.number] : 0;
}

/** Tunable weights for the scarcityBonus components. Pip-yield scarcity is
 *  the principled signal (rare production = real strategic scarcity); the
 *  tile-count term was a category error since the tile bag is fixed by the
 *  rulebook, not by scarcity, and it amplified a small structural advantage
 *  for 3-tile resources (brick, ore) into ~50% top-spot dominance. Removing
 *  it via the full-regeneration validation reduced brick+ore dominance to
 *  ~37% with zero regression on acceptance rate, fairness, or attempts. */
export interface ScarcityConfig {
  /** Multiplier on (maxTiles − tiles). Default 0 (off — was 0.5 historically). */
  tileWeight: number;
  /** Multiplier on (maxPips − pips). Default 0.10. */
  pipWeight: number;
}
export const DEFAULT_SCARCITY_CONFIG: ScarcityConfig = { tileWeight: 0, pipWeight: 0.10 };

export function scoreMap(
  hexes: Hex[],
  ports: Port[],
  playerCount: PlayerCount,
  scarcityConfig: ScarcityConfig = DEFAULT_SCARCITY_CONFIG,
): ScoredMap {
  const graph = buildIntersectionGraph(hexes);
  const hexById = new Map(hexes.map(h => [h.id, h] as const));

  const portByIntersection = new Map<string, { type: string; resource?: ProducingResource }>();
  for (const port of ports) {
    const idA = graph.byHexCorner.get(`${port.hexId}:${port.side}`);
    const idB = graph.byHexCorner.get(`${port.hexId}:${(port.side + 1) % 6}`);
    const meta = { type: port.type, resource: port.type === 'generic' ? undefined : (port.type as ProducingResource) };
    if (idA) portByIntersection.set(idA, meta);
    if (idB) portByIntersection.set(idB, meta);
  }

  // Per-map resource tile counts AND pip yields. Both drive the scarcity
  // bonus below: a resource is "scarce" if it has FEW tiles (hard to reach)
  // OR LOW total pips (rolls rarely even where it exists). Spots adjacent to
  // scarce resources get a premium because trading for them mid-game is
  // expensive. Distinguishing the two captures cases the user flagged:
  // 4 wheat tiles all on 2/3/11/12 are scarcer in production than 3 ore
  // tiles on 5/6/8 — tile count alone would say the opposite.
  const tilesPerResource = new Map<ProducingResource, number>();
  const pipsPerResource = new Map<ProducingResource, number>();
  for (const h of hexes) {
    if (h.resource === 'desert') continue;
    tilesPerResource.set(h.resource, (tilesPerResource.get(h.resource) ?? 0) + 1);
    if (h.number !== null) {
      pipsPerResource.set(
        h.resource,
        (pipsPerResource.get(h.resource) ?? 0) + (PIP_VALUE[h.number] ?? 0),
      );
    }
  }
  const maxTiles = Math.max(0, ...tilesPerResource.values());
  const maxPips = Math.max(0, ...pipsPerResource.values());

  // Macro pair distribution — observed-vs-expected adjacency frequency for
  // each producing-resource pair. A board light on brick-wood pairs plays
  // very differently from one heavy on them, regardless of how each resource
  // individually scores; spot scoring uses this to reward corners that
  // contain pairs that are scarce on the board overall.
  const pairs = computeResourcePairs(hexes, tilesPerResource);
  const pairsByKey = new Map(pairs.map(p => [pairKey(p.a, p.b), p] as const));

  // Pass 1: base spot scores (without expansion bonus).
  const baseSpots = new Map<string, SpotScore>();
  for (const inter of graph.intersections.values()) {
    baseSpots.set(
      inter.id,
      scoreSpot(
        inter, hexById, portByIntersection.get(inter.id),
        tilesPerResource, maxTiles, pipsPerResource, maxPips, pairsByKey,
        scarcityConfig,
      ),
    );
  }

  // Pass 2: graph-based expansion-potential bonus.
  //
  // Previously this was a simple distance-2-viability count — accurate for
  // "can I build a road and place a settlement nearby" but blind to longer
  // horizons. Two openings can have the same number of immediate viable
  // neighbors and yet vastly different reach to the board's truly elite
  // spots (the 8-ore corner, the contested wheat-ore intersection, the
  // brick-wood road-combo). Late-game Catan is largely about which player
  // can contest those targets first.
  //
  // We BFS once from each of the TOP_K highest-pip-value intersections on
  // the board, then for every spot compute a weighted reach score:
  //   reach = Σ target.pipValue × max(0, 1 − distance(spot, target) / DECAY)
  // i.e. "what's the value-weighted long-term territory I can roads-rush
  // toward." Reach is then z-scored across all spots and clamped so it
  // contributes a ±0.8 nudge — meaningful but not dominant.
  const TOP_K = 8;
  const REACH_DECAY = 8; // ~ full board diameter in roads; past this, no weight
  const topK = Array.from(baseSpots.values())
    .filter(s => s.pipValue >= 4) // ignore "viable expansion target" floor
    .sort((a, b) => b.pipValue - a.pipValue)
    .slice(0, TOP_K);
  const distFromTopK = new Map<string, Map<string, number>>();
  for (const sp of topK) {
    distFromTopK.set(sp.intersectionId, bfsFrom(graph, [sp.intersectionId]));
  }
  const reachScore = new Map<string, number>();
  for (const inter of graph.intersections.values()) {
    let reach = 0;
    for (const target of topK) {
      if (target.intersectionId === inter.id) continue;
      const d = distFromTopK.get(target.intersectionId)?.get(inter.id);
      if (d === undefined || !Number.isFinite(d) || d >= REACH_DECAY) continue;
      const weight = 1 - d / REACH_DECAY;
      reach += target.pipValue * weight;
    }
    reachScore.set(inter.id, reach);
  }
  const reachValues = Array.from(reachScore.values());
  const reachMean = reachValues.length > 0
    ? reachValues.reduce((a, b) => a + b, 0) / reachValues.length
    : 0;
  const reachVar = reachValues.length > 0
    ? reachValues.reduce((s, v) => s + (v - reachMean) ** 2, 0) / reachValues.length
    : 0;
  const reachStdev = Math.sqrt(reachVar);

  const spots = new Map<string, SpotScore>();
  for (const inter of graph.intersections.values()) {
    const base = baseSpots.get(inter.id)!;
    const reach = reachScore.get(inter.id) ?? 0;
    const z = reachStdev > 0 ? (reach - reachMean) / reachStdev : 0;
    const expansionBonus = Math.max(-0.8, Math.min(0.8, z * 0.4));
    spots.set(inter.id, {
      ...base,
      expansionBonus,
      total: base.total + expansionBonus,
    });
  }

  const health = computeHealth(hexes);
  const fairness = simulateSnakeDraft(graph, spots, playerCount, hexById);

  const portSupports = computePortSupport(ports, graph, hexById);
  const specificScores = portSupports
    .filter(p => p.type !== 'generic')
    .map(p => p.supportScore);
  const maxS = specificScores.length > 0 ? Math.max(...specificScores) : 0;
  const minS = specificScores.length > 0 ? Math.min(...specificScores) : 0;
  const specificPortSupportRatio = minS > 0 ? maxS / minS : (maxS > 0 ? Infinity : 1);

  const portDist = computePlayerPortDistances(ports, graph, fairness.picks, playerCount);
  const pipSpatial = computePipSpatial(hexes);
  const archetypeMix = topNArchetypeMix(spots, 20);

  return {
    graph, spots, health, pairs, pipSpatial, archetypeMix,
    ports: portSupports,
    specificPortSupportRatio,
    playerPortDistance: portDist.byPlayer,
    playerPortDistanceSpread: portDist.spread,
    fairness,
  };
}

function topNArchetypeMix(
  spots: Map<string, SpotScore>,
  n: number,
): Record<Archetype, number> {
  const mix: Record<Archetype, number> = {
    expansion: 0, cityRush: 0, portEconomy: 0, devCards: 0, balanced: 0,
  };
  const top = Array.from(spots.values())
    .sort((a, b) => b.total - a.total)
    .slice(0, n);
  for (const s of top) mix[s.archetype]++;
  return mix;
}

/** True if the board's top-20 spots span at least 3 distinct strategic
 *  archetypes with ≥3 spots each. Catches the failure mode the user
 *  flagged: a "balanced" board where every top corner happens to be
 *  ore+wheat, forcing every player into city-rush. The threshold is
 *  intentionally lenient — 3-of-5 archetypes with at least 3 spots —
 *  so unusual but still playable maps aren't rejected for being a
 *  little narrow. */
export function hasStrategicDiversity(spots: Map<string, SpotScore>): boolean {
  const mix = topNArchetypeMix(spots, 20);
  const archetypesWithCoverage = Object.values(mix).filter(c => c >= 3).length;
  return archetypesWithCoverage >= 3;
}

/** Classify a spot's strategic archetype. Each archetype is scored by a
 *  combination of adjacent resources (pip-weighted) and port presence; the
 *  highest-scoring archetype wins. The "balanced" baseline ensures a spot
 *  with no dominant signature still classifies cleanly rather than picking
 *  whichever archetype happened to nudge above zero. */
function classifyArchetype(
  pipByResource: Map<ProducingResource, number>,
  port: { type: string; resource?: ProducingResource } | undefined,
): Archetype {
  const pip = (r: ProducingResource) => pipByResource.get(r) ?? 0;
  const has = (r: ProducingResource) => (pipByResource.get(r) ?? 0) > 0;
  const distinct = pipByResource.size;
  const total = pip('brick') + pip('wood') + pip('wheat') + pip('sheep') + pip('ore');

  // Expansion (road rush + settlement spread): brick + wood specifically.
  // Combined-resource bonus reflects that a road combo on a single corner
  // is much more useful than equal pips spread.
  const expansion = has('brick') && has('wood')
    ? (pip('brick') + pip('wood')) * 1.5
    : pip('brick') + pip('wood');

  // City rush: ore + wheat specifically. Same combined-resource amplifier.
  const cityRush = has('ore') && has('wheat')
    ? (pip('ore') + pip('wheat')) * 1.5
    : pip('ore') + pip('wheat');

  // Dev cards: sheep + wheat + ore (the dev-card recipe). Sheep weighted
  // heavier — it's the bottleneck since sheep are also needed for trades.
  const devCards = pip('sheep') * 1.5 + pip('wheat') * 0.5 + pip('ore') * 0.5;

  // Port economy: spot sits on a port. Matching-resource port + matching
  // adjacent hex is the strong case (you'll have a permanent surplus to
  // trade); generic ports are weaker; mismatched specific ports weakest.
  let portEconomy = 0;
  if (port) {
    if (port.resource && has(port.resource as ProducingResource)) {
      portEconomy = 12 + pip(port.resource as ProducingResource);
    } else if (port.type === 'generic') {
      portEconomy = 5;
    } else {
      portEconomy = 2;
    }
  }

  // Balanced: 3+ distinct resources at the spot AND no single resource
  // pair runs away with the score. Normalized so wide-but-mid spots can
  // beat narrow-but-deep spots cleanly.
  const balanced = distinct >= 3 ? total * 0.7 : 0;

  const scores: Array<[Archetype, number]> = [
    ['expansion', expansion],
    ['cityRush', cityRush],
    ['portEconomy', portEconomy],
    ['devCards', devCards],
    ['balanced', balanced],
  ];
  let best: Archetype = 'balanced';
  let bestScore = -Infinity;
  for (const [arch, sc] of scores) {
    if (sc > bestScore) { bestScore = sc; best = arch; }
  }
  return best;
}

function scoreSpot(
  inter: Intersection,
  hexById: Map<string, Hex>,
  port: { type: string; resource?: ProducingResource } | undefined,
  tilesPerResource: Map<ProducingResource, number>,
  maxTiles: number,
  pipsPerResource: Map<ProducingResource, number>,
  maxPips: number,
  pairsByKey: Map<string, ResourcePair>,
  scarcityConfig: ScarcityConfig,
): SpotScore {
  const adjHexes = inter.hexIds.map(id => hexById.get(id)!).filter(Boolean);
  const pipValue = adjHexes.reduce((s, h) => s + pip(h), 0);

  const uniqueResources = new Set(adjHexes.map(h => h.resource).filter(r => r !== 'desert'));
  const diversityBonus = Math.max(0, uniqueResources.size - 1) * 0.5;

  let portBonus = 0;
  if (port) {
    if (port.resource && adjHexes.some(h => h.resource === port.resource)) portBonus = 1.0;
    else portBonus = 0.3;
  }

  const numberToResources = new Map<number, Set<ProducingResource>>();
  const numberCounts = new Map<number, number>();
  for (const h of adjHexes) {
    if (h.number === null || h.resource === 'desert') continue;
    numberCounts.set(h.number, (numberCounts.get(h.number) ?? 0) + 1);
    if (!numberToResources.has(h.number)) numberToResources.set(h.number, new Set());
    numberToResources.get(h.number)!.add(h.resource as ProducingResource);
  }
  let hasRoadCombo = false;
  let hasCityCombo = false;
  for (const set of numberToResources.values()) {
    if (set.has('brick') && set.has('wood')) hasRoadCombo = true;
    if (set.has('ore') && set.has('wheat')) hasCityCombo = true;
  }
  const allSettlementResources =
    uniqueResources.has('brick') &&
    uniqueResources.has('wood') &&
    uniqueResources.has('wheat') &&
    uniqueResources.has('sheep');
  const hasSettlementCombo = allSettlementResources;

  let synergyBonus = 0;
  if (hasRoadCombo) synergyBonus += 1.5;
  if (hasCityCombo) synergyBonus += 1.5;
  if (hasSettlementCombo) synergyBonus += 0.5;

  // Road potential: just having brick AND wood adjacent (any numbers) enables
  // an early road, the snake-draft expansion lever. Smaller than the shared-
  // number road combo above, but applies whenever both materials touch the
  // intersection so spots with split numbers still get partial credit.
  const roadPotentialBonus =
    uniqueResources.has('brick') && uniqueResources.has('wood') ? 0.8 : 0;

  // Starting-hand bonus: per Catan rules the SECOND settlement generates one
  // resource card per adjacent producing hex on placement. Modeled here as a
  // flat per-hex premium since both the simulator's picks contribute to the
  // player's total (we can't tell at scoring time which will be 1st vs 2nd).
  // 0.3 per producing hex → max 0.9 at a 3-hex inland spot, 0.3 at a coastal
  // 1-hex spot.
  const producingAdjCount = adjHexes.filter(h => h.resource !== 'desert').length;
  const startingHandBonus = producingAdjCount * 0.3;

  // Pair-scarcity bonus: for each pair of distinct producing resources at
  // this intersection, check whether that pair is rare on the map's macro
  // distribution. A brick-wood corner on a board with few brick-wood pairs
  // overall is a precious commodity — almost the only place to execute the
  // road-rush plan. Sums per pair, capped overall.
  let pairScarcityBonus = 0;
  const adjProducing = adjHexes
    .filter(h => h.resource !== 'desert')
    .map(h => h.resource as ProducingResource);
  const seenPairs = new Set<string>();
  for (let i = 0; i < adjProducing.length; i++) {
    for (let j = i + 1; j < adjProducing.length; j++) {
      if (adjProducing[i] === adjProducing[j]) continue;
      const k = pairKey(adjProducing[i], adjProducing[j]);
      if (seenPairs.has(k)) continue;
      seenPairs.add(k);
      const p = pairsByKey.get(k);
      if (p && p.expected >= 1 && p.observed < p.expected) {
        const deficit = p.expected - p.observed;
        pairScarcityBonus += Math.min(0.4, deficit * 0.15);
      }
    }
  }
  pairScarcityBonus = Math.min(1.0, pairScarcityBonus);

  // Same-number-on-multiple-adjacent-hexes is a double-edged sword: large
  // payout when the number rolls, but the spot depends on a SINGLE die roll
  // for its income (vs. the typical 2–3 distinct numbers at an intersection).
  // Penalty scaled by the duplicate's pip value (higher numbers hurt less
  // since they roll more often).
  let sameNumberPenalty = 0;
  for (const [num, count] of numberCounts) {
    if (count > 1) {
      const dupes = count - 1;
      const pip = (PIP_VALUE[num] ?? 0);
      // 6/8 dupe: small penalty (~0.6); 2/12 dupe: large penalty (~1.4)
      const perDupe = 1.6 - 0.2 * pip;
      sameNumberPenalty -= dupes * Math.max(0.4, perDupe);
    }
  }

  // Scarcity bonus: each UNIQUE adjacent resource type contributes a small
  // premium proportional to how scarce that resource is on this map. Two
  // components, summed:
  //   • Tile-count scarcity: (maxTiles − tiles) × 0.5 — fewer hexes of this
  //     resource exist, fewer corners to compete for.
  //   • Pip-yield scarcity:  (maxPips  − pips ) × pipWeight — even if tile
  //     count is fine, if those tiles roll rarely the resource is hard to
  //     come by; this is the only term active in the current default config.
  // The tile-count term defaulted to 0 after the regeneration validation:
  // the box-rule tile bag is fixed (not "scarce" in any strategic sense),
  // and the term amplified a small structural pip advantage for 3-tile
  // resources into ~50% top-spot dominance. Removing it cut brick+ore
  // dominance to ~37% with no regression on acceptance / fairness / speed.
  let scarcityBonus = 0;
  for (const resource of uniqueResources) {
    const tiles = tilesPerResource.get(resource as ProducingResource) ?? 0;
    const pips = pipsPerResource.get(resource as ProducingResource) ?? 0;
    if (tiles > 0 && maxTiles > tiles) {
      scarcityBonus += (maxTiles - tiles) * scarcityConfig.tileWeight;
    }
    if (pips > 0 && maxPips > pips) {
      scarcityBonus += (maxPips - pips) * scarcityConfig.pipWeight;
    }
  }

  const total =
    pipValue +
    diversityBonus +
    portBonus +
    synergyBonus +
    scarcityBonus +
    roadPotentialBonus +
    startingHandBonus +
    pairScarcityBonus +
    sameNumberPenalty;

  // Per-resource pip totals at this spot — used for archetype classification.
  const pipByResource = new Map<ProducingResource, number>();
  for (const h of adjHexes) {
    if (h.resource === 'desert' || h.number === null) continue;
    pipByResource.set(
      h.resource as ProducingResource,
      (pipByResource.get(h.resource as ProducingResource) ?? 0) + (PIP_VALUE[h.number] ?? 0),
    );
  }
  const archetype = classifyArchetype(pipByResource, port);

  return {
    intersectionId: inter.id,
    pipValue,
    diversityBonus,
    portBonus,
    synergyBonus,
    scarcityBonus,
    expansionBonus: 0, // filled in by the expansion-potential pass in scoreMap
    roadPotentialBonus,
    startingHandBonus,
    pairScarcityBonus,
    sameNumberPenalty,
    total,
    hasRoadCombo,
    hasCityCombo,
    hasSettlementCombo,
    archetype,
  };
}

// Per-Catan-rules, the road-potential and starting-hand bonuses only apply to
// the SECOND settlement (which alone generates cards on placement and can
// turn those cards into a turn-1 road). For the FIRST settlement they're
// noise — what matters is pure long-term production. The snake-draft sim
// reflects this by ranking round-1 picks on first-pick value and round-2
// picks on the full total.
function firstPickValue(s: SpotScore): number {
  return s.total - s.roadPotentialBonus - s.startingHandBonus;
}

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

function simulateSnakeDraft(
  graph: IntersectionGraph,
  spots: Map<string, SpotScore>,
  playerCount: PlayerCount,
  hexById: Map<string, Hex>,
): FairnessReport {
  const order: number[] = [];
  for (let i = 0; i < playerCount; i++) order.push(i);
  for (let i = playerCount - 1; i >= 0; i--) order.push(i);

  const blocked = new Set<string>();
  const picks: FairnessReport['picks'] = [];
  const playerTotals = new Array(playerCount).fill(0);
  // Each player's resource exposure carried over from their FIRST pick.
  // Used to bias round-2 picks toward complementary resources — the classic
  // "don't double up on brick/wheat when your first spot already has both"
  // heuristic that nearly every player applies in real play.
  const playerResources: Set<ProducingResource>[] =
    Array.from({ length: playerCount }, () => new Set());

  // Cache the unique-producing-resource set per intersection so the pair-
  // value loop below doesn't re-walk hexIds on every comparison.
  const intResources = new Map<string, Set<ProducingResource>>();
  for (const inter of graph.intersections.values()) {
    intResources.set(inter.id, uniqueAdjResources(inter, hexById));
  }

  // Round-1 picks are evaluated as PAIRS, not greedily by individual value.
  // Real players pick their first settlement with a planned second-settlement
  // complement in mind: the 8-ore corner is more attractive if there's a
  // wheat-port spot the same player can also reach. For each candidate
  // round-1 spot A, we find the best round-2 spot B (must satisfy the
  // distance-2 rule from A) and score the pair as firstPickValue(A) +
  // (B.total + diversification(A→B)). The A whose best pair is largest
  // gets picked.
  //
  // Restricting the outer loop to the top-K firstPickValue spots makes this
  // O(K·N) per turn instead of O(N²) — fine in the generator's hot loop.
  // K covers all realistic openings; weaker spots almost never win pair
  // tournaments since A's individual value dominates the pair score.
  const TOP_K_R1 = 12;

  for (let step = 0; step < order.length; step++) {
    const playerIdx = order[step];
    const isSecondPick = step >= playerCount;
    const available = Array.from(spots.values()).filter(s => !blocked.has(s.intersectionId));
    if (available.length === 0) break;

    let chosen: SpotScore;
    let value: number;

    if (isSecondPick) {
      // R2: rank by full total + diversification against this player's
      // R1 resource set.
      const valueOf = (s: SpotScore) => {
        const adj = intResources.get(s.intersectionId) ?? new Set();
        let newRes = 0;
        for (const r of adj) if (!playerResources[playerIdx].has(r)) newRes++;
        return s.total + newRes * 0.5;
      };
      let bestVal = -Infinity;
      let bestSpot = available[0];
      for (const s of available) {
        const v = valueOf(s);
        if (v > bestVal) { bestVal = v; bestSpot = s; }
      }
      chosen = bestSpot;
      value = bestVal;
    } else {
      // R1: pair-value evaluation with SURVIVAL-DISCOUNTED planning.
      //
      // The planner anticipates a R2 pick when choosing R1, but the planned
      // B is more likely to survive when fewer picks happen between now
      // and the player's R2 turn. Snake order makes this asymmetric:
      //   • P-last R1 → R2 is the very next pick. K = 0 → discount = 1.0.
      //     Their plan executes; the full pair value matters.
      //   • P1 R1 → R2 is 2N−2 picks away. K is large → discount is small.
      //     Their planned B is almost certainly stolen, so they should pick
      //     A as a robust standalone rather than half of a fragile plan.
      //
      // Without this discount the planner gave every player the same
      // optimistic "I'll get my planned B" expectation, which artificially
      // inflated P-last's edge (verified: the entire 3.5% P-last advantage
      // at 6p in the prior diagnostic was planner-induced — greedy mode
      // showed ~0% bias on the same maps). Survival discounting puts the
      // planner halfway between optimistic and greedy: forward-looking but
      // uncertainty-aware.
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

        // Best B compatible with A under the distance-2 rule.
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
        if (pair > bestPair) {
          bestPair = pair;
          bestA = A;
        }
      }
      chosen = bestA;
      value = firstPickValue(chosen);
    }

    picks.push({ playerIndex: playerIdx, intersectionId: chosen.intersectionId, value });
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
  const stdev = Math.sqrt(variance);
  const spread = Math.max(...playerTotals) - Math.min(...playerTotals);
  return { playerTotals, stdev, spread, picks };
}

export function computeHealth(hexes: Hex[]): ResourceHealth[] {
  type Stats = {
    resource: ProducingResource; tiles: number;
    totalPips: number; pipVariance: number; concentration: number; topNumber: number | null;
  };
  const stats: Stats[] = PRODUCING_RESOURCES.map(res => {
    const tiles = hexes.filter(h => h.resource === res);
    const pips = tiles.map(h => (h.number !== null ? PIP_VALUE[h.number] : 0));
    const totalPips = pips.reduce((a, b) => a + b, 0);
    const mean = pips.length ? totalPips / pips.length : 0;
    const pipVariance = pips.length ? pips.reduce((a, b) => a + (b - mean) ** 2, 0) / pips.length : 0;
    const numberPips = new Map<number, number>();
    for (const t of tiles) {
      if (t.number !== null) numberPips.set(t.number, (numberPips.get(t.number) ?? 0) + PIP_VALUE[t.number]);
    }
    let topNumber: number | null = null;
    let topPips = 0;
    for (const [n, p] of numberPips) {
      if (p > topPips) { topPips = p; topNumber = n; }
    }
    const concentration = totalPips > 0 ? topPips / totalPips : 0;
    return { resource: res, tiles: tiles.length, totalPips, pipVariance, concentration, topNumber };
  });

  const boardTiles = stats.reduce((s, st) => s + st.tiles, 0);
  const boardPips = stats.reduce((s, st) => s + st.totalPips, 0);

  return stats.map(st => {
    const productionShare = boardPips > 0 ? st.totalPips / boardPips : 0;
    const expectedShare = boardTiles > 0 ? st.tiles / boardTiles : 0;
    const ratio = expectedShare > 0 ? productionShare / expectedShare : 1;

    // Status reflects the worst of three independent signals:
    //   (a) Robber-vulnerability — concentration > 0.6 means a 7 wiping out
    //       this resource's top number cripples the resource entirely.
    //   (b) Absolute pip floor — totalPips < 5 is starved no matter what.
    //   (c) Production-share deviation — even with decent absolute pips, a
    //       resource producing far below its tile-share allocation poisons
    //       the trading economy (everyone needs it; nobody has it).
    let status: ResourceHealth['status'] = 'healthy';
    if (st.totalPips < 7) status = 'warning';
    if (st.totalPips < 5) status = 'unhealthy';
    if (st.concentration > 0.6) status = 'unhealthy';
    if (st.tiles > 0) {
      if (ratio < 0.75 || ratio > 1.4) status = status === 'unhealthy' ? 'unhealthy' : 'warning';
      if (ratio < 0.6 || ratio > 1.7) status = 'unhealthy';
    }

    return {
      resource: st.resource,
      totalPips: st.totalPips,
      pipVariance: st.pipVariance,
      concentration: st.concentration,
      topNumber: st.topNumber,
      productionShare,
      expectedShare,
      status,
    };
  });
}

export function isResourceHealthy(
  health: ResourceHealth[],
  hexes: Hex[],
  _playerCount: PlayerCount,
): boolean {
  const tilesByResource = new Map<string, Hex[]>();
  for (const h of hexes) {
    if (h.resource === 'desert') continue;
    if (!tilesByResource.has(h.resource)) tilesByResource.set(h.resource, []);
    tilesByResource.get(h.resource)!.push(h);
  }
  for (const h of health) {
    const tiles = tilesByResource.get(h.resource) ?? [];
    // Starved if average pip per tile < 1.7 (i.e. mostly 2s/12s/3s).
    if (h.totalPips < Math.ceil(tiles.length * 1.7)) return false;
    // Robber-vulnerable if >75% of pips on a single number AND the resource is small.
    if (tiles.length <= 3 && h.concentration > 0.8) return false;
    if (tiles.length >= 4 && h.concentration > 0.7) return false;
    // Each resource needs at least one high-yield number (5/6/8/9) so that
    // the resource isn't dead-on-arrival when its low-yield numbers don't roll.
    const hasHighYield = tiles.some(t => t.number !== null && HIGH_YIELD_NUMBERS.has(t.number));
    if (!hasHighYield) return false;
    // Production-share check: trading collapses when one resource produces
    // far less (or more) than its tile-count share predicts. The classic
    // example: ore+wheat take 60% of board production, brick+wood take 20%
    // — everyone needs brick/wood, nobody can offer them, bank trades stall
    // the game. Symmetric upper bound catches "one resource floods the
    // market." Allow tighter slack than the absolute starved threshold so
    // these checks don't double-fire on the same map.
    if (h.expectedShare > 0) {
      const ratio = h.productionShare / h.expectedShare;
      if (ratio < 0.6 || ratio > 1.7) return false;
    }
  }
  return true;
}

/** True if the board's pip yield is reasonably distributed across its 4
 *  quadrants — fails when high-yield numbers cluster into a "super
 *  continent" leaving the rest of the map productively dead. Threshold:
 *  the spread between best- and worst-producing quadrant's pip-share-to-
 *  tile-share ratio is ≤ 1.0. (A perfectly balanced map sits near 0.2-0.3
 *  spread; a clearly skewed map blows past 1.0.) */
export function hasBalancedPipDistribution(hexes: Hex[]): boolean {
  const { spread } = computePipSpatial(hexes);
  return spread <= 1.0;
}

/** True if the 5 specific-resource ports have roughly balanced hinterland
 *  strength. The user's flagged failure mode: an ore port adjacent to two
 *  high-yield ore tiles is wildly more valuable than a sheep port adjacent
 *  to weak sheep tiles, even though the canonical port count is identical.
 *  Threshold: max/min support ratio ≤ 3.0 (looser than 2.0 to allow real
 *  variation; tighter than 5.0 which lets the worst cases through). */
export function arePortsBalanced(ports: Port[], hexes: Hex[]): boolean {
  const graph = buildIntersectionGraph(hexes);
  const hexById = new Map(hexes.map(h => [h.id, h] as const));
  const supports = computePortSupport(ports, graph, hexById);
  const specific = supports.filter(p => p.type !== 'generic').map(p => p.supportScore);
  if (specific.length < 2) return true;
  const max = Math.max(...specific);
  const min = Math.min(...specific);
  if (min <= 0) return false; // a specific port with zero support is a dead port
  return max / min <= 3.0;
}

export function hasDroughtCluster(hexes: Hex[]): boolean {
  // Returns true if there is at least one triplet of mutually-adjacent hexes
  // all carrying low-yield numbers (2, 3, 11, 12).
  const byKey = new Map(hexes.map(h => [`${h.q},${h.r}`, h] as const));
  for (const hex of hexes) {
    if (hex.number === null || !LOW_YIELD_NUMBERS.has(hex.number)) continue;
    const nbs = [
      { q: hex.q + 1, r: hex.r }, { q: hex.q + 1, r: hex.r - 1 },
      { q: hex.q, r: hex.r - 1 }, { q: hex.q - 1, r: hex.r },
      { q: hex.q - 1, r: hex.r + 1 }, { q: hex.q, r: hex.r + 1 },
    ].map(c => byKey.get(`${c.q},${c.r}`)).filter((h): h is Hex => !!h && h.number !== null && LOW_YIELD_NUMBERS.has(h.number));
    for (let i = 0; i < nbs.length; i++) {
      for (let j = i + 1; j < nbs.length; j++) {
        const a = nbs[i];
        const b = nbs[j];
        const dq = a.q - b.q;
        const dr = a.r - b.r;
        const adj = (dq === 1 && dr === 0) || (dq === -1 && dr === 0) ||
                    (dq === 0 && dr === 1) || (dq === 0 && dr === -1) ||
                    (dq === 1 && dr === -1) || (dq === -1 && dr === 1);
        if (adj) return true;
      }
    }
  }
  return false;
}
