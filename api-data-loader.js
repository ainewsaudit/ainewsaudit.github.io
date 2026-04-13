/**
 * API Data Loader for AI News Audit
 * Fetches article data from the DynamoDB-backed Lambda API.
 */

const API_URL = 'https://ddnl0hwf80.execute-api.us-east-2.amazonaws.com';

const DATASETS = ['recent_news', 'opinions', 'reporters'];

class ApiDataLoader {
    constructor() {
        this._counts = null;
        this.cachedStats = null;
        this.datasetCounts = {};
        this._filterCache = {};
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    async _fetch(path, params = {}) {
        const url = new URL(API_URL + path);
        Object.entries(params).forEach(([k, v]) => {
            if (v !== null && v !== undefined && v !== '') {
                url.searchParams.set(k, String(v));
            }
        });
        const res = await fetch(url.toString());
        if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
        return res.json();
    }

    async _loadCounts() {
        if (this._counts) return this._counts;
        this._counts = await this._fetch('/counts');
        this.datasetCounts = {
            recent_news: this._counts.recent_news || 0,
            opinions:    this._counts.opinions    || 0,
            reporters:   this._counts.reporters   || 0,
        };
        return this._counts;
    }

    // Fetch articles for one specific dataset_type
    async _fetchOne(datasetType, params) {
        const data = await this._fetch('/articles', { ...params, dataset_type: datasetType });
        return {
            articles:    data.articles    || [],
            total:       data.total       || 0,
            total_found: data.total_found ?? null,
            count_exact: data.count_exact ?? true,
            hasMore:     data.hasMore     || false,
        };
    }

    // -----------------------------------------------------------------------
    // Primary interface used by HTML pages
    // -----------------------------------------------------------------------

    /**
     * Search and filter articles with pagination.
     * When dataset_type is null/empty, queries all three datasets in parallel and merges.
     */
    async getArticles(options = {}) {
        const {
            limit      = 20,
            offset     = 0,
            dataset_type,
            search     = '',
            newspaper  = null,
            topic      = null,
            author     = null,
            prediction = null,
            start_date = null,
            end_date   = null,
            ai_min     = null,
            ai_max     = null,
            max_ai_min = null,
            max_ai_max = null,
        } = options;

        const params = {
            limit,
            offset,
            search,
            newspaper,
            topic,
            author,
            prediction: Array.isArray(prediction) ? prediction.join(',') : prediction,
            start_date,
            end_date,
            ai_min,
            ai_max,
            max_ai_min,
            max_ai_max,
        };

        // Single dataset — direct query
        if (dataset_type) {
            return this._fetchOne(dataset_type, params);
        }

        // All datasets — query in parallel, merge by date, sum totals
        const counts = await this._loadCounts();
        const [rn, op, re] = await Promise.all(
            DATASETS.map(ds => this._fetchOne(ds, params))
        );

        const merged = [...rn.articles, ...op.articles, ...re.articles];
        merged.sort((a, b) => new Date(b.publish_date) - new Date(a.publish_date));

        const allFound = [rn, op, re];
        const totalFound = allFound.reduce((sum, r) => sum + (r.total_found ?? r.articles.length), 0);
        const countExact = allFound.every(r => r.count_exact !== false);

        return {
            articles:    merged.slice(0, limit),
            total:       (counts.recent_news || 0) + (counts.opinions || 0) + (counts.reporters || 0),
            total_found: totalFound,
            count_exact: countExact,
            hasMore:     rn.hasMore || op.hasMore || re.hasMore,
        };
    }

    /**
     * Get a single article by its DynamoDB keys.
     * @param {string} dateId      - date_id sort key
     * @param {string} datasetType - dataset_type partition key
     */
    async getArticle(dateId, datasetType) {
        return this._fetch('/article', { date_id: dateId, dataset_type: datasetType });
    }

    async getStats() {
        if (this.cachedStats) return this.cachedStats;
        const counts = await this._loadCounts();
        const total = (counts.recent_news || 0) + (counts.opinions || 0) + (counts.reporters || 0);
        this.cachedStats = {
            total,
            datasets: {
                recent_news: counts.recent_news || 0,
                opinions:    counts.opinions    || 0,
                reporters:   counts.reporters   || 0,
            },
            ai_likelihood: { avg_likelihood: 0, high_ai_count: 0 },
        };
        return this.cachedStats;
    }

    /**
     * Returns unique topics, newspapers, predictions for the given dataset.
     * The first call per dataset triggers a full partition scan on the API (~5-20s).
     * Results are cached in memory for subsequent calls.
     */
    async getFilterOptions(datasetType = 'recent_news') {
        if (this._filterCache[datasetType]) return this._filterCache[datasetType];
        const data = await this._fetch('/filter-options', { dataset_type: datasetType });
        this._filterCache[datasetType] = data;
        return data;
    }

    /** Aggregated stats for dataset.html charts (full partition scan on API). */
    async getDatasetStats(datasetType) {
        return this._fetch('/stats', { dataset_type: datasetType });
    }

    /**
     * Returns unique authors across the requested datasets.
     * Author scanning is not yet supported server-side; returns empty array.
     * Users can still type author names in the filter — they just won't autocomplete.
     */
    async getUniqueAuthors({ datasets = DATASETS } = {}) {
        return [];
    }

    /**
     * Returns unique newspaper names from already-cached filter options.
     * Does NOT trigger additional API calls — uses whatever was fetched by
     * getFilterOptions() during page init.  A full cross-dataset newspaper
     * list can be populated by calling getFilterOptions() for each dataset
     * explicitly beforehand.
     */
    async getUniqueNewspapers({ datasets = DATASETS } = {}) {
        const names = new Set();
        datasets.forEach(ds => {
            const cached = this._filterCache[ds];
            if (cached) (cached.newspapers || []).forEach(n => names.add(n));
        });
        return [...names].sort();
    }

    // -----------------------------------------------------------------------
    // Preload helpers
    // -----------------------------------------------------------------------

    async preloadCountsOnly()    { return this._loadCounts(); }
    async preloadForIndexPage()  { await this._loadCounts(); await this.getStats(); return { stats: this.cachedStats, counts: this.datasetCounts }; }
    async preloadForDatasetPages() { return { stats: await this.getStats(), counts: this.datasetCounts }; }
    async preloadBasicStats()    { return this.getStats(); }
    async preloadDatasetCounts() { return this._loadCounts(); }
    async getBasicStats()        { return this.getStats(); }
    async getDetailedStats()     { return this.getStats(); }
    async getDatasetCounts()     { return this._loadCounts(); }
    async getDatasetCount(ds)    { const c = await this._loadCounts(); return c[ds] || 0; }
    async getDatasetInfo() {
        const counts = await this._loadCounts();
        const total = Object.values(counts).reduce((s, c) => s + (c || 0), 0);
        return { total, datasets: counts, summary: {
            recent_news: { count: counts.recent_news || 0, label: 'Recent News' },
            opinions:    { count: counts.opinions    || 0, label: 'Opinions'    },
            reporters:   { count: counts.reporters   || 0, label: 'Reporters'   },
        }};
    }

    // -----------------------------------------------------------------------
    // Sync accessors
    // -----------------------------------------------------------------------

    getStatsIfReady()  { return this.cachedStats; }
    isStatsReady()     { return this.cachedStats !== null; }
    getCountsIfReady() { return Object.keys(this.datasetCounts).length > 0 ? { ...this.datasetCounts } : null; }
    async waitForStatsReady() { return this.getStats(); }
    getLoadingStatus() { return { loaded: [], loading: [], failed: [] }; }

    // -----------------------------------------------------------------------
    // No-ops for backward compatibility with static-data-loader call sites
    // -----------------------------------------------------------------------

    enableMultiDatasetMode() {}
    async loadDataset()      { return []; }
    async loadAllDatasets()  { return []; }
    async clearCache() {
        this._counts = null; this.cachedStats = null;
        this.datasetCounts = {}; this._filterCache = {};
    }
}

window.dataLoader = new ApiDataLoader();
