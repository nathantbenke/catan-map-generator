import { boardFor, HIGH_YIELD_NUMBERS, RED_NUMBERS } from '../game/constants';
import { buildEmptyLayout, buildHexIndex, hexNeighbors } from '../game/layout';
import type { Hex, PlayerCount, Port, PortType, Resource, Variants } from '../game/types';
import { shuffle } from './random';

export interface RandomizedMap {
  hexes: Hex[];
  ports: Port[];
}

function adjustForVariants(playerCount: PlayerCount, variants: Variants) {
  const spec = boardFor(playerCount);
  const resourceCounts: Record<Resource, number> = { ...spec.resourceCounts };
  const numberCounts: Record<number, number> = { ...spec.numberCounts };

  // 5-6 expansion always uses 2 deserts per the rules — ignore an attempt
  // to turn it off (the UI also disables that toggle, but be defensive).
  const includeDesert = playerCount > 4 ? true : variants.includeDesert;

  if (!includeDesert) {
    const replacement = variants.desertReplacement;
    const desertCount = resourceCounts.desert ?? 0;
    resourceCounts.desert = 0;
    resourceCounts[replacement] = (resourceCounts[replacement] ?? 0) + desertCount;
    for (let i = 0; i < desertCount; i++) {
      const mid = [4, 10, 5, 9, 3, 11][i % 6];
      numberCounts[mid] = (numberCounts[mid] ?? 0) + 1;
    }
  }
  return { resourceCounts, numberCounts };
}

function placeResources(
  hexes: Hex[],
  bag: Resource[],
  rng: () => number,
  strict: boolean,
): boolean {
  const order = shuffle(hexes.map((_, i) => i), rng);
  const remaining: Resource[] = bag.slice();
  for (const idx of order) {
    const hex = hexes[idx];
    const byKey = buildHexIndex(hexes);
    const neighborResources = new Set(
      hexNeighbors(hex, byKey).map(n => n.resource).filter(r => r !== 'desert'),
    );
    const candidatesIdx: number[] = [];
    for (let i = 0; i < remaining.length; i++) {
      const r = remaining[i];
      if (r === 'desert' || !neighborResources.has(r)) candidatesIdx.push(i);
    }
    if (candidatesIdx.length === 0) {
      if (!strict) {
        // Fallback to any remaining tile
        candidatesIdx.push(...remaining.map((_, i) => i));
      } else {
        return false;
      }
    }
    const chosenPos = candidatesIdx[Math.floor(rng() * candidatesIdx.length)];
    hex.resource = remaining[chosenPos];
    remaining.splice(chosenPos, 1);
  }
  return true;
}

/** High-yield placement strategies:
 *  - 'off':     no preference, placement is uniform over candidates
 *  - 'byCount': equalize COUNT of high-yields per resource (current default).
 *               Side effect: 3-tile resources get higher PER-TILE high-yield
 *               rate because the same count divides into fewer tiles. This
 *               creates a ~5% per-tile pip advantage for brick/ore.
 *  - 'byRate':  equalize RATE of high-yields per tile across resources.
 *               Picks the resource with the lowest (hyCount / totalTiles)
 *               ratio. Removes the 3-tile per-tile bias. */
export type SpreadHighYieldMode = 'off' | 'byCount' | 'byRate';

interface PlaceNumbersOpts {
  spreadHighYield: SpreadHighYieldMode;
  noSameNumberAdjacent: boolean;
  noSameNumberOnResource: boolean;
  noMultipleRedsOnResource: boolean;
}

function placeNumbers(
  hexes: Hex[],
  bag: number[],
  rng: () => number,
  opts: PlaceNumbersOpts,
): boolean {
  const slots = hexes.filter(h => h.resource !== 'desert');
  for (const h of slots) h.number = null;

  // Two-phase placement:
  //   1. High-yield numbers (5, 6, 8, 9) — when spreading, push them onto the
  //      resource with the fewest existing high-yields. Reds first since they
  //      have the tightest neighbor constraint.
  //   2. Remaining numbers — fill the rest with a light "don't duplicate the
  //      same number on the same resource" preference.
  const highYieldNumbers = bag.filter(n => HIGH_YIELD_NUMBERS.has(n));
  const lowYieldNumbers = bag.filter(n => !HIGH_YIELD_NUMBERS.has(n));
  highYieldNumbers.sort((a, b) => Number(RED_NUMBERS.has(b)) - Number(RED_NUMBERS.has(a)));

  const byKey = buildHexIndex(hexes);

  // Total reds in the bag — used by the noMultipleReds cap below. With base
  // counts (2×6 + 2×8 = 4 reds, 5 producing resources) the cap is 1; with the
  // expansion (3×6 + 3×8 = 6 reds, 5 resources) the cap is 2.
  const totalReds = highYieldNumbers.filter(n => RED_NUMBERS.has(n)).length;
  const producingResources = new Set<string>();
  for (const s of slots) producingResources.add(s.resource);
  const redCap = producingResources.size > 0 ? Math.ceil(totalReds / producingResources.size) : Infinity;

  for (const num of highYieldNumbers) {
    const isRed = RED_NUMBERS.has(num);
    const hyCount = new Map<string, number>();
    const redCountByResource = new Map<string, number>();
    const resourcesAlreadyWithNum = new Set<string>();
    for (const s of slots) {
      if (s.number === null) continue;
      if (HIGH_YIELD_NUMBERS.has(s.number)) {
        hyCount.set(s.resource, (hyCount.get(s.resource) ?? 0) + 1);
      }
      if (RED_NUMBERS.has(s.number)) {
        redCountByResource.set(s.resource, (redCountByResource.get(s.resource) ?? 0) + 1);
      }
      if (s.number === num) resourcesAlreadyWithNum.add(s.resource);
    }

    const candidates = slots.filter(s => {
      if (s.number !== null) return false;
      const ns = hexNeighbors(s, byKey);
      if (isRed && ns.some(n => n.number !== null && RED_NUMBERS.has(n.number))) return false;
      if (violatesTripleHighYield(s, num, hexes)) return false;
      if (opts.noSameNumberAdjacent && ns.some(n => n.number === num)) return false;
      if (opts.noSameNumberOnResource && resourcesAlreadyWithNum.has(s.resource)) return false;
      if (opts.noMultipleRedsOnResource && isRed && (redCountByResource.get(s.resource) ?? 0) >= redCap) return false;
      return true;
    });
    if (candidates.length === 0) return false;

    let pool = candidates;
    if (opts.spreadHighYield !== 'off') {
      // Count or rate? byCount equalizes total high-yield placements per
      // resource; byRate equalizes per-tile rate so 3-tile resources don't
      // accumulate higher-density high-yields than 4-tile resources.
      const tileCount = new Map<string, number>();
      for (const s of slots) tileCount.set(s.resource, (tileCount.get(s.resource) ?? 0) + 1);
      const metric = (resource: string): number => {
        const c = hyCount.get(resource) ?? 0;
        if (opts.spreadHighYield === 'byRate') {
          const t = tileCount.get(resource) ?? 1;
          return c / t;
        }
        return c;
      };
      let minMetric = Infinity;
      for (const c of candidates) {
        const m = metric(c.resource);
        if (m < minMetric) minMetric = m;
      }
      const preferred = candidates.filter(c => metric(c.resource) === minMetric);
      if (preferred.length > 0) pool = preferred;
    }
    // Soft preference (always on): don't place this number on a resource that
    // already has it. Falls back to the broader pool when impossible.
    const uniqueOnResource = pool.filter(c => !resourcesAlreadyWithNum.has(c.resource));
    if (uniqueOnResource.length > 0) pool = uniqueOnResource;

    const chosen = pool[Math.floor(rng() * pool.length)];
    chosen.number = num;
  }

  const shuffledRest = shuffle(lowYieldNumbers, rng);
  const remainingSlots = shuffle(slots.filter(s => s.number === null), rng);
  for (const num of shuffledRest) {
    const sameNumOnResource = new Set<string>();
    for (const s of slots) {
      if (s.number === num) sameNumOnResource.add(s.resource);
    }
    const validSoft = (s: Hex): boolean => {
      if (s.number !== null) return false;
      if (opts.noSameNumberAdjacent && hexNeighbors(s, byKey).some(n => n.number === num)) return false;
      return true;
    };
    const validStrict = (s: Hex): boolean => {
      if (!validSoft(s)) return false;
      if (opts.noSameNumberOnResource && sameNumOnResource.has(s.resource)) return false;
      return true;
    };
    let target = remainingSlots.find(s => validStrict(s) && !sameNumOnResource.has(s.resource));
    if (!target) target = remainingSlots.find(validStrict);
    if (!target && !opts.noSameNumberOnResource) target = remainingSlots.find(validSoft);
    if (!target) return false;
    target.number = num;
  }
  return true;
}

function violatesTripleHighYield(target: Hex, proposedNumber: number, hexes: Hex[]): boolean {
  const byKey = buildHexIndex(hexes);
  const nbs = hexNeighbors(target, byKey);
  const highNbs = nbs.filter(n => n.number !== null && HIGH_YIELD_NUMBERS.has(n.number));
  for (let i = 0; i < highNbs.length; i++) {
    for (let j = i + 1; j < highNbs.length; j++) {
      const a = highNbs[i];
      const b = highNbs[j];
      const dq = a.q - b.q;
      const dr = a.r - b.r;
      const adj =
        (dq === 1 && dr === 0) || (dq === -1 && dr === 0) ||
        (dq === 0 && dr === 1) || (dq === 0 && dr === -1) ||
        (dq === 1 && dr === -1) || (dq === -1 && dr === 1);
      if (adj && proposedNumber !== 0) return true;
    }
  }
  return false;
}

function countsMatchBag(hexes: Hex[], expected: Record<Resource, number>): boolean {
  const actual: Partial<Record<Resource, number>> = {};
  for (const h of hexes) actual[h.resource] = (actual[h.resource] ?? 0) + 1;
  for (const [res, n] of Object.entries(expected) as Array<[Resource, number]>) {
    if ((actual[res] ?? 0) !== n) return false;
  }
  return true;
}

function placePorts(
  slots: Array<{ hexId: string; side: 0 | 1 | 2 | 3 | 4 | 5 }>,
  portBag: PortType[],
  rng: () => number,
  shufflePorts: boolean,
): Port[] {
  const bag = shufflePorts ? shuffle(portBag, rng) : portBag.slice();
  return slots.slice(0, bag.length).map((slot, i) => ({
    hexId: slot.hexId,
    side: slot.side,
    type: bag[i],
  }));
}

export function randomizeMap(
  playerCount: PlayerCount,
  variants: Variants,
  rng: () => number,
  spreadMode?: SpreadHighYieldMode,
): RandomizedMap {
  const { resourceCounts, numberCounts } = adjustForVariants(playerCount, variants);
  const layout = buildEmptyLayout(playerCount);
  const hexes: Hex[] = layout.hexes.map(h => ({ ...h }));

  const resourceBag = (Object.entries(resourceCounts) as Array<[Resource, number]>)
    .flatMap(([res, n]) => Array.from({ length: n }, () => res));
  const numberBag = (Object.entries(numberCounts) as Array<[string, number]>)
    .flatMap(([num, n]) => Array.from({ length: n }, () => Number(num)));

  // Try strict resource placement first; if it fails all 8 attempts we must
  // do a non-strict placement so the hex array isn't left in a half-placed
  // state (which previously leaked extra desert hexes into the output).
  let placedStrictly = false;
  for (let strictTry = 0; strictTry < 8; strictTry++) {
    for (const h of hexes) h.resource = 'desert';
    if (placeResources(hexes, resourceBag, rng, true)) {
      placedStrictly = true;
      break;
    }
  }
  if (!placedStrictly) {
    for (const h of hexes) h.resource = 'desert';
    placeResources(hexes, resourceBag, rng, false);
  }

  // Defensive sanity check: the resource counts on the board MUST match the
  // bag. If they don't, force a non-strict placement (which always finishes).
  if (!countsMatchBag(hexes, resourceCounts)) {
    for (const h of hexes) h.resource = 'desert';
    placeResources(hexes, resourceBag, rng, false);
  }

  placeNumbers(hexes, numberBag, rng, {
    // Only enforce the "spread high-yield across resources" preference in
    // balanced mode. Challenge mode needs the freedom to produce starved or
    // concentrated resources naturally. Default mode preserves legacy
    // behavior (byCount); experiments may override via spreadMode.
    spreadHighYield: variants.challenge.flavor === 'none' ? (spreadMode ?? 'byCount') : 'off',
    noSameNumberAdjacent: variants.noSameNumberAdjacent,
    noSameNumberOnResource: variants.noSameNumberOnResource,
    noMultipleRedsOnResource: variants.noMultipleRedsOnResource,
  });

  const ports = placePorts(layout.perimeterPortSlots, boardFor(playerCount).portTypes, rng, variants.shufflePorts);
  return { hexes, ports };
}
