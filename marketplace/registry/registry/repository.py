"""Repository abstraction over the SQLModel session.

Keeps all query/mutation logic in one place so the storage engine and query
strategy can evolve without touching the API layer.
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable
from datetime import datetime, timezone

from sqlmodel import Session, select

from .models import (
    BlocklistEntry,
    Extension,
    ExtensionAsset,
    ExtensionVersion,
    Publisher,
)
from .qualification import record_key
from .versions import TESTPLACE_CHANNEL, version_channel

APPROVED = "approved"
"""Only approved versions are public (review.py owns the state machine)."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def hash_token(token: str) -> str:
    """Stable sha256 hash of a bearer token (we never store it in the clear)."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class RegistryRepository:
    def __init__(self, session: Session) -> None:
        self.session = session

    # -- publishers -----------------------------------------------------
    def get_or_create_publisher(
        self, name: str, display_name: str | None = None
    ) -> Publisher:
        publisher = self.session.exec(
            select(Publisher).where(Publisher.name == name)
        ).first()
        if publisher is None:
            publisher = Publisher(name=name, display_name=display_name)
            self.session.add(publisher)
            self.session.commit()
            self.session.refresh(publisher)
        return publisher

    def get_publisher_by_token(self, token: str) -> Publisher | None:
        return self.session.exec(
            select(Publisher).where(Publisher.token_hash == hash_token(token))
        ).first()

    def register_publisher(
        self,
        *,
        name: str,
        public_key: str | None = None,
        token: str | None = None,
        display_name: str | None = None,
    ) -> Publisher:
        """Create or update a publisher's registered key / bearer token."""
        publisher = self.session.exec(
            select(Publisher).where(Publisher.name == name)
        ).first()
        if publisher is None:
            publisher = Publisher(name=name)
        if display_name is not None:
            publisher.display_name = display_name
        if public_key is not None:
            publisher.public_key = public_key
            self.session.add(publisher)
            self.session.flush()
            try:
                record_key(self.session, publisher, public_key)
            except Exception:  # noqa: BLE001 - an unparsable key keeps no history (as before)
                pass
        if token is not None:
            publisher.token_hash = hash_token(token)
        self.session.add(publisher)
        self.session.commit()
        self.session.refresh(publisher)
        return publisher

    # -- public visibility ----------------------------------------------
    def _hidden(self) -> tuple[set[str], set[str]]:
        """Namespaces and package ids removed through the admin blocklist."""
        entries = self.session.exec(select(BlocklistEntry)).all()
        return (
            {e.value for e in entries if e.kind == "publisher"},
            {e.value for e in entries if e.kind == "package"},
        )

    def _public_filter(self):
        """Predicate for extensions public reads may show: at least one
        approved non-testplace version, and not removed through the blocklist."""
        approved = set(
            self.session.exec(
                select(ExtensionVersion.extension_id).where(
                    ExtensionVersion.review_status == APPROVED,
                    ExtensionVersion.channel != TESTPLACE_CHANNEL,
                )
            ).all()
        )
        publishers, packages = self._hidden()
        return lambda e: (
            e.id in approved
            and e.namespace not in publishers
            and e.identity not in packages
        )

    # -- extensions -----------------------------------------------------
    def get_extension(
        self, namespace: str, name: str, *, public_only: bool = True
    ) -> Extension | None:
        """`public_only` (the default for every read path) hides extensions
        with no approved version and removed ones; publish and yank look up
        the stored row regardless."""
        extension = self.session.exec(
            select(Extension).where(
                Extension.namespace == namespace, Extension.name == name
            )
        ).first()
        if extension is not None and public_only and not self._public_filter()(extension):
            return None
        return extension

    def get_or_create_extension(
        self,
        *,
        publisher: Publisher,
        namespace: str,
        name: str,
        display_name: str | None,
        description: str | None,
        categories: list[str],
        update_existing: bool = True,
    ) -> Extension:
        """`update_existing=False` keeps a public listing unchanged by a
        submission still under review; approval updates it (review.py)."""
        extension = self.get_extension(namespace, name, public_only=False)
        if extension is None:
            extension = Extension(
                publisher_id=publisher.id,
                namespace=namespace,
                name=name,
                identity=f"{namespace}.{name}",
                display_name=display_name,
                description=description,
                categories=categories,
            )
            self.session.add(extension)
            self.session.commit()
            self.session.refresh(extension)
        elif update_existing:
            # Keep discovery metadata in sync with the newest publish.
            extension.display_name = display_name
            extension.description = description
            extension.categories = categories
            extension.updated_at = _now()
            self.session.add(extension)
            self.session.commit()
            self.session.refresh(extension)
        return extension

    def search_extensions(
        self,
        *,
        query: str | None = None,
        category: str | None = None,
        sort: str = "updated",
        offset: int = 0,
        limit: int = 20,
        keep: Callable[[Extension], bool] | None = None,
    ) -> tuple[list[Extension], int]:
        """Keyword search over name/description/categories with filter + sort.

        - `query`: substring match over name/displayName/description/categories.
        - `category`: keep only extensions carrying this category.
        - `sort`: one of `updated` (newest first, default), `downloads`,
          `rating` (average, then count as tiebreak).
        - `keep`: an extra caller-side filter applied before paging.

        Returns (page, total_matches).
        """
        public = self._public_filter()
        rows = [e for e in self.session.exec(select(Extension)).all() if public(e)]
        if query:
            needle = query.lower()
            rows = [e for e in rows if _matches(e, needle)]
        if category:
            wanted = category.lower()
            rows = [e for e in rows if wanted in [c.lower() for c in e.categories]]
        if keep is not None:
            rows = [e for e in rows if keep(e)]
        rows.sort(key=_sort_key(sort))
        total = len(rows)
        return rows[offset : offset + limit], total

    def list_featured(self, *, limit: int = 12) -> list[Extension]:
        """Featured (curated) extensions, most downloaded first."""
        public = self._public_filter()
        rows = [
            e
            for e in self.session.exec(
                select(Extension).where(Extension.featured == True)  # noqa: E712
            ).all()
            if public(e)
        ]
        rows.sort(key=_sort_key("downloads"))
        return rows[:limit]

    def set_featured(self, extension: Extension, featured: bool) -> Extension:
        extension.featured = featured
        self.session.add(extension)
        self.session.commit()
        self.session.refresh(extension)
        return extension

    def all_categories(self) -> list[str]:
        """Distinct categories across all extensions, alphabetically."""
        seen: set[str] = set()
        public = self._public_filter()
        for e in self.session.exec(select(Extension)).all():
            if public(e):
                seen.update(e.categories)
        return sorted(seen)

    # -- downloads -------------------------------------------
    def increment_download(
        self, extension: Extension, version_row: ExtensionVersion
    ) -> None:
        """Bump the per-version and aggregate per-extension download counts."""
        version_row.download_count += 1
        extension.download_count += 1
        self.session.add(version_row)
        self.session.add(extension)
        self.session.commit()

    # -- versions -------------------------------------------------------
    def get_version(
        self, extension_id: int, version: str, target: str | None = None
    ) -> ExtensionVersion | None:
        """One artifact of a version: the given target's, or (target None) the
        first by target name, which suits target-independent reads such as the
        manifest, README and assets."""
        artifacts = self.list_version_artifacts(extension_id, version)
        if target is None:
            return artifacts[0] if artifacts else None
        return next((row for row in artifacts if row.target == target), None)

    def list_version_artifacts(
        self, extension_id: int, version: str, *, public_only: bool = True
    ) -> list[ExtensionVersion]:
        """Every target's artifact of one version, ordered by target; only
        approved non-testplace ones unless `public_only` is False (publish
        conflicts, yank)."""
        statement = select(ExtensionVersion).where(
            ExtensionVersion.extension_id == extension_id,
            ExtensionVersion.version == version,
        )
        if public_only:
            statement = statement.where(
                ExtensionVersion.review_status == APPROVED,
                ExtensionVersion.channel != TESTPLACE_CHANNEL,
            )
        return list(
            self.session.exec(statement.order_by(ExtensionVersion.target)).all()
        )

    def list_versions(
        self, extension_id: int, *, public_only: bool = True
    ) -> list[ExtensionVersion]:
        statement = select(ExtensionVersion).where(
            ExtensionVersion.extension_id == extension_id
        )
        if public_only:
            statement = statement.where(
                ExtensionVersion.review_status == APPROVED,
                ExtensionVersion.channel != TESTPLACE_CHANNEL,
            )
        return list(self.session.exec(statement).all())

    def add_version(
        self,
        *,
        extension: Extension,
        version: str,
        manifest: dict,
        package_digest: str,
        package_key: str,
        signature: str | None,
        target: str,
        registry_envelope: dict,
        registry_signature: str | None,
        trust_tier: str,
        assets: list[tuple[str, int, str]],
        review_status: str = APPROVED,
        review_report: dict | None = None,
        disclosure: dict | None = None,
        disclosure_envelope: dict | None = None,
        disclosure_signature: str | None = None,
        scan: dict | None = None,
    ) -> ExtensionVersion:
        record = ExtensionVersion(
            extension_id=extension.id,
            version=version,
            manifest=manifest,
            package_digest=package_digest,
            package_key=package_key,
            signature=signature,
            target=target,
            registry_envelope=registry_envelope,
            registry_signature=registry_signature,
            trust_tier=trust_tier,
            channel=version_channel(version),
            review_status=review_status,
            review_report=review_report or {},
            disclosure=disclosure,
            disclosure_envelope=disclosure_envelope,
            disclosure_signature=disclosure_signature,
            scan=scan,
        )
        self.session.add(record)
        self.session.commit()
        self.session.refresh(record)
        for path, size, content_type in assets:
            self.session.add(
                ExtensionAsset(
                    version_id=record.id,
                    path=path,
                    size=size,
                    content_type=content_type,
                )
            )
        self.session.commit()
        self.session.refresh(record)
        return record

    def yank_version(self, artifacts: list[ExtensionVersion]) -> None:
        """Yank a version: every target's artifact of it, in one commit."""
        for row in artifacts:
            row.yanked = True
            self.session.add(row)
        self.session.commit()

    def list_assets(self, version_id: int) -> list[ExtensionAsset]:
        return list(
            self.session.exec(
                select(ExtensionAsset).where(
                    ExtensionAsset.version_id == version_id
                )
            ).all()
        )


def rating_average(extension: Extension) -> float:
    """Mean rating rounded to 2dp, or 0.0 when there are no ratings."""
    if extension.rating_count == 0:
        return 0.0
    return round(extension.rating_sum / extension.rating_count, 2)


def _sort_key(sort: str):
    """Sort key (with reverse baked in) for the search result ordering."""
    if sort == "downloads":
        return lambda e: (-e.download_count, e.name)
    if sort == "rating":
        return lambda e: (-rating_average(e), -e.rating_count, e.name)
    # Default: newest-updated first.
    return lambda e: (_neg_time(e.updated_at), e.name)


def _neg_time(value: datetime) -> float:
    return -value.timestamp()


def _matches(extension: Extension, needle: str) -> bool:
    haystack = " ".join(
        [
            extension.name.lower(),
            (extension.display_name or "").lower(),
            (extension.description or "").lower(),
            " ".join(extension.categories).lower(),
        ]
    )
    return needle in haystack
