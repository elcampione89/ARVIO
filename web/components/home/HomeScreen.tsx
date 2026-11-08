"use client";
import { collectionFolders, collectionHomeCatalogs } from "@/lib/collectionPresentation";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createHeroController } from "@/lib/homeHero";
import { HOME_WATCHLIST_ROW_ID, withHomeWatchlistRow } from "@/lib/homeRows";
import { requestPlayOnOpen } from "@/lib/playIntent";
import { useAppPick } from "@/lib/store";
import { useKidsFilter } from "@/lib/useKids";
import { LazyRail } from "@/components/media/LazyRail";
import { CustomCollectionRail } from "@/components/media/CustomCollectionRail";
import { MediaRail } from "@/components/media/MediaRail";
import { CategoryViewAll } from "@/components/media/CategoryViewAll";
import { FavoriteTvRail } from "@/components/media/FavoriteTvRail";
import { FAVORITE_TV_CATALOG_ID } from "@/lib/favoriteTv";
import { HOME_ROW_LIMIT } from "@/lib/tmdb";
import type { CatalogConfig, Category, MediaItem } from "@/lib/types";
import { RowBoundary } from "@/components/shell/ErrorBoundary";
import { HomeHero } from "./HomeHero";
import "@/app/home.css";

type ViewAll = { catalog: CatalogConfig | null; category: Category };

export function HomeScreen({ onCollectionOpenChange }: { onCollectionOpenChange?: (open: boolean) => void }) {
  const { categories, catalogConfigs, homeServerRows, continueWatching, watchlist, openDetails, settings } = useAppPick("categories", "catalogConfigs", "homeServerRows", "continueWatching", "watchlist", "openDetails", "settings");
  const posterMode = settings.cardLayoutMode === "poster";
  const kids = useKidsFilter();
  const kidsAllows = useRef(kids.allows);
  kidsAllows.current = kids.allows;

  // The billboard's state lives here, outside the app store: only HomeHero
  // subscribes, so its 8 s rotation and card hovers don't re-render the app.
  const [hero] = useState(() => createHeroController());
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); }, []);

  // The eager rails (trending/popular/provider lists) overlap heavily; keep each
  // title in the first rail it appears in and trim repeats from later rails,
  // unless doing so would hollow a rail out.
  const dedupedCategories = useMemo(() => {
    const seen = new Set<string>();
    return withHomeWatchlistRow(categories, watchlist, settings.watchlistOnHome === true).map((category) => {
      if (category.id === HOME_WATCHLIST_ROW_ID) return category;
      const kept = category.items.filter((item) => !seen.has(`${item.mediaType}-${item.id}`));
      const items = kept.length >= Math.min(8, category.items.length) ? kept : category.items;
      items.forEach((item) => seen.add(`${item.mediaType}-${item.id}`));
      return items === category.items ? category : { ...category, items };
    });
  }, [categories, watchlist, settings.watchlistOnHome]);

  // Stable callbacks: MediaCard is memoised on them.
  const onCardFocus = useCallback((item: MediaItem) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => hero.pin(item), 220);
  }, [hero]);
  const seedHeroFromRow = useCallback((row: Category) => hero.addToPool(row.items, (item) => kidsAllows.current(item)), [hero]);
  const playFromHero = useCallback((item: MediaItem) => {
    // Android billboard Play: open the title with play intent; details starts
    // playback through its automatic source choice (see DetailsView).
    if (item.id > 0) requestPlayOnOpen(item);
    void openDetails(item);
  }, [openDetails]);

  const [viewAll, setViewAll] = useState<ViewAll | null>(null);
  useEffect(() => {
    if (!viewAll) return undefined;
    // Keeps Home (and so this page) mounted while a title's details are open.
    onCollectionOpenChange?.(true);
    return () => onCollectionOpenChange?.(false);
  }, [viewAll, onCollectionOpenChange]);
  const openViewAll = useCallback((catalog: CatalogConfig | null, category: Category) => setViewAll({ catalog, category }), []);

  const fallbackHero = continueWatching[0] ?? categories[0]?.items[0] ?? null;

  return (
    // has-hero mirrors the CSS :has(.hero) padding rule for TV browsers whose
    // engines predate :has() support (Tizen/webOS).
    <div className="screen has-hero home-screen">
      <HomeHero controller={hero} fallback={fallbackHero && kids.allows(fallbackHero) ? fallbackHero : null}
        onOpen={openDetails} onPlay={playFromHero} />
      {dedupedCategories.map((category) => {
        // Presentation rows (Continue Watching, Watchlist) are complete lists;
        // they show the first HOME_ROW_LIMIT titles and open the rest in the grid.
        const capped = category.items.length > HOME_ROW_LIMIT;
        const shown = capped ? { ...category, items: category.items.slice(0, HOME_ROW_LIMIT) } : category;
        return <RowBoundary key={category.id} name={category.id} resetKey={category.items}>
          <MediaRail category={shown} onOpen={openDetails} onFocus={onCardFocus} posterMode={posterMode}
            onViewAll={capped ? () => openViewAll(null, category) : undefined} />
        </RowBoundary>;
      })}
      {/* Each row is isolated: one that throws drops out instead of taking Home down. */}
      {collectionHomeCatalogs(catalogConfigs).map((catalog, index) => <RowBoundary key={catalog.id} name={catalog.id} resetKey={catalog}>{
        catalog.id === FAVORITE_TV_CATALOG_ID ? (kids.active ? null : <FavoriteTvRail title={catalog.name} />) :
        String(catalog.kind).toUpperCase() === "COLLECTION_RAIL" ?
        <CustomCollectionRail catalog={catalog} onOpen={openDetails} onCollectionOpenChange={onCollectionOpenChange}
          folders={collectionFolders(catalog, catalogConfigs)} /> :
        <LazyRail
          catalog={catalog}
          eager={index < 8}
          onOpen={openDetails}
          onFocus={onCardFocus}
          onLoaded={seedHeroFromRow}
          onViewAll={openViewAll}
        />
      }</RowBoundary>)}
      {/* Like Android, a catalog list without the row still shows it, after the others. */}
      {!kids.active && !catalogConfigs.some((catalog) => catalog.id === FAVORITE_TV_CATALOG_ID) && <FavoriteTvRail />}
      {homeServerRows.map((category) => (
        <RowBoundary key={category.id} name={category.id} resetKey={category.items}>
          <MediaRail category={category} onOpen={openDetails} onFocus={onCardFocus} posterMode={posterMode} />
        </RowBoundary>
      ))}
      {viewAll && <CategoryViewAll key={viewAll.category.id} catalog={viewAll.catalog} preview={viewAll.category}
        onBack={() => setViewAll(null)} onOpen={openDetails} />}
    </div>
  );
}
