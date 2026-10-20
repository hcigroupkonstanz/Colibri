import type {ReactNode} from 'react';
import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import Admonition from '@theme/Admonition';

import styles from './index.module.css';

// Simple line icons, drawn in the text colour.
const icons = {
  code: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 6l-6 6 6 6M16 6l6 6-6 6" />
    </svg>
  ),
  platforms: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2" y="4" width="13" height="10" rx="1.5" />
      <path d="M6 18h5M8.5 14v4" />
      <rect x="17" y="8" width="5" height="11" rx="1.5" />
    </svg>
  ),
  tools: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2" y="8" width="20" height="13" rx="1.5" />
      <path d="M9 8V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V8M2 13h20M10 13v2h4v-2" />
    </svg>
  ),
  lab: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 2h6M10 2v6.5L4.5 19a2 2 0 0 0 1.8 3h11.4a2 2 0 0 0 1.8-3L14 8.5V2" />
      <path d="M7 15h10" />
    </svg>
  ),
};

const areas = [
  {
    icon: icons.code,
    title: 'Little to no code required',
    text: (
      <>
        Add the <code>SyncTransform</code> component to an object, and it moves on every client. Sending a message
        takes a single line:
      </>
    ),
    code: 'Sync.Send("startRound", 3);',
  },
  {
    icon: icons.platforms,
    title: 'Multi-platform',
    text: (
      <>
        Clients share the same messages, synchronized objects and data, whatever platform they run on. A smartphone
        can show and move what happens in a head-mounted display.
      </>
    ),
  },
  {
    icon: icons.tools,
    title: 'All tools on board',
    text: (
      <>
        Besides messages and synchronized objects, Colibri brings a data store, monitoring in the browser and voice
        chat.
      </>
    ),
  },
  {
    icon: icons.lab,
    title: 'Designed for the lab',
    text: (
      <>
        Research prototypes run under ideal lab conditions. Colibri puts low latency and high throughput first, at
        the cost of bandwidth and security.
      </>
    ),
  },
];

const platforms = [
  {
    title: 'Unity',
    text: 'Install the Unity package and sync your first object.',
    to: '/unity/installation',
  },
  {
    title: 'Web',
    text: 'Add Colibri to your web app in TypeScript. Install it with npm.',
    to: '/web/installation',
  },
];

export default function Home(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout title="Home" description={siteConfig.tagline}>
      <header className={styles.hero}>
        <div className="container">
          <img className={styles.heroImage} src={useBaseUrl('/img/colibri_header.png')} alt="" />
          <Heading as="h1" className={styles.title}>
            {siteConfig.title}
          </Heading>
          <p className={styles.tagline}>{siteConfig.tagline}</p>
        </div>
      </header>

      <main>
        <section className={styles.areas}>
          <div className="container container--fluid">
            <div className={styles.areaGrid}>
              {areas.map(area => (
                <div key={area.title}>
                  <div className={styles.area}>
                    <div className={styles.icon}>{area.icon}</div>
                    <Heading as="h2" className={styles.areaTitle}>
                      {area.title}
                    </Heading>
                    <p>{area.text}</p>
                    {area.code && <code className={styles.snippet}>{area.code}</code>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="container margin-vert--xl">
          <Heading as="h2" className={styles.sectionTitle}>
            Available for
          </Heading>
          <div className="row">
            {platforms.map(platform => (
              <div key={platform.title} className="col col--4 margin-bottom--lg">
                <Link to={platform.to} className={styles.card}>
                  <Heading as="h3">{platform.title}</Heading>
                  <p>{platform.text}</p>
                  <span className={styles.cardLink}>Get started →</span>
                </Link>
              </div>
            ))}
            <div className="col col--4 margin-bottom--lg">
              <div className={`${styles.card} ${styles.cardMuted}`}>
                <Heading as="h3">More to follow</Heading>
                <p>Colibri is built so that further platforms can join the same apps.</p>
              </div>
            </div>
          </div>
          <p className={styles.server}>
            All clients connect through a Colibri server. Start with the public test server, or{' '}
            <Link to="/server/installation">run your own</Link>.
          </p>
          <Admonition type="warning" title="No authentication">
            Anyone who can reach a Colibri server can join any app on it and read and change its data. Do not send
            sensitive data through the public test server. For sensitive data, run your own server on a trusted
            network.
          </Admonition>
        </section>
      </main>
    </Layout>
  );
}
