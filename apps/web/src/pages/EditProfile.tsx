import { IMAGE_LIMITS, linkService, type ProfileDto } from '@arai/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Field } from '../components/Field';
import { Avatar, imageUrl } from '../components/ProfileView';
import { Notice } from '../components/Unavailable';
import { api, errorMessage } from '../lib/api';
import { prepareImage, uploadImage } from '../lib/images';

const IMAGE_ERRORS: Record<string, string> = {
  unsupported_image: 'That file is not an image this browser can read.',
  image_too_large: 'That image is too large even after compressing. Try a smaller one.',
  image_dimensions: 'That image is too large in pixels.',
};

export function EditProfile() {
  const nav = useNavigate();
  const [profile, setProfile] = useState<ProfileDto | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [location, setLocation] = useState('');
  const [links, setLinks] = useState<{ url: string; label: string }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const avatarInput = useRef<HTMLInputElement>(null);
  const bannerInput = useRef<HTMLInputElement>(null);

  const apply = (p: ProfileDto) => {
    setProfile(p);
    setDisplayName(p.displayName);
    setBio(p.bio);
    setLocation(p.location);
    setLinks(p.links);
  };

  useEffect(() => {
    api<{ profile: ProfileDto }>('GET', '/account/profile').then((r) => apply(r.profile)).catch((e) => setError(errorMessage(e)));
  }, []);

  async function image(kind: 'avatar' | 'banner', file: File | undefined) {
    if (!file) return;
    setBusy(kind);
    setError(null);
    try {
      const box = kind === 'avatar' ? { w: IMAGE_LIMITS.avatar.px, h: IMAGE_LIMITS.avatar.px } : { w: IMAGE_LIMITS.banner.px, h: 600 };
      await uploadImage(kind, await prepareImage(file, box, IMAGE_LIMITS[kind].bytes));
      // Refresh only the pictures: never discard text the user has typed but not saved.
      const fresh = (await api<{ profile: ProfileDto }>('GET', '/account/profile')).profile;
      setProfile((p) => (p ? { ...p, avatar: fresh.avatar, banner: fresh.banner } : fresh));
      setStatus(kind === 'avatar' ? 'Profile picture updated.' : 'Header updated.');
    } catch (e) {
      setError(IMAGE_ERRORS[(e as Error).message] ?? errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function removeImage(kind: 'avatar' | 'banner') {
    const fresh = (await api<{ profile: ProfileDto }>('DELETE', `/account/profile/${kind}`)).profile;
    setProfile((p) => (p ? { ...p, avatar: fresh.avatar, banner: fresh.banner } : fresh));
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy('save');
    setError(null);
    try {
      const clean = links.filter((l) => l.url.trim()).map((l) => ({ url: l.url.trim(), label: l.label.trim() }));
      const bad = clean.find((l) => {
        try {
          return new URL(l.url).protocol !== 'https:';
        } catch {
          return true;
        }
      });
      if (bad) {
        setError(`Check your links: each must be a full https:// address (“${bad.url.slice(0, 60)}” is not).`);
        return;
      }
      const r = await api<{ profile: ProfileDto }>('PUT', '/account/profile', { displayName, bio, location, links: clean });
      apply(r.profile);
      nav(`/u/${r.profile.username}`);
    } catch (err) {
      setError(errorMessage(err) === 'Some details are not valid. Check the form and try again.' ? 'Check your links: each must be a full https:// address.' : errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  if (!profile) return error ? <Notice kind="error">{error}</Notice> : <p className="muted" role="status">Loading…</p>;
  return (
    <>
      <header className="page-header">
        <h1>Edit profile</h1>
        <span className="voice">everything here is public</span>
      </header>
      {error && <Notice kind="error">{error}</Notice>}
      {status && <Notice kind="ok">{status}</Notice>}

      <section className="section" aria-labelledby="img-h">
        <h2 id="img-h">Pictures</h2>
        <div className={profile.banner ? 'profile-banner' : 'profile-banner profile-banner-empty'}>
          {profile.banner && <img src={imageUrl(profile, 'banner', profile.banner)} alt="Your header" />}
        </div>
        <div className="form-actions" style={{ margin: 'var(--s-3) 0 var(--s-6)' }}>
          <button type="button" className="btn btn-sm" disabled={busy === 'banner'} onClick={() => bannerInput.current?.click()}>
            {busy === 'banner' ? 'Uploading…' : profile.banner ? 'Change header' : 'Add header'}
          </button>
          {profile.banner && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void removeImage('banner')}>Remove header</button>}
          <span className="row-sub">Wide image, cropped to 3:1.</span>
        </div>
        <div className="form-actions">
          <Avatar profile={profile} size={88} />
          <button type="button" className="btn btn-sm" disabled={busy === 'avatar'} onClick={() => avatarInput.current?.click()}>
            {busy === 'avatar' ? 'Uploading…' : profile.avatar ? 'Change picture' : 'Add profile picture'}
          </button>
          {profile.avatar && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void removeImage('avatar')}>Remove picture</button>}
        </div>
        <input ref={avatarInput} type="file" accept="image/*" hidden onChange={(e) => (void image('avatar', e.target.files?.[0]), (e.target.value = ''))} />
        <input ref={bannerInput} type="file" accept="image/*" hidden onChange={(e) => (void image('banner', e.target.files?.[0]), (e.target.value = ''))} />
        <p className="row-sub" style={{ marginTop: 'var(--s-3)' }}>Pictures are resized in your browser and hidden data such as location is removed before upload.</p>
      </section>

      <form onSubmit={save} className="project-form" noValidate>
        <Field label="Display name" value={displayName} maxLength={60} onChange={(e) => setDisplayName(e.target.value)} hint="Optional. Shown above your @username." />
        <div className="field">
          <label htmlFor="bio">Bio</label>
          <textarea id="bio" className="input textarea" rows={4} maxLength={600} value={bio} onChange={(e) => setBio(e.target.value)} />
        </div>
        <Field label="Location" value={location} maxLength={80} onChange={(e) => setLocation(e.target.value)} hint="Optional." />
        <fieldset className="field fieldset">
          <legend>Links</legend>
          <p className="hint">Spotify, SoundCloud, YouTube, your website… Full https:// addresses, up to 8.</p>
          {links.map((l, i) => (
            <div key={i} className="link-row">
              <Field label={`Link ${i + 1}${l.url ? ` (${linkService(l.url)})` : ''}`} value={l.url} type="url" inputMode="url" placeholder="https://" onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} />
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLinks(links.filter((_, j) => j !== i))}>
                Remove<span className="visually-hidden"> link {i + 1}</span>
              </button>
            </div>
          ))}
          {links.length < 8 && <button type="button" className="btn btn-sm" onClick={() => setLinks([...links, { url: '', label: '' }])}>Add link</button>}
        </fieldset>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy === 'save'}>{busy === 'save' ? 'Saving…' : 'Save profile'}</button>
          <button type="button" className="btn btn-ghost" onClick={() => nav(`/u/${profile.username}`)}>Cancel</button>
        </div>
      </form>
    </>
  );
}
