/** Plain-language privacy and help pages (public, no account needed). */
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { HomeLink } from '../components/Logo';
import { SHORTCUTS } from '../components/Shortcuts';

function Page({ title, aside, children }: { title: string; aside: string; children: ReactNode }) {
  return (
    <div className="public-page">
      <header className="public-bar">
        <HomeLink />
        <nav className="form-actions" aria-label="Information">
          <Link to="/help" className="btn btn-ghost btn-sm">Help</Link>
          <Link to="/privacy" className="btn btn-ghost btn-sm">Privacy</Link>
        </nav>
      </header>
      <main id="main" className="content info-page">
        <header className="page-header">
          <h1>{title}</h1>
          <span className="voice">{aside}</span>
        </header>
        {children}
      </main>
    </div>
  );
}

export function PrivacyPage() {
  return (
    <Page title="Privacy" aside="in plain words">
      <section className="section">
        <h2>What only you (and the people you share with) can read</h2>
        <p>Your private projects are encrypted in your browser before anything is uploaded, with keys that Arai never has. That covers project names and details, track titles, every audio file and version, artwork, comments, messages and their attachments, your pins and folders. Arai stores them, but cannot open them. Neither could anyone who broke into Arai’s servers.</p>
        <p>Your password never leaves your device. If you forget it, your recovery key is the only way back in. That is the price of nobody else holding a key.</p>
      </section>
      <section className="section">
        <h2>What Arai can see</h2>
        <ul className="info-list">
          <li>Your username, email address, profile (name, bio, links, pictures) and anything you make public.</li>
          <li>Who is in which project or conversation, roles, and when things happen (uploads, messages, sign-ins).</li>
          <li>Sizes of files, how many times a track was played per day (no listener names), message reactions and read times.</li>
          <li>A scrambled form of your IP address, kept briefly to stop abuse.</li>
        </ul>
      </section>
      <section className="section">
        <h2>When something is not end-to-end encrypted</h2>
        <ul className="info-list">
          <li><strong>Public projects</strong>: making a project public publishes its details, artwork and the current version of each track so anyone can listen. Older versions, comments and chats stay encrypted. Making it private again removes the public copy.</li>
          <li><strong>Share links</strong>: whoever has the full link (and the password, if you set one) can listen. The key is the part after the #, which never reaches Arai.</li>
          <li><strong>Reports</strong>: if you report a message, you can choose to include its text so a moderator can read it. Nothing else is ever visible to moderators.</li>
        </ul>
      </section>
      <section className="section">
        <h2>Your devices</h2>
        <p>Arai keeps you signed in until you sign out. Your keys are stored on the device in a form that only works together with a secret kept for that sign-in, so signing out (or signing a device out from Settings) locks it for good. Notifications, if you turn them on, only wake your device; it then asks Arai what happened over its own connection, so no message content passes through Apple or Google.</p>
      </section>
      <section className="section">
        <h2>Your control</h2>
        <p>You can download everything readable to you (Settings → Download my data) and delete your account at any time (Settings → Delete account). Deleting removes your profile, the projects you own, and erases your messages and comments.</p>
        <p>No advertising, no trackers, no selling of data. Arai runs on Cloudflare, which processes traffic to deliver the service.</p>
      </section>
    </Page>
  );
}

export function HelpPage() {
  return (
    <Page title="Help" aside="quick answers">
      <section className="section">
        <h2>Getting started</h2>
        <dl className="faq">
          <dt>How do I add music?</dt>
          <dd>Create a project, then drop audio files on it (WAV, AIFF, FLAC, MP3, M4A, OGG). Or use Import to bring a whole library from another platform: folders become projects and versions are grouped by name.</dd>
          <dt>How do versions work?</dt>
          <dd>Open a track’s menu and choose “Upload new version”. Every version is kept; you choose which one is current. “Compare versions” plays two in sync so you can switch with A and B.</dd>
          <dt>How do I work with others?</dt>
          <dd>On a project, open People and invite by username as a listener, editor or admin. They see the invitation in their library. Leave notes at an exact moment from a track’s comments.</dd>
          <dt>How do I share with someone who has no account?</dt>
          <dd>Use Share on a project to create a link, optionally with a password and an expiry date. You can turn a link off at any time.</dd>
        </dl>
      </section>
      <section className="section">
        <h2>Your account</h2>
        <dl className="faq">
          <dt>I forgot my password.</dt>
          <dd>Use “Forgot your password?” on the sign-in page with your recovery key. Without the recovery key, the account cannot be opened. Not even Arai can help, because Arai never has your keys.</dd>
          <dt>Can I use Arai like an app?</dt>
          <dd>Yes. On iPhone, open Arai in Safari, tap Share and “Add to Home Screen”. On Android or desktop, use the install option in the browser’s menu.</dd>
          <dt>Can I listen offline?</dt>
          <dd>Choose “Keep offline” in a track’s menu. It is stored encrypted on that device and plays without a connection.</dd>
        </dl>
      </section>
      <section className="section">
        <h2>Keyboard shortcuts</h2>
        <dl className="shortcut-list">
          {SHORTCUTS.map(([keys, what]) => (
            <div key={keys}>
              <dt>{keys.split(' ').map((k) => <kbd key={k}>{k}</kbd>)}</dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
        <p className="muted">Press <kbd>?</kbd> anywhere in Arai to see these.</p>
      </section>
      <p><Link to="/privacy">Read how your privacy works →</Link></p>
    </Page>
  );
}
