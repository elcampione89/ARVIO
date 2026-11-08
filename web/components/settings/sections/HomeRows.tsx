"use client";
// Home rows: order, visibility, name and card style of every row on Home,
// grouped by where the row comes from. Saved per profile in the same cloud
// fields the Android app reads (catalogsByProfile, hidden*ByProfile and
// catalogueRowLayoutModes).

import { Download, Eye, EyeOff, Image as PosterIcon, Plus, RectangleHorizontal, RotateCcw, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "@/lib/i18n";
import { defaultCatalogs, isDefaultCollection, mergeCatalogs, setDefaultCollectionsEnabled, updateHiddenCatalogIds } from "@/lib/catalogs";
import { parseCustomCollections, mergeImportedCollections } from "@/lib/customCollections";
import { loadSimklCustomList, parseSimklListUrl, searchSimklCustomLists, type SimklCustomList } from "@/lib/simklLists";
import { textRequest, proxiedUrl } from "@/lib/http";
import { buildHomeServerCatalogConfigs } from "@/lib/homeserver";
import { HOME_ROW_SOURCES, homeRowSource, withRowLayoutMode, type HomeRowSource } from "@/lib/homeRows";
import { moveIndex, moveWithinSubset } from "@/lib/ordering";
import { useAppPick } from "@/lib/store";
import type { AppSettings, CatalogConfig } from "@/lib/types";
import { SortableList } from "../SortableList";
import { Group, Row, ScopeBadge, Segmented, SectionHeader, Toggle, safeArray } from "../ui";

export function CatalogsSection() {
  const translateUi = useTranslation();
  const { settings, updateSettings, setToast, activeProfile } = useAppPick("settings", "updateSettings", "setToast", "activeProfile");
  const standardCatalogs = mergeCatalogs(safeArray(settings.catalogs), safeArray(settings.hiddenCatalogIds), safeArray(settings.hiddenAddonCatalogIds))
    .filter((catalog) => catalog.sourceType !== "home-server");
  const [homeServerCatalogs, setHomeServerCatalogs] = useState<CatalogConfig[]>([]);
  const [customCatalogUrl, setCustomCatalogUrl] = useState("");
  const [simklQuery, setSimklQuery] = useState("");
  const [simklResults, setSimklResults] = useState<SimklCustomList[]>([]);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [collectionsInput, setCollectionsInput] = useState("");
  const [importingCollections, setImportingCollections] = useState(false);
  const [source, setSource] = useState<HomeRowSource | "all">("all");
  const [query, setQuery] = useState("");
  useEffect(() => { setSimklResults([]); setSimklQuery(""); }, [activeProfile?.id]);
  const catalogs = [...homeServerCatalogs, ...standardCatalogs];
  const currentImportTarget = useRef({ profileId: activeProfile?.id, catalogs });
  currentImportTarget.current = { profileId: activeProfile?.id, catalogs };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    let cancelled = false;
    void buildHomeServerCatalogConfigs(safeArray(settings.homeServers), safeArray(settings.catalogs), safeArray(settings.hiddenHomeServerCatalogIds))
      .then((next) => { if (!cancelled) setHomeServerCatalogs(next); })
      .catch(() => { if (!cancelled) setHomeServerCatalogs([]); });
    return () => { cancelled = true; };
  }, [settings.catalogs, settings.hiddenHomeServerCatalogIds, settings.homeServers]);

  const updateCatalogs = (next: CatalogConfig[], hiddenIds = settings.hiddenCatalogIds, extra: Partial<AppSettings> = {}) => {
    const homeServer = next.filter((catalog) => catalog.sourceType === "home-server");
    const standard = next.filter((catalog) => catalog.sourceType !== "home-server");
    updateSettings({
      catalogs: next,
      hiddenCatalogIds: updateHiddenCatalogIds(standard, hiddenIds),
      hiddenAddonCatalogIds: updateHiddenCatalogIds(standard.filter((catalog) => catalog.sourceType === "addon"), settings.hiddenAddonCatalogIds),
      hiddenHomeServerCatalogIds: updateHiddenCatalogIds(homeServer, settings.hiddenHomeServerCatalogIds),
      ...extra,
    });
  };
  const patchCatalog = (id: string, patch: Partial<CatalogConfig>, extra?: Partial<AppSettings>) =>
    updateCatalogs(catalogs.map((c) => c.id === id ? { ...c, ...patch } : c), settings.hiddenCatalogIds, extra);

  const sourceLabel = (id: HomeRowSource) => ({
    tmdb: translateUi("Built-in"), addon: translateUi("Addon catalogs"), lists: translateUi("Trakt, MDBList and SIMKL lists"),
    "home-server": translateUi("Home server libraries"), collections: translateUi("Collections"), youtube: translateUi("YouTube"),
  })[id];
  const counts = useMemo(() => {
    const map = new Map<HomeRowSource, number>();
    for (const catalog of catalogs) map.set(homeRowSource(catalog), (map.get(homeRowSource(catalog)) ?? 0) + 1);
    return map;
  }, [catalogs]);
  const needle = query.trim().toLowerCase();
  const filtered = catalogs.filter((catalog) => (source === "all" || homeRowSource(catalog) === source) &&
    (!needle || catalog.name.toLowerCase().includes(needle)));
  const filteredKeys = filtered.map((catalog) => catalog.id);
  const isFiltered = source !== "all" || Boolean(needle);
  const move = (from: number, to: number) => {
    const next = isFiltered ? moveWithinSubset(catalogs, (catalog) => catalog.id, filteredKeys, from, to) : moveIndex(catalogs, from, to);
    if (next !== catalogs) updateCatalogs(next);
  };
  const setFilteredEnabled = (enabled: boolean) => {
    const ids = new Set(filteredKeys);
    updateCatalogs(catalogs.map((catalog) => ids.has(catalog.id) ? { ...catalog, enabled } : catalog));
  };

  const addSimklCatalog = async (rawUrl: string) => {
    const simkl = parseSimklListUrl(rawUrl);
    if (!simkl || catalogBusy) return;
    const profile = activeProfile?.id;
    setCatalogBusy(true);
    try {
      if (catalogs.some((c) => c.sourceType === "simkl" && c.sourceUrl && parseSimklListUrl(c.sourceUrl)?.id === simkl.id)) throw new Error("This catalogue is already added.");
      const list = await loadSimklCustomList(simkl.url);
      if (!mounted.current || currentImportTarget.current.profileId !== profile) return;
      const latest = currentImportTarget.current.catalogs;
      if (latest.some((c) => c.sourceType === "simkl" && c.sourceUrl && parseSimklListUrl(c.sourceUrl)?.id === simkl.id)) throw new Error("This catalogue is already added.");
      updateCatalogs([{ id: `custom_${crypto.randomUUID()}`, name: list.name, sourceType: "simkl", sourceUrl: simkl.url,
        sourceRef: `simkl_list:${simkl.id}`, mediaType: list.media_type === "movies" ? "movie" : "tv", enabled: true }, ...latest]);
      setCustomCatalogUrl("");
    } catch (error) {
      if (mounted.current && currentImportTarget.current.profileId === profile) setToast((error as Error).message);
    } finally {
      if (mounted.current) setCatalogBusy(false);
    }
  };

  const addList = async () => {
    if (catalogBusy) return;
    if (!customCatalogUrl.trim()) { setToast("Enter a catalog URL first."); return; }
    const simkl = parseSimklListUrl(customCatalogUrl);
    if (simkl) { await addSimklCatalog(simkl.url); return; }
    updateCatalogs([{ id: `custom_${crypto.randomUUID()}`, name: "Custom MDBList", sourceType: "mdblist", mediaType: "all", sourceUrl: customCatalogUrl.trim(), enabled: true }, ...catalogs]);
    setCustomCatalogUrl("");
  };

  const importCollections = async () => {
    const profileId = activeProfile?.id;
    setImportingCollections(true);
    try {
      const input = collectionsInput.trim();
      const raw = input.startsWith("[") || input.startsWith("{");
      if (!raw && !/^https?:\/\//i.test(input)) throw new Error("Enter an HTTP(S) URL or collections JSON");
      const json = raw ? input : await textRequest(proxiedUrl(input));
      const imported = await parseCustomCollections(json, raw ? undefined : input);
      if (!mounted.current || currentImportTarget.current.profileId !== profileId) return;
      updateCatalogs(mergeImportedCollections(currentImportTarget.current.catalogs, imported));
      setCollectionsInput("");
      setToast("Collections imported");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not import collections");
    } finally {
      setImportingCollections(false);
    }
  };

  const shown = catalogs.filter((c) => c.enabled);
  const collectionPacks = Array.from(new Map(catalogs.filter((c) => c.packId?.startsWith("usercol_")).map((c) => [c.packId!, c.packName || c.name])).entries());
  const hasDefaultCollections = catalogs.some((c) => isDefaultCollection(c) && c.kind === "COLLECTION_RAIL");

  return (
    <>
      <SectionHeader title="Home rows" description="The rows on your Home screen, in order. Changes apply to this profile on every ARVIO app.">
        <button type="button" className="st-btn" onClick={() => updateCatalogs([...homeServerCatalogs, ...defaultCatalogs])}><RotateCcw size={16} /> {translateUi("Reset to defaults")}</button>
      </SectionHeader>

      <Group title={`${translateUi("Rows")} · ${shown.length}/${catalogs.length} ${translateUi("shown")}`}
        description={<>{translateUi("Drag rows, or use the arrows, to set the order. Filter by source to arrange one kind of row at a time; rows you can't see keep their place.")} <ScopeBadge scope="all" /></>}>
        <div className="st-chips" role="group" aria-label={translateUi("Filter by source")}>
          <button type="button" className="st-chip" aria-pressed={source === "all"} onClick={() => setSource("all")}>{translateUi("All")} <small>{catalogs.length}</small></button>
          {HOME_ROW_SOURCES.filter(([id]) => counts.get(id)).map(([id]) => (
            <button type="button" key={id} className="st-chip" aria-pressed={source === id} onClick={() => setSource(id)}>{sourceLabel(id)} <small>{counts.get(id)}</small></button>
          ))}
        </div>
        <div className="st-toolbar">
          <input className="st-input" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={translateUi("Find a row")} aria-label={translateUi("Find a row")} />
          <button type="button" className="st-btn" disabled={!filtered.length} onClick={() => setFilteredEnabled(true)}><Eye size={16} />{(isFiltered ? translateUi("Show these") : translateUi("Show all"))}</button>
          <button type="button" className="st-btn" disabled={!filtered.length} onClick={() => setFilteredEnabled(false)}><EyeOff size={16} />{(isFiltered ? translateUi("Hide these") : translateUi("Hide all"))}</button>
        </div>
        <div className="st-layout is-rows">
          <div className="st-layout-main">
            <SortableList
              items={filtered}
              label={translateUi("Home rows")}
              getKey={(catalog) => catalog.id}
              getLabel={(catalog) => catalog.name}
              onMove={move}
              rowClassName={(catalog) => catalog.enabled ? "" : "is-off"}
              emptyText={translateUi("No rows match.")}
              renderMain={(catalog) => (
                <>
                  <input className="st-input is-wide" aria-label={`${translateUi("Row name")}: ${catalog.name}`} value={catalog.name}
                    onChange={(e) => patchCatalog(catalog.id, { name: e.target.value, title: e.target.value })} />
                  <span className="st-sort-sub">{sourceLabel(homeRowSource(catalog))}{(catalog.sourceUrl || catalog.endpoint || catalog.addonCatalogId) ? ` · ${catalog.sourceUrl || catalog.endpoint || catalog.addonCatalogId}` : ""}</span>
                </>
              )}
              renderActions={(catalog) => (
                <>
                  <Segmented label={`${translateUi("Card style")}: ${catalog.name}`} value={catalog.layout ?? "landscape"} options={[["landscape", "Wide"], ["poster", "Poster"]]}
                    onChange={(layout) => patchCatalog(catalog.id, { layout }, { catalogueRowLayoutModes: withRowLayoutMode(settings.catalogueRowLayoutModes, catalog.id, layout) })} />
                  <button type="button" className="st-icon-btn" aria-label={`${catalog.enabled ? translateUi("Hide") : translateUi("Show")} ${catalog.name}`}
                    onClick={() => patchCatalog(catalog.id, { enabled: !catalog.enabled })}>
                    {catalog.enabled ? <Eye size={17} /> : <EyeOff size={17} />}
                  </button>
                  {!catalog.isPreinstalled && catalog.sourceType !== "home-server" && (
                    <button type="button" className="st-icon-btn is-danger" aria-label={translateUi("Remove {value0}", { value0: catalog.name })}
                      onClick={() => updateCatalogs(catalogs.filter((c) => c.id !== catalog.id))}><Trash2 size={17} /></button>
                  )}
                </>
              )}
            />
          </div>
          <aside className="st-preview" aria-label={translateUi("Preview")}>
            <h4>{translateUi("Preview")} · {translateUi("Home")}</h4>
            <p>{translateUi("Rows that are shown, top to bottom. Rows with nothing to show are skipped on Home.")}</p>
            <ol>
              {shown.slice(0, 16).map((catalog) => (
                <li key={catalog.id} className={filteredKeys.includes(catalog.id) && isFiltered ? "is-focus" : ""}>
                  {catalog.layout === "poster" ? <PosterIcon size={13} aria-label={translateUi("Poster")} /> : <RectangleHorizontal size={13} aria-label={translateUi("Wide")} />}
                  <span>{catalog.name}</span>
                </li>
              ))}
              {shown.length > 16 && <li className="st-preview-more">{translateUi("+ {value0} more", { value0: shown.length - 16 })}</li>}
            </ol>
          </aside>
        </div>
      </Group>

      <Group title="Add a list" description="Paste a Trakt, MDBList or SIMKL list URL. SIMKL custom-list contents require SIMKL PRO or VIP.">
        <div className="st-form">
          <input className="st-input" value={customCatalogUrl} onChange={(e) => setCustomCatalogUrl(e.target.value)} placeholder="Trakt / MDBList / SIMKL list URL"
            aria-label={translateUi("List URL")} onKeyDown={(e) => { if (e.key === "Enter") void addList(); }} />
          <div className="st-form-actions"><button type="button" className="st-btn is-primary" disabled={catalogBusy} onClick={() => void addList()}><Plus size={16} /> {translateUi("Add")}</button></div>
        </div>
        <div className="st-form">
          <input className="st-input" value={simklQuery} onChange={(event) => setSimklQuery(event.target.value)} placeholder={translateUi("Search SIMKL lists")} aria-label={translateUi("Search SIMKL lists")} />
          <div className="st-form-actions">
            <button type="button" className="st-btn" disabled={catalogBusy || simklQuery.trim().length < 2} onClick={async () => {
              const profile = activeProfile?.id;
              setCatalogBusy(true);
              try {
                const results = await searchSimklCustomLists(simklQuery);
                if (mounted.current && currentImportTarget.current.profileId === profile) setSimklResults(results);
              } catch (error) {
                if (mounted.current && currentImportTarget.current.profileId === profile) setToast((error as Error).message);
              } finally {
                if (mounted.current) setCatalogBusy(false);
              }
            }}><Search size={16} /> {translateUi("Search")}</button>
          </div>
        </div>
        {simklResults.length > 0 && (
          <ul className="st-list">
            {simklResults.map((list) => (
              <li className="st-item" key={list.id}>
                <div className="st-item-main"><span className="st-item-title"><span>{list.name}</span></span><span className="st-item-sub">SIMKL · {list.counts?.items ?? "—"}</span></div>
                <button type="button" className="st-btn" disabled={catalogBusy || catalogs.some((c) => c.sourceRef === `simkl_list:${list.id}`)}
                  onClick={() => void addSimklCatalog(list.user?.id ? `https://simkl.com/${list.user.id}/list/${list.id}` : `https://simkl.com/lists/${list.id}`)}>{translateUi("Add")}</button>
              </li>
            ))}
          </ul>
        )}
      </Group>

      <Group title="Collections" description="Import a collections pack from a URL or paste its JSON.">
        {hasDefaultCollections && (
          <Row id="default-collections" label="Default collections" scope="all">
            <Toggle label="Default collections" value={catalogs.some((c) => isDefaultCollection(c) && c.kind === "COLLECTION_RAIL" && c.enabled)}
              onChange={(enabled) => { const next = setDefaultCollectionsEnabled(catalogs, settings.hiddenCatalogIds, enabled); updateCatalogs(next.catalogs, next.hiddenIds); }} />
          </Row>
        )}
        {collectionPacks.length > 0 && (
          <ul className="st-list">
            {collectionPacks.map(([id, name]) => (
              <li className="st-item" key={id}>
                <div className="st-item-main"><span className="st-item-title"><span>{name}</span></span></div>
                <button type="button" className="st-icon-btn is-danger" aria-label={`${translateUi("Remove")} ${name}`} onClick={() => updateCatalogs(catalogs.filter((c) => c.packId !== id))}><Trash2 size={17} /></button>
              </li>
            ))}
          </ul>
        )}
        <div className="st-form">
          <textarea className="st-input" aria-label={translateUi("Collection")} value={collectionsInput} onChange={(e) => setCollectionsInput(e.target.value)} placeholder={translateUi("Collections URL or JSON")} rows={3} />
          <div className="st-form-actions">
            <button type="button" className="st-btn" disabled={importingCollections || !collectionsInput.trim()} onClick={() => void importCollections()}>
              <Download size={16} /> {(importingCollections ? translateUi("Importing...") : translateUi("Import collections"))}
            </button>
          </div>
        </div>
      </Group>
    </>
  );
}
