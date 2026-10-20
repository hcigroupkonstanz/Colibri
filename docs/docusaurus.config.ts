import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const github = 'https://github.com/hcigroupkonstanz/Colibri';

// The public test server's monitoring page. Decided later; it does not run there yet.
const monitoring = 'http://colibri.hci.uni-konstanz.de:9211';

const config: Config = {
  title: 'Colibri',
  tagline: 'Synchronized objects and data for cross-reality prototypes in research',
  favicon: 'img/favicon.png',

  future: {
    v4: true,
  },

  url: 'https://colibri.hci.uni-konstanz.de',
  baseUrl: '/',

  onBrokenLinks: 'throw',

  markdown: {
    // .md files are plain Markdown, so text such as <server-address> needs no escaping. .mdx is MDX.
    format: 'detect',
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
  },
  themes: ['@docusaurus/theme-mermaid'],

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          // The docs are the site: /unity/..., /web/..., /server/...
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
          editUrl: `${github}/tree/develop/docs/`,
          // Colibri 2 is the current version. Freeze it with `npm run docusaurus docs:version 2.x`
          // before the docs of a later version replace it.
          versions: {
            current: {
              label: '2.x',
            },
          },
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/colibri_header.png',
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'Colibri',
      logo: {
        alt: 'Colibri',
        src: 'img/logo.png',
      },
      items: [
        {
          type: 'dropdown',
          label: 'Clients',
          position: 'left',
          items: [
            {type: 'docSidebar', sidebarId: 'unitySidebar', label: 'Unity'},
            {type: 'docSidebar', sidebarId: 'webSidebar', label: 'Web'},
          ],
        },
        {type: 'docSidebar', sidebarId: 'serverSidebar', label: 'Server', position: 'left'},
        {type: 'docsVersionDropdown', position: 'right'},
        {href: monitoring, label: 'Public Server', position: 'right'},
        {href: github, label: 'GitHub', position: 'right'},
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Clients',
          items: [
            {label: 'Unity', to: '/unity/installation'},
            {label: 'Web', to: '/web/installation'},
          ],
        },
        {
          title: 'Server',
          items: [
            {label: 'Installation', to: '/server/installation'},
            {label: 'Monitoring of the public server', href: monitoring},
          ],
        },
        {
          title: 'More',
          items: [
            {label: 'GitHub', href: github},
            {label: 'Upgrading from Colibri 1', href: `${github}/blob/develop/MIGRATION.md`},
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} HCI Group, University of Konstanz. MIT License.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['csharp', 'bash', 'yaml', 'json'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
