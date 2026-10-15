import type {ReactNode} from 'react';
import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import Admonition from '@theme/Admonition';

import styles from './index.module.css';

const entries = [
  {
    title: 'Unity',
    text: 'Install the Unity package and sync your first objects, from the Editor to a Meta Quest.',
    to: '/unity/installation',
  },
  {
    title: 'Web',
    text: 'Add Colibri to a web app with TypeScript and exchange data with Unity clients.',
    to: '/web/installation',
  },
  {
    title: 'Server',
    text: 'Start with the public test server, or run your own with Docker.',
    to: '/server/installation',
  },
];

const areas = [
  {
    title: 'Low barrier',
    text: 'Setup and development are as simple as possible, with little to no configuration or code required.',
  },
  {
    title: 'Multi-platform',
    text: 'Colibri synchronizes data between different platforms, such as Unity and web apps.',
  },
  {
    title: 'Lab conditions',
    text: 'Research prototypes usually run under ideal lab conditions. Colibri puts low latency and high throughput first, at the cost of bandwidth and security.',
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
      <main className="container margin-vert--lg">
        <div className="row">
          {entries.map(entry => (
            <div key={entry.title} className="col col--4 margin-bottom--lg">
              <Link to={entry.to} className={`card padding--lg ${styles.card}`}>
                <Heading as="h2">{entry.title}</Heading>
                <p>{entry.text}</p>
              </Link>
            </div>
          ))}
        </div>
        <div className="row">
          {areas.map(area => (
            <div key={area.title} className="col col--4 margin-bottom--md">
              <Heading as="h3">{area.title}</Heading>
              <p>{area.text}</p>
            </div>
          ))}
        </div>
        <Admonition type="warning" title="No authentication">
          Anyone who can reach a Colibri server can join any app on it and read and change its data. Do not send sensitive
          data through the public test server. For sensitive data, run your own server on a trusted network.
        </Admonition>
      </main>
    </Layout>
  );
}
