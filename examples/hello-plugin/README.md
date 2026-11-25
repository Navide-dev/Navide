# Hello

Hello, a Navide plugin.

> **This folder is the smallest Navide plugin, ready to copy.** It is exactly
> what `navide-plugin init <dir> --id acme.hello` writes (a test keeps the two
> equal), so you can start from it without running anything first. This
> README goes into the package and is shown on your Navide Marketplace
> listing: replace this note with your own text before you publish.

## What is here

```text
hello-plugin/
├── manifest.json          # Manifest v2: id, version, one main view, no permissions
├── frontend/main/index.html
├── frontend/main/main.js  # reports ready with window.nav.ready()
├── README.md              # your listing page
├── artifact-files.json    # the exact files that go into the package
├── package.json           # installs the navide-plugin CLI; never packaged
└── .gitignore             # keeps node_modules, *.key, *.vsix and *.sig out of Git
```

## From a copy to a listing

1. Copy this folder and rename it. In `manifest.json`, change `id` to
   `<your-namespace>.<name>` and `publisher` to your namespace, then set
   `name`, `marketplace.description` and `marketplace.license`.
2. `npm install`: installs the `navide-plugin` CLI from the
   [`plugin-packages`](https://github.com/Navide-dev/Navide/releases?q=plugin-packages)
   GitHub Release named in `package.json`. The packages are not on npm, so
   always run the CLI through `npm run` or `npx` inside this folder.
3. Load it in Navide: Settings → Navide Plugins → turn on Developer Mode →
   Load from Folder… → this folder. Edit and save; it reloads by itself.
4. `npm run check && npm run package`: the validation and static scan review
   runs, then a `.vsix` for the `universal` target.
5. Publish: apply once as a developer, claim your namespace, register a
   signing key (`npx navide-plugin keygen`), then `npx navide-plugin login`,
   `npx navide-plugin sign` and `npx navide-plugin publish`. A person reviews
   the version before it is listed; `npx navide-plugin status` shows where it
   is.

Every command of steps 4 and 5, with what to expect and what to do when it
fails, is in
[Build for Navide → From zero to a listing](../../docs/en-US/build-for-navide.md#from-zero-to-a-listing).
For a buildable Vue view with a backend and an agent tool, run
`navide-plugin init <dir> --id <namespace.name> --template vue` instead.
