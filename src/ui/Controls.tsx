import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useGesture } from '@use-gesture/react';
import { useAppStore } from '../state/store';
import { PRODUCING_RESOURCES } from '../game/constants';
import type { ChallengeFlavor, PlayerCount, ProducingResource } from '../game/types';

const MOBILE_QUERY = '(max-width: 899px)';
// Height of the peek (handle) row when the drawer is collapsed. The
// useLayoutEffect that drives transform reads offsetHeight off the drawer,
// so the only thing this constant has to match is the *actual* rendered
// height of `.controls__handle` (padding + drag bar + label ≈ 56px).
const PEEK_PX = 56;

const PLAYER_COUNTS: PlayerCount[] = [3, 4, 5, 6];

const FLAVOR_LABELS: Record<ChallengeFlavor, string> = {
  none: 'None (balanced)',
  scarcity: 'Scarcity',
  boomOrBust: 'Boom-or-bust',
  drought: 'Drought',
  random: 'Random',
};

const FLAVOR_HELP: Record<ChallengeFlavor, string> = {
  none: 'Standard balanced map. Each resource gets at least one good number; high-yield numbers are spread across resource types.',
  scarcity: 'The target resource will have very low total yield — it stays rare all game. Pick which resource (or "Any") below.',
  boomOrBust: 'The target resource gets ~60%+ of its pips on a single number. When that number rolls, payday. When it doesn\'t, drought.',
  drought: 'At least one cluster of 3 adjacent hexes all carry low-yield numbers (2/3/11/12) — a "dead zone" you have to plan around.',
  random: 'Picks one of Scarcity / Boom-or-bust / Drought at random. The Analyze view shows which one rolled.',
};

export function Controls() {
  const playerCount = useAppStore(s => s.playerCount);
  const variants = useAppStore(s => s.variants);
  const showBestLocations = useAppStore(s => s.showBestLocations);
  const showResourceHealth = useAppStore(s => s.showResourceHealth);
  const waterFrame = useAppStore(s => s.waterFrame);
  const map = useAppStore(s => s.map);
  const scored = useAppStore(s => s.scored);
  const generating = useAppStore(s => s.generating);
  const attempts = useAppStore(s => s.attempts);
  const fellBack = useAppStore(s => s.fellBack);

  const setPlayerCount = useAppStore(s => s.setPlayerCount);
  const setVariants = useAppStore(s => s.setVariants);
  const setChallenge = useAppStore(s => s.setChallenge);
  const toggleShowBestLocations = useAppStore(s => s.toggleShowBestLocations);
  const toggleShowResourceHealth = useAppStore(s => s.toggleShowResourceHealth);
  const toggleWaterFrame = useAppStore(s => s.toggleWaterFrame);
  const generate = useAppStore(s => s.generate);

  const showTargetPicker =
    variants.challenge.flavor === 'scarcity' || variants.challenge.flavor === 'boomOrBust';

  const [shareStatus, setShareStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (shareStatus === 'idle') return;
    const t = window.setTimeout(() => setShareStatus('idle'), 2000);
    return () => window.clearTimeout(t);
  }, [shareStatus]);
  const onShare = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setShareStatus('copied');
    } catch (err) {
      console.warn('clipboard write failed', err);
      setShareStatus('failed');
    }
  };

  // Mobile drawer state. On phones the drawer starts closed; the user can
  // tap the handle to toggle, or drag it up/down (gesture below) to scrub the
  // open position 1:1 with the finger and snap on release. Desktop ignores
  // all of this — the side panel is always visible via the
  // @media (min-width: 900px) rule in app.css.
  const [isMobile, setIsMobile] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(MOBILE_QUERY).matches,
  );
  const [open, setOpen] = useState(false);
  const drawerRef = useRef<HTMLElement | null>(null);
  const handleRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  const closedOffset = () => {
    const el = drawerRef.current;
    if (!el) return 0;
    return Math.max(0, el.offsetHeight - PEEK_PX);
  };

  // Keep DOM transform in sync with the open/closed state. We don't use CSS
  // class transforms because the drag handler also writes to .style.transform
  // (without transition) — having a single source of truth on the inline
  // style avoids fighting CSS for the drag-snap animation.
  useLayoutEffect(() => {
    const el = drawerRef.current;
    if (!el) return;
    if (!isMobile) {
      el.style.transform = '';
      el.style.transition = '';
      return;
    }
    el.style.transition = 'transform 0.28s ease';
    el.style.transform = open ? 'translateY(0)' : `translateY(${closedOffset()}px)`;
  }, [open, isMobile]);

  useGesture(
    {
      onDrag: ({ first, last, movement: [, my], velocity: [, vy], direction: [, dyDir] }) => {
        if (!isMobile) return;
        const el = drawerRef.current;
        if (!el) return;
        const closedY = closedOffset();
        const baseY = open ? 0 : closedY;
        const targetY = Math.max(0, Math.min(closedY, baseY + my));
        if (first) {
          // Disable transition for the duration of the drag so the drawer
          // tracks the finger exactly, with no easing lag.
          el.style.transition = 'none';
        }
        if (last) {
          const fastUp = vy > 0.5 && dyDir < 0;
          const fastDown = vy > 0.5 && dyDir > 0;
          const nextOpen = fastUp
            ? true
            : fastDown
              ? false
              : targetY < closedY / 2;
          el.style.transition = 'transform 0.28s ease';
          el.style.transform = nextOpen ? 'translateY(0)' : `translateY(${closedY}px)`;
          if (nextOpen !== open) setOpen(nextOpen);
        } else {
          el.style.transform = `translateY(${targetY}px)`;
        }
      },
    },
    {
      target: handleRef,
      eventOptions: { passive: false },
      drag: { filterTaps: true, axis: 'y' },
    },
  );

  const drawerOpen = !isMobile || open;

  return (
    <aside ref={drawerRef} className={`controls ${isMobile ? (open ? 'controls--open' : 'controls--closed') : ''}`}>
      <button
        ref={handleRef}
        type="button"
        className="controls__handle"
        aria-expanded={drawerOpen}
        aria-controls="controls-body"
        aria-label={drawerOpen ? 'Collapse options' : 'Expand options'}
        onClick={() => isMobile && setOpen(o => !o)}
      >
        <span className="controls__drag" aria-hidden />
        <span className="controls__handle-label">{drawerOpen ? 'Hide options' : 'Options'}</span>
      </button>

      <div id="controls-body" className="controls__body" aria-hidden={!drawerOpen}>

      <div className="controls__row controls__row--primary">
        <button className="btn btn--primary" onClick={generate} disabled={generating}>
          {generating ? 'Generating…' : 'Generate map'}
        </button>
        <button
          className={`btn btn--secondary ${shareStatus === 'copied' ? 'btn--success' : ''} ${shareStatus === 'failed' ? 'btn--warn' : ''}`}
          onClick={onShare}
          disabled={!map}
          aria-live="polite"
        >
          {shareStatus === 'copied' ? 'Link copied!' : shareStatus === 'failed' ? 'Copy failed' : 'Share'}
        </button>
      </div>

      {fellBack && map && (
        <div className="notice notice--warn">
          Best-effort map after {attempts} attempts — fairness threshold not met. Try regenerating or relaxing variants.
        </div>
      )}
      {map && !fellBack && attempts > 0 && (
        <div className="notice">Solved in {attempts} attempt{attempts === 1 ? '' : 's'}.</div>
      )}
      {map?.variants.challenge.rolledFlavor && (
        <div className="notice">
          Challenge rolled: <strong>{FLAVOR_LABELS[map.variants.challenge.rolledFlavor]}</strong>
          {map.variants.challenge.rolledTarget ? ` (${map.variants.challenge.rolledTarget})` : ''}
        </div>
      )}

      <div className="controls__group">
        <div className="controls__row">
          <label className="toggle">
            <input type="checkbox" checked={showResourceHealth} onChange={toggleShowResourceHealth} />
            Show resource distribution
          </label>
        </div>
        <p className="help">
          Adds a per-resource health readout (pip totals, concentration, healthy/warning/unhealthy dot) plus the simulated snake-draft fairness panel.
        </p>
        {showResourceHealth && scored && <AnalyzePanel />}
      </div>

      <div className="controls__row">
        <span className="controls__label">Players</span>
        <div className="seg" role="radiogroup" aria-label="Player count">
          {PLAYER_COUNTS.map(n => (
            <button
              key={n}
              role="radio"
              aria-checked={playerCount === n}
              className={`seg__btn ${playerCount === n ? 'seg__btn--active' : ''}`}
              onClick={() => setPlayerCount(n)}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      <div className="controls__group">
        <div className="controls__row">
          <label className={`toggle ${playerCount > 4 ? 'toggle--disabled' : ''}`}>
            <input
              type="checkbox"
              checked={playerCount > 4 ? true : variants.includeDesert}
              disabled={playerCount > 4}
              onChange={e => setVariants({ includeDesert: e.target.checked })}
            />
            Include desert
          </label>
          {!variants.includeDesert && playerCount <= 4 && (
            <select
              className="select"
              value={variants.desertReplacement}
              onChange={e => setVariants({ desertReplacement: e.target.value as ProducingResource })}
              aria-label="Desert replacement resource"
            >
              {PRODUCING_RESOURCES.map(r => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          )}
        </div>
        <p className="help">
          {playerCount > 4
            ? '5–6 expansion always uses 2 deserts (the robber starts on one of them) — desert is fixed for these player counts.'
            : variants.includeDesert
              ? 'Standard rules: 1 desert (base game). The robber starts on the desert.'
              : 'Desert is swapped for the chosen resource; the extra hex gets number 4. The robber starts off-board.'}
        </p>
      </div>

      <div className="controls__group">
        <div className="controls__row">
          <label className="toggle">
            <input
              type="checkbox"
              checked={variants.shufflePorts}
              onChange={e => setVariants({ shufflePorts: e.target.checked })}
            />
            Shuffle ports
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={waterFrame}
              onChange={toggleWaterFrame}
            />
            Water frame
          </label>
        </div>
        <p className="help">
          {variants.shufflePorts
            ? 'Port positions are randomized each generation.'
            : 'Ports are placed in the canonical 5th-edition arrangement from the box.'}
          {' '}
          {waterFrame
            ? 'A sea border surrounds the island so ports sit on water. Pure visual — toggles instantly without regenerating.'
            : 'No sea border — ports sit on the page background.'}
        </p>
      </div>

      <div className="controls__group">
        <div className="controls__row">
          <label className="toggle">
            <input
              type="checkbox"
              checked={variants.noSameNumberAdjacent}
              onChange={e => setVariants({ noSameNumberAdjacent: e.target.checked })}
            />
            No same numbers adjacent
          </label>
        </div>
        <p className="help">
          Hexes touching each other can't share a number (e.g. two 9s next to each other). Best-effort — if the constraint can't be satisfied, the generator returns its best attempt.
        </p>
      </div>

      <div className="controls__group">
        <div className="controls__row">
          <label className="toggle">
            <input
              type="checkbox"
              checked={variants.noSameNumberOnResource}
              onChange={e => setVariants({ noSameNumberOnResource: e.target.checked })}
            />
            No same number on same resource
          </label>
        </div>
        <p className="help">
          Prevents two 5s on brick or two 9s on wheat — every resource gets distinct numbers across its tiles. Best-effort.
        </p>
      </div>

      <div className="controls__group">
        <div className="controls__row">
          <label className="toggle">
            <input
              type="checkbox"
              checked={variants.noMultipleRedsOnResource}
              onChange={e => setVariants({ noMultipleRedsOnResource: e.target.checked })}
            />
            Spread reds across resources
          </label>
        </div>
        <p className="help">
          Distributes 6s and 8s evenly so no resource hogs the high-yield numbers (base-game cap = 1 red per resource; 5–6 expansion = 2). Best-effort.
        </p>
      </div>

      <div className="controls__group">
        <div className="controls__row">
          <span className="controls__label">Challenge mode</span>
          <select
            className="select"
            value={variants.challenge.flavor}
            onChange={e => setChallenge(e.target.value as ChallengeFlavor)}
          >
            {(Object.keys(FLAVOR_LABELS) as ChallengeFlavor[]).map(f => (
              <option key={f} value={f}>{FLAVOR_LABELS[f]}</option>
            ))}
          </select>
          {showTargetPicker && (
            <select
              className="select"
              value={variants.challenge.targetResource}
              onChange={e => setChallenge(variants.challenge.flavor, e.target.value as ProducingResource | 'any')}
              aria-label="Target resource"
            >
              <option value="any">Any</option>
              {PRODUCING_RESOURCES.map(r => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          )}
        </div>
        <p className="help">{FLAVOR_HELP[variants.challenge.flavor]}</p>
        <p className="help help--note">
          Snake-draft fairness is always enforced — challenge mode makes the map harsh, not the starting positions.
        </p>
      </div>

      <div className="controls__group">
        <div className="controls__row">
          <label className="toggle">
            <input type="checkbox" checked={showBestLocations} onChange={toggleShowBestLocations} />
            Show best locations
          </label>
        </div>
        <p className="help">
          Overlays the snake-draft picks on the board — top-N intersections with rank rings and spot-value badges. Pure visual; doesn't affect generation.
        </p>
      </div>

      </div>
    </aside>
  );
}

function AnalyzePanel() {
  const scored = useAppStore(s => s.scored)!;
  const fairness = scored.fairness;
  const mean = fairness.playerTotals.reduce((a, b) => a + b, 0) / fairness.playerTotals.length;
  const max = Math.max(...fairness.playerTotals, 1);

  return (
    <>
      <div className="health">
        {scored.health.map(h => {
          // Production share delta vs. expected (tile-count) share.
          // 0 → producing exactly its fair share; ±20% → meaningful skew.
          const shareDelta = h.expectedShare > 0
            ? (h.productionShare / h.expectedShare - 1) * 100
            : 0;
          const deltaSign = shareDelta > 0 ? '+' : '';
          return (
            <div className="health__cell" key={h.resource}>
              <div>
                <span className={`health__dot health__dot--${h.status}`} />
                {h.resource}
              </div>
              <div>{h.totalPips}p</div>
              <div style={{ opacity: 0.7 }} title="concentration on top number">
                {(h.concentration * 100).toFixed(0)}%
              </div>
              <div
                className="health__share"
                title="production share vs expected (tile-count share)"
              >
                {deltaSign}{shareDelta.toFixed(0)}%
              </div>
            </div>
          );
        })}
      </div>

      <div className="pairs">
        <div className="pairs__title">Adjacent resource pairs (obs / exp)</div>
        <div className="pairs__grid">
          {scored.pairs.map(p => (
            <div className={`pairs__cell pairs__cell--${p.status}`} key={`${p.a}-${p.b}`}>
              <span className="pairs__label">{p.a.slice(0, 2)}·{p.b.slice(0, 2)}</span>
              <span className="pairs__count">{p.observed} / {p.expected.toFixed(1)}</span>
            </div>
          ))}
        </div>
      </div>

      {(() => {
        // GATE metric — board-wide structural eligibility, multi-label.
        // The strategic-diversity rejection rule uses these counts at k=5.
        const viable = scored.viableArchetypeCounts;
        const entries: Array<[string, number]> = [
          ['Expansion', viable.expansion],
          ['City Rush', viable.cityRush],
          ['Port Econ', viable.portEconomy],
          ['Dev Cards', viable.devCards],
          ['Balanced', viable.balanced],
        ];
        const K = 5;
        const meetingBar = entries.filter(([, c]) => c >= K).length;
        return (
          <div className="pairs">
            <div className="pairs__title">
              Strategic viability (k=5 bar)
              <span style={{ marginLeft: 8, opacity: 0.7 }}>
                {meetingBar} archetypes meeting
                {meetingBar < 3 ? ' ⚠' : ''}
              </span>
            </div>
            <div className="pairs__grid">
              {entries.map(([label, count]) => (
                <div
                  className={`pairs__cell pairs__cell--${count >= K ? 'normal' : count >= 1 ? 'rare' : 'rare'}`}
                  key={label}
                >
                  <span className="pairs__label">{label}</span>
                  <span className="pairs__count">{count}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {(() => {
        // INFORMATIONAL — top-20 composition by dominant archetype.
        // Distinct from the gate metric above: this shows which archetypes
        // dominate the highest-pip-value spots, while the gate measures
        // structural availability anywhere on the board.
        const mix = scored.archetypeMix;
        const entries: Array<[string, number]> = [
          ['Expansion', mix.expansion],
          ['City Rush', mix.cityRush],
          ['Port Econ', mix.portEconomy],
          ['Dev Cards', mix.devCards],
          ['Balanced', mix.balanced],
        ];
        return (
          <div className="pairs">
            <div className="pairs__title">
              Top-20 archetype composition
            </div>
            <div className="pairs__grid">
              {entries.map(([label, count]) => (
                <div className="pairs__cell pairs__cell--normal" key={label}>
                  <span className="pairs__label">{label}</span>
                  <span className="pairs__count">{count}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {(() => {
        // Port-economy diagnostic surface (distributional, not pass/fail).
        // Shows the top-3 strongest port openings on this map by the
        // multi-dim strength formula. Useful for spotting which ports
        // anchor real trade-economy plays vs which are just adjacent
        // to weak production.
        const top = scored.portEconomyOpenings.slice(0, 3);
        if (top.length === 0) return null;
        return (
          <div className="pairs">
            <div className="pairs__title">Top port-economy openings</div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              {top.map((p, i) => (
                <div key={p.intersectionId} style={{ display: 'flex', gap: 8, marginTop: 2 }}>
                  <span style={{ minWidth: 18, opacity: 0.5 }}>{i + 1}.</span>
                  <span style={{ minWidth: 76 }}>strength <strong>{p.strength.toFixed(2)}</strong></span>
                  <span style={{ minWidth: 70 }}>port {p.portStrength.toFixed(1)}</span>
                  <span style={{ minWidth: 70 }}>prod {p.production.toFixed(1)}</span>
                  <span style={{ minWidth: 84 }}>surplus {p.surplus.toFixed(2)}×</span>
                  <span style={{ opacity: 0.55 }}>rank #{p.rank + 1}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {(() => {
        const specific = scored.ports.filter(p => p.type !== 'generic');
        if (specific.length === 0) return null;
        const max = Math.max(...specific.map(p => p.supportScore), 1);
        const min = Math.min(...specific.map(p => p.supportScore));
        const ratio = scored.specificPortSupportRatio;
        const ratioBad = ratio > 3.0;
        return (
          <div className="pairs">
            <div className="pairs__title">
              Port hinterland support
              <span style={{ marginLeft: 8, opacity: 0.7 }}>
                ratio {isFinite(ratio) ? ratio.toFixed(2) : '∞'}
                {ratioBad ? ' ⚠' : ''}
              </span>
            </div>
            <div className="pairs__grid">
              {specific.map((p, i) => {
                const status = p.supportScore === max
                  ? 'abundant'
                  : p.supportScore === min ? 'rare' : 'normal';
                return (
                  <div className={`pairs__cell pairs__cell--${status}`} key={`port-${i}-${p.type}`}>
                    <span className="pairs__label">{p.type.slice(0, 4)} 2:1</span>
                    <span className="pairs__count">{p.supportScore.toFixed(1)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      <div className="fairness">
        <div className="fairness__row">
          <span>Stdev</span>
          <span>{fairness.stdev.toFixed(2)}</span>
        </div>
        <div className="fairness__row">
          <span>Spread</span>
          <span>{fairness.spread.toFixed(2)}</span>
        </div>
        <div className="fairness__row">
          <span>Mean</span>
          <span>{mean.toFixed(2)}</span>
        </div>
        <div className="fairness__row" title="Min roads from any picked spot to any port, per player">
          <span>Port reach</span>
          <span>
            {scored.playerPortDistance.map((d, i) =>
              `P${i + 1}:${Number.isFinite(d) ? d : '∞'}`,
            ).join(' ')}
          </span>
        </div>
        <div
          className="fairness__row"
          title="Spread between highest- and lowest-producing quadrant relative to its tile share. >1.0 = super-continent territory."
        >
          <span>Pip spread</span>
          <span style={{ color: scored.pipSpatial.spread > 1.0 ? '#c0341d' : undefined }}>
            {scored.pipSpatial.spread.toFixed(2)}
            <span style={{ marginLeft: 6, opacity: 0.6, fontSize: '0.85em' }}>
              ({scored.pipSpatial.quadrantRatios.map(r => r.toFixed(2)).join(' ')})
            </span>
          </span>
        </div>
        <div className="fairness__bars">
          {fairness.playerTotals.map((v, i) => (
            <div key={i} className="fairness__bar" style={{ opacity: 0.4 + 0.6 * (v / max) }}>
              <span className="fairness__bar-label">P{i + 1}: {v.toFixed(1)}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
