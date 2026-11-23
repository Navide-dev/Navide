# Navide Marketplace layout: website and app

The Navide Marketplace has two faces: the public website
(`marketplace/registry/registry/web_templates/`, server-rendered Jinja, no
JavaScript) and the in-app page in Settings
(`src/renderer/src/components/MarketplacePane.vue`). They share no code. They
share this layout instead, so a Navide plugin reads the same in both places.
Change either side together with this file.

## Detail page

Header, then a risk banner, then a main column beside a sidebar.

| Block | Website | App |
|---|---|---|
| Header | Icon, name, publisher, verified domain, version, signature, Navide minimum, downloads, rating, category and platform chips | Same; platforms and the Navide minimum sit in the "Works with" card |
| Risk banner | Each sensitive capability with a plain-language hint | Same hints (`settings.extensions.marketplace.capabilityHint.*`) |
| Main: screenshots | Image assets of the latest version except the icon | Same (`screenshots` in the detail API), loaded through `plugins:marketplaceIcon` with `kind: 'screenshot'` |
| Main: README | Rendered markdown | Rendered as text nodes |
| Main: versions | Version (with yanked), channel, target, trust, capabilities, downloads, published | Same columns; Status only when a row needs it |
| Main: changelog | — | Folded at the end, fetched when opened |
| Sidebar: Install | Deep link `navide://extension/<id>` and direct downloads | Every action: install, update, uninstall, rollback, Disable/Enable |
| Sidebar: rating | Rate and report (Navide Cloud sign-in) | Average, with links to rate and report on the website |

Actions that change what is installed exist only in the app. The website's
Install button only opens the app's detail page.

Plain-language hints live in two places that must agree:
`_CAPABILITY_HINTS` in `marketplace/registry/registry/web.py` and the app's
locale files.

## List page

Introduction (only while nothing is filtered), category chips, featured
shelf, then cards: icon, name, signature, publisher and version, description,
category and platform chips, risk summary, downloads and rating. The footer
links to removed plugins, the developer guide, discussions and the security
policy.

## Design tokens

The app page uses the app's semantic tokens
(`packages/plugin-ui/src/foundation/styles/tokens/`), so it follows the
Appearance setting. The website keeps its own stylesheet
(`web_static/style.css`) with matching roles:

| Role | Website | App |
|---|---|---|
| Page, text | `--bg`, `--text`, `--text-muted` | `--bg-base`, `--text-primary`, `--text-secondary` |
| Cards | `--surface`, `--border` | `--bg-subtle`, `--border-muted`, `--radius-md` |
| Primary action, links | `--accent` | `--accent-emphasis`, `--accent-fg` |
| Signed, verified, installed | `--success-*` | `--success-*` (`mkt-badge--ok`, `mkt-quiet--ok`) |
| Sensitive capabilities | `--risk-*` | `--risk-*` |
| Yanked, remove | `--danger-*` | `--danger-*`, `--risk-*` badge |

Icon tiles are the one fixed colour: both sides hash the id into the same 24
hues (`MarketplaceIcon.vue`, `tile_hue` in `web.py`).

## Checking the app page

Dev web mode answers the Marketplace calls with sample data
(`src/renderer/src/devWeb/marketplaceFixtures.ts`, dev only), so the page can
be shot as described in [ui-verification.md](ui-verification.md).
