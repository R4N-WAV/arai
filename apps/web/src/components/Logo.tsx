import { Link } from 'react-router';
import { MARK, WORDMARK } from './logoPaths';

/** அறை, hand-lettered (outlined from Kavivanar, SIL OFL). Read aloud as "Arai". */
export function Wordmark({ className = 'wordmark', label = 'Arai' }: { className?: string; label?: string | null }) {
  return (
    <svg className={className} viewBox={WORDMARK.viewBox} role={label ? 'img' : undefined} aria-label={label ?? undefined} aria-hidden={label ? undefined : true}>
      <path transform={WORDMARK.tilt} d={WORDMARK.d} />
    </svg>
  );
}

/** The square mark: அ alone. */
export function Mark({ className = 'mark' }: { className?: string }) {
  return (
    <svg className={className} viewBox={MARK.viewBox} aria-hidden="true">
      <path transform={MARK.tilt} d={MARK.d} />
    </svg>
  );
}

export function HomeLink() {
  return (
    <Link className="home-link" to="/" aria-label="Arai, home">
      <Wordmark label={null} />
    </Link>
  );
}
