/**
 * The ambient background. An empty space is near-black with film grain and
 * a faint hand-lettered அ. Each project contributes its cover colour, which
 * is tuned (see @arai/shared ambientPalette) and seeps in as a slowly
 * drifting, ink-edged glow. Removing a project lets its colour fade out.
 *
 * Performance: each glow is its own layer; the expensive SVG filter is
 * rasterised once and only the layer's transform/opacity animate, so the
 * compositor does the motion. Reduced-motion users get a still image.
 */
import { ambientPalette, type Glow } from '@arai/shared';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Mark } from './Logo';

interface AmbientApi {
  /** Cover colours (hex) of the projects currently in view. */
  setSources: (hexes: string[]) => void;
}

const Ctx = createContext<AmbientApi>({ setSources: () => undefined });
export const useAmbient = () => useContext(Ctx);

interface Shown extends Glow {
  key: string;
  leaving: boolean;
}

export function AmbientProvider({ children }: { children: ReactNode }) {
  const [sources, setSources] = useState<string[]>([]);
  const api = useMemo(() => ({ setSources }), []);
  return (
    <Ctx.Provider value={api}>
      <AmbientBackground hexes={sources} />
      {children}
    </Ctx.Provider>
  );
}

export function AmbientBackground({ hexes }: { hexes: string[] }) {
  const target = useMemo(() => ambientPalette(hexes), [hexes]);
  const [shown, setShown] = useState<Shown[]>([]);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    const wanted = new Map(target.map((g) => [`h${g.hue}`, g]));
    setShown((prev) => {
      const next: Shown[] = prev.map((s) => (wanted.has(s.key) ? { ...s, leaving: false } : { ...s, leaving: true }));
      for (const [key, g] of wanted) if (!prev.some((s) => s.key === key)) next.push({ ...g, key, leaving: false });
      return next;
    });
    // Drop faded-out glows after their exit animation.
    const t = window.setTimeout(() => setShown((prev) => prev.filter((s) => !s.leaving)), 3600);
    timers.current.push(t);
  }, [target]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const live = shown.filter((s) => !s.leaving).length;
  return (
    <div className="ambient" aria-hidden="true">
      {live === 0 && <Mark className="ambient-mark" />}
      {shown.map((g, i) => {
        // Golden-angle placement keeps glows spread out however many there are.
        const angle = i * 2.39996;
        const r = shown.length === 1 ? 0 : 16 + (i % 3) * 8;
        const style = {
          left: `${50 + Math.cos(angle) * r}%`,
          top: `${32 + Math.sin(angle) * r * 0.7}%`,
          '--d': `${52 + (g.hue % 5) * 9}s`,
        } as React.CSSProperties;
        return (
          <div key={g.key} className="ambient-glow" data-leaving={g.leaving} style={style}>
            <svg viewBox="0 0 700 500" preserveAspectRatio="none">
              <defs>
                <filter id={`paint-${g.key}`} x="-40%" y="-40%" width="180%" height="180%">
                  <feTurbulence type="fractalNoise" baseFrequency="0.006" numOctaves="3" seed={(g.hue % 97) + 1} />
                  <feDisplacementMap in="SourceGraphic" scale="170" xChannelSelector="R" yChannelSelector="G" />
                  <feGaussianBlur stdDeviation="38" />
                </filter>
              </defs>
              <ellipse cx="350" cy="250" rx="250" ry="150" fill={g.color} opacity={live > 3 ? 0.5 : 0.62} filter={`url(#paint-${g.key})`} />
            </svg>
          </div>
        );
      })}
      <div className="ambient-shade" />
      <svg className="ambient-grain">
        <filter id="ambient-grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#ambient-grain)" />
      </svg>
    </div>
  );
}
