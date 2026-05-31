export type Resource = 'wood' | 'brick' | 'wheat' | 'sheep' | 'ore' | 'desert';
export type ProducingResource = Exclude<Resource, 'desert'>;
export type PortType = ProducingResource | 'generic';
export type PlayerCount = 3 | 4 | 5 | 6;

export type ChallengeFlavor = 'none' | 'scarcity' | 'boomOrBust' | 'drought' | 'random';
export type ChallengeRolled = Exclude<ChallengeFlavor, 'none' | 'random'>;

export interface AxialCoord {
  q: number;
  r: number;
}

export interface Hex extends AxialCoord {
  id: string;
  resource: Resource;
  number: number | null;
}

export interface Port {
  hexId: string;
  side: 0 | 1 | 2 | 3 | 4 | 5;
  type: PortType;
}

export interface Variants {
  includeDesert: boolean;
  desertReplacement: ProducingResource;
  shufflePorts: boolean;
  noSameNumberAdjacent: boolean;
  noSameNumberOnResource: boolean;
  noMultipleRedsOnResource: boolean;
  challenge: {
    flavor: ChallengeFlavor;
    targetResource: ProducingResource | 'any';
    rolledFlavor?: ChallengeRolled;
    rolledTarget?: ProducingResource;
  };
}

export interface MapState {
  playerCount: PlayerCount;
  hexes: Hex[];
  ports: Port[];
  variants: Variants;
  /** u32 seed fed directly to mulberry32. Display as base36 for humans. */
  seed: number;
}

export interface Intersection {
  id: string;
  hexIds: string[];
  neighbors: string[];
  x: number;
  y: number;
}

/** Strategic archetype a spot best fits. Drives the map-level diversity
 *  check: a healthy Catan board supports multiple paths to victory, so the
 *  top-N intersections should be split across several archetypes. A board
 *  where the top 20 spots are all city-rush is balanced on paper but
 *  strategically stale — every player will pursue the same plan. */
export type Archetype =
  | 'expansion'      // brick + wood for road rush, settlement spread
  | 'cityRush'       // ore + wheat for fast cities
  | 'portEconomy'    // strong port adjacency (especially matching resource)
  | 'devCards'       // sheep-heavy for dev-card spam + knight army
  | 'balanced';      // wide resource diversity, jack-of-all-trades flex

export interface SpotScore {
  intersectionId: string;
  pipValue: number;
  diversityBonus: number;
  portBonus: number;
  synergyBonus: number;
  scarcityBonus: number;
  expansionBonus: number;
  /** Bonus for having BOTH brick and wood adjacent (any numbers) — enables an
   *  early road, which is the snake-draft expansion lever. Distinct from the
   *  shared-number "road combo" inside synergyBonus. */
  roadPotentialBonus: number;
  /** Bonus for the resource cards generated when this spot is placed as the
   *  second settlement (one card per adjacent producing hex per Catan rules).
   *  Models the early-game speed-run plan: get cards on placement → road →
   *  third settlement at a distance-2 spot. */
  startingHandBonus: number;
  /** Bonus for containing a pair of adjacent resources that is rare on this
   *  map's macro distribution. A brick+wood corner on a board with few
   *  brick-wood adjacencies overall is a premium spot regardless of pip
   *  totals — it's one of the only places to execute the road-rush plan. */
  pairScarcityBonus: number;
  sameNumberPenalty: number;
  total: number;
  hasRoadCombo: boolean;
  hasCityCombo: boolean;
  hasSettlementCombo: boolean;
  /** Strategic archetype this spot best fits — see Archetype. Single
   *  dominant label, used in the top-20 archetypeMix UI display. */
  archetype: Archetype;
  /** All archetypes this spot is STRUCTURALLY eligible for (multi-label).
   *  Drives the strategic-diversity gate via board-wide viable counts.
   *  Distinct from `archetype` (single dominant label): one spot can
   *  legitimately contribute to multiple archetypes' viability counts
   *  (e.g., a brick+wood+wheat corner is eligible for expansion AND
   *  balanced). Each archetype's eligibility predicate is purely
   *  structural — quality is not factored here; that's a separate
   *  diagnostic surface. */
  eligibleArchetypes: Archetype[];
}

export interface ResourceHealth {
  resource: ProducingResource;
  totalPips: number;
  pipVariance: number;
  concentration: number;
  topNumber: number | null;
  /** This resource's share of the board's total pip production:
   *  totalPips / Σ(allResources.totalPips). Distinct from absolute pip count
   *  — captures relative production. */
  productionShare: number;
  /** Baseline share if pips were proportional to tile counts:
   *  tiles / totalProducingTiles. The yardstick productionShare is judged
   *  against — a resource with 22% of tiles "should" produce ~22% of pips,
   *  and large deviations break the trading economy. */
  expectedShare: number;
  status: 'healthy' | 'warning' | 'unhealthy';
}

/** Spatial pip distribution measured by board quadrant. Each quadrant's
 *  share of total pips is compared to its share of producing tiles — a
 *  quadrant that holds 25% of tiles but 50% of pips is a "super continent"
 *  even if no individual rule is broken. spread = max − min of those
 *  ratios across the 4 quadrants. */
export interface PipSpatial {
  /** Total pip yield in each quadrant: [NW, NE, SW, SE] (SVG coords). */
  quadrantPips: [number, number, number, number];
  /** Producing tile count in each quadrant. */
  quadrantTiles: [number, number, number, number];
  /** Each quadrant's (pip share) / (tile share). 1.0 = proportional. */
  quadrantRatios: [number, number, number, number];
  /** max − min of quadrantRatios. Higher = more uneven distribution. */
  spread: number;
}

/** Per-port hinterland strength. supportScore sums the pip yields of nearby
 *  matching-resource hexes (or all producing hexes for generic ports),
 *  weighted by graph distance from the port intersection — a proxy for
 *  "how productive is the territory this port can serve." Two specific
 *  ports of equal type can have wildly different supportScore depending on
 *  what the surrounding numbers rolled. */
export interface PortSupport {
  type: PortType;
  /** The 1-2 intersection IDs at the port's land-corner edge. */
  intersectionIds: string[];
  supportScore: number;
}

/** Map-level adjacency frequency for one ordered-canonical resource pair.
 *  `expected` is the count you'd see if pairs were distributed proportional
 *  to the product of tile counts (a · b / Σ(i · j) for distinct unordered
 *  pairs). `delta = observed − expected`: negative means the pair is rarer
 *  than chance, positive means abundant. Drives the pair-scarcity bonus in
 *  spot scoring and the pair table in the analyze panel. */
export interface ResourcePair {
  a: ProducingResource;
  b: ProducingResource;
  observed: number;
  expected: number;
  delta: number;
  status: 'rare' | 'normal' | 'abundant';
}

export interface FairnessReport {
  playerTotals: number[];
  stdev: number;
  spread: number;
  picks: Array<{ playerIndex: number; intersectionId: string; value: number }>;
}
