/**
 * DEVELOPMENT FIXTURE — not part of the production build (vite builds only
 * index.html). Lets designers/tests see the ambient background with sample
 * cover colours before real projects exist: /dev/ambient-preview.html?c=e63946,2a9d8f
 */
import { createRoot } from 'react-dom/client';
import { AmbientBackground } from '../src/components/Ambient';
import '../src/styles/app.css';

const hexes = (new URLSearchParams(location.search).get('c') ?? '')
  .split(',')
  .filter(Boolean)
  .map((h) => `#${h}`);

createRoot(document.getElementById('root')!).render(
  <>
    <AmbientBackground hexes={hexes} />
    <main className="content">
      <h1>Ambient preview</h1>
      <p className="voice">{hexes.length ? `${hexes.length} sample cover colours` : 'an empty space'}</p>
    </main>
  </>,
);
