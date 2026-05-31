/** Focused dive into why portEconomy is ~0% of top-20 spots. Hypothesis:
 *  port-adjacent spots are COASTAL (1-2 hexes only), so their pip total is
 *  too low to rank in top-20 even when their classification fits perfectly. */
import { describe, it } from 'vitest';
import { generateMap } from '../src/generator/generate';
import { scoreMap } from '../src/generator/score';
import type { Variants, PlayerCount } from '../src/game/types';

const RUN = process.env.RUN_PORTECON === '1';

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

describe('port economy diagnostic', () => {
  it.runIf(RUN)('count port-adjacent spots in top-N vs full ranks', () => {
    const COUNTS = 200;
    for (const pc of [4, 6] as PlayerCount[]) {
      console.log(`\n=== pc=${pc} ===`);
      let portInTop20 = 0;
      let portInTop50 = 0;
      let portInAll = 0;
      let avgPortSpotRank = 0;
      let avgPortSpotsCount = 0;
      let avgPortSpotPipValue = 0;
      let avgTopSpotPipValue = 0;
      for (let i = 0; i < COUNTS; i++) {
        const { map } = generateMap({ playerCount: pc, variants: v() });
        const scored = scoreMap(map.hexes, map.ports, pc);
        // Find port intersections.
        const portInters = new Set<string>();
        for (const port of map.ports) {
          const a = scored.graph.byHexCorner.get(`${port.hexId}:${port.side}`);
          const b = scored.graph.byHexCorner.get(`${port.hexId}:${(port.side + 1) % 6}`);
          if (a) portInters.add(a);
          if (b) portInters.add(b);
        }
        const sorted = Array.from(scored.spots.values()).sort((a, b) => b.total - a.total);
        avgTopSpotPipValue += sorted[0].pipValue;
        let countAtPort = 0;
        let portPipSum = 0;
        for (let j = 0; j < sorted.length; j++) {
          if (portInters.has(sorted[j].intersectionId)) {
            countAtPort++;
            portPipSum += sorted[j].pipValue;
            avgPortSpotRank += j;
            if (j < 20) portInTop20++;
            if (j < 50) portInTop50++;
            portInAll++;
          }
        }
        avgPortSpotsCount += countAtPort;
        avgPortSpotPipValue += countAtPort > 0 ? portPipSum / countAtPort : 0;
      }
      console.log(`  port intersections per map (avg): ${(avgPortSpotsCount / COUNTS).toFixed(2)}`);
      console.log(`  port spots ranked in top-20:      ${portInTop20} / ${COUNTS} maps (${(portInTop20 / COUNTS).toFixed(2)} per map)`);
      console.log(`  port spots ranked in top-50:      ${portInTop50} / ${COUNTS} maps (${(portInTop50 / COUNTS).toFixed(2)} per map)`);
      console.log(`  avg pip-value of port spot:       ${(avgPortSpotPipValue / COUNTS).toFixed(2)}`);
      console.log(`  avg pip-value of top spot:        ${(avgTopSpotPipValue / COUNTS).toFixed(2)}`);
      console.log(`  avg rank of port spots:           ${(avgPortSpotRank / portInAll).toFixed(1)}`);
    }
  }, 5 * 60 * 1000);
});
