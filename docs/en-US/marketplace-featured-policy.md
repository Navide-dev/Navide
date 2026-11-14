# Navide Marketplace: Featured policy

The Featured flag is how Navide maintainers point users at Navide plugins worth
trying first. It is curation, not a gate: a listing that is not featured
installs, updates and appears in search exactly like one that is, and featuring
grants no permission, review shortcut or trust a listing would not otherwise
have. It is set with the Registry's existing admin endpoint
(`POST /api/extensions/{namespace}/{name}/featured`, `set_featured`), and no
other field or process changes with it.

## Who decides

The Navide maintainers who hold the Registry admin token. A publisher cannot
feature its own listing, and asking for it is done in the open: a
"Show and tell" post in GitHub Discussions that links the listing.

## What can be featured

A listing is eligible when all of these hold for its current version:

- it is listed on Navide Marketplace (not only on Testplace) and not yanked;
- the Registry review is approved and the package is signed;
- the Marketplace scan shows no unresolved finding;
- its disclosure card matches what it does (the reviewer checked it against the
  scan, in line with "disclose, don't restrict" in `plugin-development-v2.md`);
- it had a release or an answered issue in the last 90 days.

Navide's own plugins (`navide.*`) can be featured, but listings from other
publishers come first when there is room: the Featured row exists to show what
the ecosystem builds.

## How many, and how often it changes

- At most six listings are featured at a time.
- The list is reviewed with every Navide release, and at least once a month.
  A listing stays featured for at most three months in a row, then makes room
  for another eligible one if there is one.
- A listing loses the flag at once when it stops being eligible (yanked,
  revoked, a security finding, a disclosure that no longer matches), whatever
  the date.

## Record

Each change is noted in `CHANGELOG.md` under "New on Navide Marketplace" for
the release that ships with it: the listing, its publisher namespace and
whether it was featured or unfeatured. The Registry keeps only the current
flag, so the changelog is the history.
