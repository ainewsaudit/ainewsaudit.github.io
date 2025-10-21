/**
 * Static Data Loader for AI News Audit
 * Loads and manages article data from static JSON files
 */

class StaticDataLoader {
    constructor() {
        this.data = {
            recent_news: null,
            opinions: null,
            reporters: null
        };
        this.loadPromises = {};
        this.allArticles = null;
        this.cachedStats = null;
        this.datasetCounts = {};
        this.statsPromises = {};
        this.isLoading = false;
        this.currentDataset = null; // Track which dataset is currently loaded
        this.keepAllDatasets = false; // Flag to keep all datasets in memory
        
        // IndexedDB caching
        this.DB_NAME = 'news-cache-v2'; // Bump version to bust cache after text truncation
        this.STORE_NAME = 'datasets';
        this.DATA_VERSION = null; // Will be loaded from dataset_counts.json
        this.dbReady = this.initDB();
    }

    /**
     * Initialize IndexedDB
     */
    async initDB() {
        if (!window.indexedDB) {
            console.warn('IndexedDB not available, caching disabled');
            return null;
        }

        try {
            const request = indexedDB.open(this.DB_NAME, 1);
            
            return new Promise((resolve, reject) => {
                request.onerror = () => {
                    console.warn('IndexedDB init failed:', request.error);
                    resolve(null);
                };
                
                request.onsuccess = () => {
                    resolve(request.result);
                };
                
                request.onupgradeneeded = (event) => {
                    const db = event.target.result;
                    if (!db.objectStoreNames.contains(this.STORE_NAME)) {
                        db.createObjectStore(this.STORE_NAME);
                    }
                };
            });
        } catch (error) {
            console.warn('IndexedDB not supported:', error);
            return null;
        }
    }

    /**
     * Get dataset from IndexedDB
     */
    async getFromIndexedDB(key, version) {
        try {
            const db = await this.dbReady;
            if (!db) return null;

            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.STORE_NAME], 'readonly');
                const store = transaction.objectStore(this.STORE_NAME);
                const request = store.get(key);

                request.onsuccess = () => {
                    const record = request.result;
                    if (record && record.version === version) {
                        resolve(record.payload);
                    } else {
                        resolve(null);
                    }
                };

                request.onerror = () => {
                    console.warn('IndexedDB get failed:', request.error);
                    resolve(null);
                };
            });
        } catch (error) {
            console.warn('IndexedDB get error:', error);
            return null;
        }
    }

    /**
     * Save dataset to IndexedDB
     */
    async putInIndexedDB(key, version, payload) {
        try {
            const db = await this.dbReady;
            if (!db) return;

            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.STORE_NAME], 'readwrite');
                const store = transaction.objectStore(this.STORE_NAME);
                const request = store.put({ version, payload }, key);

                request.onsuccess = () => resolve();
                request.onerror = () => {
                    console.warn('IndexedDB put failed:', request.error);
                    resolve();
                };
            });
        } catch (error) {
            console.warn('IndexedDB put error:', error);
        }
    }

    /**
     * Load data version from metadata
     */
    async loadDataVersion() {
        if (this.DATA_VERSION) return this.DATA_VERSION;
        
        try {
            const response = await fetch('/static_data/dataset_counts.json', {
                cache: 'force-cache'
            });
            
            if (response.ok) {
                const metadata = await response.json();
                this.DATA_VERSION = metadata.last_updated || 'v1';
                return this.DATA_VERSION;
            }
        } catch (error) {
            console.warn('Failed to load data version:', error);
        }
        
        this.DATA_VERSION = 'v1'; // fallback
        return this.DATA_VERSION;
    }

    // Normalization is done offline; keep a no-op for compatibility
    normalizePrediction(raw) { return raw; }

    // Author normalization is now done offline in the data files
    // This function is kept for backward compatibility but is no longer needed
    normalizeAuthors(authorsString) {
        // Authors are now pre-normalized in the data files
        return authorsString || '';
    }

    /**
     * Clear datasets from memory except the specified one
     */
    clearOtherDatasets(keepDataset) {
        // Don't clear if we're in multi-dataset mode (keeping everything loaded)
        if (this.keepAllDatasets) {
            console.log(`📦 Keeping all datasets in memory (multi-dataset mode)`);
            return;
        }
        
        console.log(`🧹 Clearing datasets from memory (keeping: ${keepDataset})`);
        const datasets = ['recent_news', 'opinions', 'reporters'];
        let clearedCount = 0;
        
        datasets.forEach(dataset => {
            if (dataset !== keepDataset && this.data[dataset]) {
                this.data[dataset] = null;
                clearedCount++;
            }
        });
        
        // Clear allArticles cache too
        this.allArticles = null;
        this.currentDataset = keepDataset;
        
        if (clearedCount > 0) {
            console.log(`✅ Cleared ${clearedCount} dataset(s) from memory`);
        }
    }
    
    /**
     * Enable keeping all datasets in memory (for background loading)
     */
    enableMultiDatasetMode() {
        console.log('📦 Enabled multi-dataset mode - will keep all datasets in memory');
        this.keepAllDatasets = true;
    }

    /**
     * Wait for pako to be available
     */
    async waitForPako() {
        let attempts = 0;
        while (typeof pako === 'undefined' && attempts < 50) {
            await new Promise(resolve => setTimeout(resolve, 100));
            attempts++;
        }
        if (typeof pako === 'undefined') {
            throw new Error('pako library failed to load after 5 seconds');
        }
    }

    /**
     * Load NDJSON file with streaming and progressive rendering
     * @param {string} url - URL to the NDJSON file
     * @param {function} onRow - Callback for each parsed row
     * @param {function} onProgress - Optional progress callback
     */
    async loadNDJSON(url, onRow, onProgress = null) {
        const response = await fetch(url, { cache: 'force-cache' });
        
        if (!response.ok) {
            throw new Error(`Failed to load ${url}: ${response.statusText}`);
        }

        const reader = response.body
            .pipeThrough(new TextDecoderStream())
            .getReader();

        let buffer = '';
        let rowCount = 0;
        const batchSize = 100; // Process in batches for better performance
        let batch = [];

        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                
                buffer += value;
                let idx;
                
                while ((idx = buffer.indexOf('\n')) >= 0) {
                    const line = buffer.slice(0, idx);
                    buffer = buffer.slice(idx + 1);
                    
                    if (line.trim()) {
                        try {
                            const row = JSON.parse(line);
                            batch.push(row);
                            rowCount++;
                            
                            // Process in batches for better performance
                            if (batch.length >= batchSize) {
                                for (const item of batch) {
                                    onRow(item);
                                }
                                batch = [];
                                
                                if (onProgress) {
                                    onProgress({ loaded: rowCount });
                                }
                            }
                        } catch (e) {
                            console.warn('Failed to parse NDJSON line:', e);
                        }
                    }
                }
            }
            
            // Process remaining buffer
            if (buffer.trim()) {
                try {
                    const row = JSON.parse(buffer);
                    batch.push(row);
                    rowCount++;
                } catch (e) {
                    console.warn('Failed to parse final NDJSON line:', e);
                }
            }
            
            // Process remaining batch
            if (batch.length > 0) {
                for (const item of batch) {
                    onRow(item);
                }
            }
            
            if (onProgress) {
                onProgress({ loaded: rowCount, complete: true });
            }
            
            return rowCount;
        } catch (error) {
            console.error('NDJSON streaming error:', error);
            throw error;
        }
    }

    /**
     * Load dataset with streaming support (NDJSON) for progressive rendering
     */
    async loadDatasetStreaming(datasetType, options = {}) {
        const { onProgress = null, onBatch = null } = options;
        
        // Check memory cache first
        if (this.data[datasetType]) {
            console.log(`✅ Using cached ${datasetType} dataset (${this.data[datasetType].length} articles)`);
            if (onBatch) {
                onBatch(this.data[datasetType], true);
            }
            return this.data[datasetType];
        }

        // Check if another request is already loading this dataset
        if (this.loadPromises[datasetType]) {
            console.log(`⏳ Waiting for ${datasetType} dataset to finish loading...`);
            return this.loadPromises[datasetType];
        }

        // Check IndexedDB cache
        const version = await this.loadDataVersion();
        const cachedData = await this.getFromIndexedDB(datasetType, version);
        if (cachedData) {
            console.log(`💾 Loaded ${datasetType} from IndexedDB (${cachedData.length} articles) - instant!`);
            this.data[datasetType] = cachedData;
            if (onBatch) {
                onBatch(cachedData, true);
            }
            return cachedData;
        }

        console.log(`🌊 Streaming ${datasetType} dataset from network...`);

        const ndjsonUrl = `/static_data/${datasetType}_data.ndjson`;
        const startTime = performance.now();
        const articles = [];
        
        const datasetPrefix = datasetType === 'recent_news' ? 1 : datasetType === 'opinions' ? 2 : 3;
        const toNum = (val) => {
            const n = typeof val === 'number' ? val : parseFloat(val);
            return Number.isFinite(n) ? n : null;
        };

        let batchBuffer = [];
        const RENDER_BATCH_SIZE = 50; // Send batches to UI

        this.loadPromises[datasetType] = (async () => {
            try {
                await this.loadNDJSON(ndjsonUrl, (article) => {
                    // Process article
                    article.dataset_type = datasetType;
                    article.id = datasetPrefix * 1000000 + articles.length;
                    
                    // Normalize numeric fields
                    if (article.ai_likelihood !== undefined) article.ai_likelihood = toNum(article.ai_likelihood);
                    if (article.avg_ai_likelihood !== undefined) article.avg_ai_likelihood = toNum(article.avg_ai_likelihood);
                    if (article.max_ai_likelihood !== undefined) article.max_ai_likelihood = toNum(article.max_ai_likelihood);
                    if (article.fraction_ai_content !== undefined) article.fraction_ai_content = toNum(article.fraction_ai_content);
                    
                    articles.push(article);
                    batchBuffer.push(article);
                    
                    // Send batches to UI for progressive rendering
                    if (batchBuffer.length >= RENDER_BATCH_SIZE && onBatch) {
                        onBatch([...batchBuffer], false);
                        batchBuffer = [];
                    }
                }, (progress) => {
                    if (onProgress) {
                        onProgress({
                            loaded: progress.loaded,
                            complete: progress.complete || false
                        });
                    }
                });
                
                // Send final batch
                if (batchBuffer.length > 0 && onBatch) {
                    onBatch([...batchBuffer], true);
                }
                
                this.data[datasetType] = articles;
                
                // Save to IndexedDB
                this.putInIndexedDB(datasetType, version, articles).catch(err => {
                    console.warn('Failed to cache in IndexedDB:', err);
                });
                
                const endTime = performance.now();
                console.log(`✅ Streamed ${datasetType}: ${articles.length} articles in ${(endTime - startTime).toFixed(2)}ms`);
                
                return articles;
            } catch (error) {
                console.warn(`NDJSON not available for ${datasetType}, falling back to JSON.gz`);
                delete this.loadPromises[datasetType];
                return this.loadDataset(datasetType);
            }
        })();

        return this.loadPromises[datasetType];
    }

    /**
     * Load a dataset from static JSON file - with performance monitoring and IndexedDB caching
     */
    async loadDataset(datasetType) {
        // Check memory cache first
        if (this.data[datasetType]) {
            console.log(`✅ Using cached ${datasetType} dataset (${this.data[datasetType].length} articles)`);
            return this.data[datasetType];
        }

        // Check if another request is already loading this dataset
        if (this.loadPromises[datasetType]) {
            console.log(`⏳ Waiting for ${datasetType} dataset to finish loading...`);
            return this.loadPromises[datasetType];
        }

        // Check IndexedDB cache
        const version = await this.loadDataVersion();
        const cachedData = await this.getFromIndexedDB(datasetType, version);
        if (cachedData) {
            console.log(`💾 Loaded ${datasetType} from IndexedDB (${cachedData.length} articles) - instant!`);
            this.data[datasetType] = cachedData;
            return cachedData;
        }

        console.log(`🔄 Loading ${datasetType} dataset from network...`);

        const filename = `${datasetType}_data.json.gz`;
        const url = `/static_data/${filename}`;
        const startTime = performance.now();

        this.loadPromises[datasetType] = this.waitForPako().then(() => fetch(url, {
            cache: 'force-cache',
            headers: {
                'Accept': 'application/gzip, application/octet-stream, */*'
            }
        }))
            .then(response => {
                if (!response.ok) {
                    throw new Error(`Failed to load ${filename}: ${response.statusText}`);
                }
                return response.arrayBuffer();
            })
            .then(buffer => {
                // Decompress using pako (gzip) - optimized single-path decompression
                const uint8Array = new Uint8Array(buffer);
                let decompressed;
                try {
                    // Check if the data is already decompressed (starts with JSON)
                    if (uint8Array[0] === 0x5b) { // '[' character - JSON array start
                        decompressed = new TextDecoder('utf-8').decode(uint8Array);
                    } else if (uint8Array[0] === 0x1f && uint8Array[1] === 0x8b) {
                        // Standard gzip decompression
                            decompressed = pako.ungzip(uint8Array, { to: 'string' });
                    } else {
                        throw new Error(`Unknown file format for ${filename}`);
                    }
                } catch (e) {
                    throw new Error(`Failed to decompress ${filename}: ${e.message}`);
                }

                // Sanitize invalid JSON tokens produced by some writers (NaN/Infinity)
                let sanitized = decompressed
                    .replace(/:\s*NaN/gi, ': null')
                    .replace(/:\s*Infinity/gi, ': null')
                    .replace(/:\s*-Infinity/gi, ': null');

                let data;
                try {
                    data = JSON.parse(sanitized);
                } catch (e) {
                    // Log a small preview to help debugging
                    console.error('JSON preview:', sanitized.slice(0, 200));
                    throw new Error(`Invalid JSON in ${filename}: ${e.message}`);
                }
                
                // Normalize and annotate each article - optimized processing
                    const datasetPrefix = datasetType === 'recent_news' ? 1 : datasetType === 'opinions' ? 2 : 3;
                    const toNum = (val) => {
                        const n = typeof val === 'number' ? val : parseFloat(val);
                        return Number.isFinite(n) ? n : null;
                    };

                // Process articles in batch for better performance
                for (let i = 0; i < data.length; i++) {
                    const article = data[i];
                    article.dataset_type = datasetType;
                    article.id = datasetPrefix * 1000000 + i; // e.g., 1000001, 2000001, 3000001

                    // Normalize numeric fields only if they exist
                    if (article.ai_likelihood !== undefined) article.ai_likelihood = toNum(article.ai_likelihood);
                    if (article.avg_ai_likelihood !== undefined) article.avg_ai_likelihood = toNum(article.avg_ai_likelihood);
                    if (article.max_ai_likelihood !== undefined) article.max_ai_likelihood = toNum(article.max_ai_likelihood);
                    if (article.fraction_ai_content !== undefined) article.fraction_ai_content = toNum(article.fraction_ai_content);
                    
                    // Authors are now pre-normalized in the data files
                }
                
                this.data[datasetType] = data;
                
                // Save to IndexedDB for instant loading on next visit
                this.putInIndexedDB(datasetType, version, data).catch(err => {
                    console.warn('Failed to cache in IndexedDB:', err);
                });
                
                const endTime = performance.now();
                console.log(`Loaded ${datasetType} dataset: ${data.length} articles in ${(endTime - startTime).toFixed(2)}ms`);
                return data;
            });

        return this.loadPromises[datasetType];
    }

    /**
     * Load all datasets - optimized for lazy loading
     */
    async loadAllDatasets() {
        if (this.allArticles) {
            return this.allArticles;
        }

        // Load datasets in parallel but don't fail if one fails
        const results = await Promise.allSettled([
            this.loadDataset('recent_news'),
            this.loadDataset('opinions'),
            this.loadDataset('reporters')
        ]);

        const datasets = [];
        results.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                datasets.push(result.value);
            } else {
                console.error(`Failed to load dataset:`, result.reason);
                datasets.push([]); // Empty array for failed datasets
            }
        });

        this.allArticles = [...datasets[0], ...datasets[1], ...datasets[2]];
        return this.allArticles;
    }

    /**
     * Load only specific datasets (lazy loading)
     */
    async loadSpecificDatasets(datasetTypes) {
        // Clear other datasets to save memory
        if (datasetTypes.length === 1) {
            this.clearOtherDatasets(datasetTypes[0]);
        }
        
        const results = await Promise.allSettled(
            datasetTypes.map(type => this.loadDataset(type))
        );

        const datasets = [];
        results.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                datasets.push(result.value);
            } else {
                console.error(`Failed to load dataset ${datasetTypes[index]}:`, result.reason);
                datasets.push([]);
            }
        });

        return datasets.flat();
    }

    /**
     * Progressive loading - load datasets with priority
     */
    async loadProgressive(datasetTypes, onProgress = null) {
        const results = [];
        const total = datasetTypes.length;
        
        for (let i = 0; i < datasetTypes.length; i++) {
            const type = datasetTypes[i];
            try {
                const data = await this.loadDataset(type);
                results.push(data);
                if (onProgress) {
                    onProgress({
                        loaded: i + 1,
                        total: total,
                        current: type,
                        progress: ((i + 1) / total) * 100
                    });
                }
            } catch (error) {
                console.error(`Failed to load ${type}:`, error);
                results.push([]);
            }
        }
        
        return results.flat();
    }

    /**
     * Clear cache and force reload (including IndexedDB)
     */
    async clearCache() {
        this.data = {
            recent_news: null,
            opinions: null,
            reporters: null
        };
        this.loadPromises = {};
        this.allArticles = null;
        this.cachedStats = null;
        this.datasetCounts = {};
        this.statsPromises = {};
        
        // Clear IndexedDB
        try {
            const db = await this.dbReady;
            if (db) {
                const transaction = db.transaction([this.STORE_NAME], 'readwrite');
                const store = transaction.objectStore(this.STORE_NAME);
                await store.clear();
                console.log('Cache cleared (memory + IndexedDB)');
            } else {
                console.log('Cache cleared (memory only)');
            }
        } catch (error) {
            console.warn('Failed to clear IndexedDB:', error);
            console.log('Cache cleared (memory only)');
        }
    }

    /**
     * Preload critical datasets for faster initial access
     */
    async preloadCritical() {
        // Preload the most commonly used dataset first
        try {
            await this.loadDataset('recent_news');
            console.log('Preloaded recent_news dataset');
        } catch (error) {
            console.warn('Failed to preload recent_news:', error);
        }
    }

    /**
     * Preload dataset counts and basic stats
     */
    async preloadDatasetCounts() {
        const startTime = performance.now();
        
        try {
            // Load all datasets in parallel
            const results = await Promise.allSettled([
                this.loadDataset('recent_news'),
                this.loadDataset('opinions'),
                this.loadDataset('reporters')
            ]);

            // Calculate counts for each dataset
            const datasetTypes = ['recent_news', 'opinions', 'reporters'];
            results.forEach((result, index) => {
                const type = datasetTypes[index];
                if (result.status === 'fulfilled' && result.value) {
                    const validArticles = result.value.filter(a => 
                        !a.prediction || !a.prediction.toLowerCase().includes('error')
                    );
                    this.datasetCounts[type] = validArticles.length;
                } else {
                    this.datasetCounts[type] = 0;
                }
            });

            const endTime = performance.now();
            console.log(`Preloaded dataset counts in ${(endTime - startTime).toFixed(2)}ms:`, this.datasetCounts);
            
            return this.datasetCounts;
        } catch (error) {
            console.error('Failed to preload dataset counts:', error);
            return {};
        }
    }

    /**
     * Ultra-fast preload - load counts from metadata file
     */
    async preloadCountsOnly() {
        const startTime = performance.now();
        
        try {
            // Try to load from metadata file first (instant)
            const response = await fetch('/static_data/dataset_counts.json', {
                cache: 'force-cache'
            });
            
            if (response.ok) {
                const metadata = await response.json();
                const counts = {
                    recent_news: metadata.recent_news || 0,
                    opinions: metadata.opinions || 0,
                    reporters: metadata.reporters || 0
                };
                
                this.datasetCounts = counts;
                const endTime = performance.now();
                console.log(`Ultra-fast preloaded counts from metadata in ${(endTime - startTime).toFixed(2)}ms:`, counts);
                
                return counts;
            } else {
                throw new Error('Metadata file not found, falling back to structure loading');
            }
        } catch (error) {
            console.log('Metadata loading failed, falling back to structure loading:', error.message);
            
            // Fallback to structure loading
            try {
                const counts = {};
                const datasetTypes = ['recent_news', 'opinions', 'reporters'];
                
                // Load just the JSON structure without processing articles
                const results = await Promise.allSettled(
                    datasetTypes.map(type => this.loadDatasetStructureOnly(type))
                );

                results.forEach((result, index) => {
                    const type = datasetTypes[index];
                    if (result.status === 'fulfilled' && result.value) {
                        counts[type] = result.value;
                    } else {
                        counts[type] = 0;
                    }
                });

                this.datasetCounts = counts;
                const endTime = performance.now();
                console.log(`Fallback preloaded counts in ${(endTime - startTime).toFixed(2)}ms:`, counts);
                
                return counts;
            } catch (fallbackError) {
                console.error('Failed to preload counts:', fallbackError);
                return {};
            }
        }
    }

    /**
     * Load just the dataset structure to get count (very lightweight)
     */
    async loadDatasetStructureOnly(datasetType) {
        if (this.data[datasetType]) {
            return this.data[datasetType].length;
        }

        if (this.loadPromises[`${datasetType}_structure`]) {
            return this.loadPromises[`${datasetType}_structure`];
        }

        const filename = `${datasetType}_data.json.gz`;
        const url = `/static_data/${filename}`;
        const startTime = performance.now();

        this.loadPromises[`${datasetType}_structure`] = this.waitForPako().then(() => fetch(url, {
            cache: 'force-cache',
            headers: {
                'Accept': 'application/gzip, application/octet-stream, */*'
            }
        }))
            .then(response => {
                if (!response.ok) {
                    throw new Error(`Failed to load ${filename}: ${response.statusText}`);
                }
                return response.arrayBuffer();
            })
            .then(buffer => {
                // Decompress using pako (gzip) - optimized single-path decompression
                const uint8Array = new Uint8Array(buffer);
                let decompressed;
                try {
                    // Check if the data is already decompressed (starts with JSON)
                    if (uint8Array[0] === 0x5b) { // '[' character - JSON array start
                        decompressed = new TextDecoder('utf-8').decode(uint8Array);
                    } else if (uint8Array[0] === 0x1f && uint8Array[1] === 0x8b) {
                        // Standard gzip decompression
                        decompressed = pako.ungzip(uint8Array, { to: 'string' });
                    } else {
                        throw new Error(`Unknown file format for ${filename}`);
                    }
                } catch (e) {
                    throw new Error(`Failed to decompress ${filename}: ${e.message}`);
                }

                // Just parse and count, don't process articles
                let sanitized = decompressed
                    .replace(/:\s*NaN/gi, ': null')
                    .replace(/:\s*Infinity/gi, ': null')
                    .replace(/:\s*-Infinity/gi, ': null');

                let data;
                try {
                    data = JSON.parse(sanitized);
                } catch (e) {
                    throw new Error(`Invalid JSON in ${filename}: ${e.message}`);
                }
                
                const endTime = performance.now();
                console.log(`Loaded ${datasetType} structure: ${data.length} articles in ${(endTime - startTime).toFixed(2)}ms`);
                
                return data.length;
            });

        return this.loadPromises[`${datasetType}_structure`];
    }

    /**
     * Get dataset counts (cached)
     */
    async getDatasetCounts() {
        if (Object.keys(this.datasetCounts).length === 0) {
            await this.preloadDatasetCounts();
        }
        return { ...this.datasetCounts };
    }

    /**
     * Preload basic statistics
     */
    async preloadBasicStats() {
        if (this.cachedStats) {
            return this.cachedStats;
        }

        if (this.statsPromises.basic) {
            return this.statsPromises.basic;
        }

        const startTime = performance.now();
        
        this.statsPromises.basic = this.preloadDatasetCounts().then(() => {
            const stats = {
                total: Object.values(this.datasetCounts).reduce((sum, count) => sum + count, 0),
                datasets: { ...this.datasetCounts },
                ai_likelihood: {
                    avg_likelihood: 0,
                    high_ai_count: 0
                }
            };

            this.cachedStats = stats;
            const endTime = performance.now();
            console.log(`Preloaded basic stats in ${(endTime - startTime).toFixed(2)}ms`);
            return stats;
        });

        return this.statsPromises.basic;
    }

    /**
     * Preload everything needed for dataset pages
     */
    async preloadForDatasetPages() {
        const startTime = performance.now();
        
        try {
            // Preload basic stats and dataset counts in parallel
            await Promise.all([
                this.preloadBasicStats(),
                this.preloadDatasetCounts()
            ]);
            
            const endTime = performance.now();
            console.log(`Preloaded dataset page data in ${(endTime - startTime).toFixed(2)}ms`);
            
            return {
                stats: this.cachedStats,
                counts: this.datasetCounts
            };
        } catch (error) {
            console.error('Failed to preload dataset page data:', error);
            return { stats: null, counts: {} };
        }
    }

    /**
     * Progressive preload for index page - load datasets one by one
     */
    async preloadForIndexPage() {
        const startTime = performance.now();
        
        try {
            // First try metadata for instant counts
            const counts = await this.preloadCountsOnly();
            
            // Create basic stats from counts
            const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
            this.cachedStats = {
                total,
                datasets: counts,
                ai_likelihood: {
                    avg_likelihood: 0,
                    high_ai_count: 0
                }
            };
            
            const endTime = performance.now();
            console.log(`Preloaded index page data in ${(endTime - startTime).toFixed(2)}ms`);
            
            return {
                stats: this.cachedStats,
                counts: counts
            };
        } catch (error) {
            console.error('Failed to preload index page data:', error);
            return { stats: null, counts: {} };
        }
    }

    /**
     * Progressive loading - load datasets one by one with callbacks
     */
    async preloadProgressiveWithCallbacks(onProgress = null) {
        const startTime = performance.now();
        const datasetTypes = ['recent_news', 'opinions', 'reporters'];
        const results = [];
        
        try {
            // Load datasets one by one
            for (let i = 0; i < datasetTypes.length; i++) {
                const type = datasetTypes[i];
                console.log(`Loading ${type} dataset...`);
                
                try {
                    const data = await this.loadDataset(type);
                    results.push({ type, data, success: true });
                    
                    // Calculate counts so far
                    const countsSoFar = {};
                    results.forEach(result => {
                        if (result.success) {
                            const validArticles = result.data.filter(a => 
                                !a.prediction || !a.prediction.toLowerCase().includes('error')
                            );
                            countsSoFar[result.type] = validArticles.length;
                        }
                    });
                    
                    // Update cached counts
                    this.datasetCounts = { ...this.datasetCounts, ...countsSoFar };
                    
                    // Call progress callback
                    if (onProgress) {
                        onProgress({
                            loaded: i + 1,
                            total: datasetTypes.length,
                            current: type,
                            progress: ((i + 1) / datasetTypes.length) * 100,
                            counts: countsSoFar,
                            totalArticles: Object.values(countsSoFar).reduce((sum, count) => sum + count, 0)
                        });
                    }
                    
                    console.log(`Loaded ${type}: ${data.length} articles`);
                } catch (error) {
                    console.error(`Failed to load ${type}:`, error);
                    results.push({ type, data: [], success: false, error });
                }
            }
            
            const endTime = performance.now();
            console.log(`Progressive preload completed in ${(endTime - startTime).toFixed(2)}ms`);
            
            return {
                results,
                counts: this.datasetCounts,
                totalTime: endTime - startTime
            };
        } catch (error) {
            console.error('Failed to progressive preload:', error);
            return { results, counts: {}, totalTime: 0 };
        }
    }

    /**
     * Get quick dataset info (counts only, no full data loading)
     */
    async getDatasetInfo() {
        const counts = await this.getDatasetCounts();
        const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
        
        return {
            total,
            datasets: counts,
            summary: {
                recent_news: { count: counts.recent_news || 0, label: 'Recent News' },
                opinions: { count: counts.opinions || 0, label: 'Opinions' },
                reporters: { count: counts.reporters || 0, label: 'Reporters' }
            }
        };
    }

    /**
     * Get dataset count for a specific dataset (very fast)
     */
    async getDatasetCount(datasetType) {
        const counts = await this.getDatasetCounts();
        return counts[datasetType] || 0;
    }

    /**
     * Get counts immediately if available (synchronous)
     */
    getCountsIfReady() {
        if (Object.keys(this.datasetCounts).length > 0) {
            return { ...this.datasetCounts };
        }
        return null;
    }

    /**
     * Load counts from metadata file (instant)
     */
    async loadCountsFromMetadata() {
        try {
            const response = await fetch('/static_data/dataset_counts.json', {
                cache: 'force-cache'
            });
            
            if (response.ok) {
                const metadata = await response.json();
                const counts = {
                    recent_news: metadata.recent_news || 0,
                    opinions: metadata.opinions || 0,
                    reporters: metadata.reporters || 0
                };
                
                this.datasetCounts = counts;
                console.log('Loaded counts from metadata:', counts);
                return counts;
            } else {
                throw new Error('Metadata file not found');
            }
        } catch (error) {
            console.error('Failed to load counts from metadata:', error);
            return null;
        }
    }

    /**
     * Get loading status
     */
    getLoadingStatus() {
        const status = {
            loaded: [],
            loading: [],
            failed: []
        };
        
        Object.keys(this.data).forEach(type => {
            if (this.data[type]) {
                status.loaded.push(type);
            } else if (this.loadPromises[type]) {
                status.loading.push(type);
            }
        });
        
        return status;
    }

    /**
     * Check if basic stats are ready (cached)
     */
    isStatsReady() {
        return this.cachedStats !== null && Object.keys(this.datasetCounts).length > 0;
    }

    /**
     * Get stats immediately if available, otherwise return null
     */
    getStatsIfReady() {
        if (this.isStatsReady()) {
            return this.cachedStats;
        }
        return null;
    }

    /**
     * Wait for stats to be ready (with timeout)
     */
    async waitForStatsReady(timeoutMs = 5000) {
        const startTime = Date.now();
        
        while (Date.now() - startTime < timeoutMs) {
            if (this.isStatsReady()) {
                return this.cachedStats;
            }
            // Wait 50ms before checking again
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        
        throw new Error('Stats not ready within timeout');
    }

    /**
     * Get basic statistics (fast, uses cached data)
     */
    async getBasicStats() {
        if (this.cachedStats) {
            return this.cachedStats;
        }
        return await this.preloadBasicStats();
    }

    /**
     * Get unique authors from specific datasets with optional date filtering
     */
    async getUniqueAuthors(options = {}) {
        const { 
            datasets = ['opinions'], 
            limit = 500,
            startDate = null,
            endDate = null
        } = options;
        
        // Only load specific datasets
        await this.loadSpecificDatasets(datasets);
        const authorSet = new Set();
        
        // Get articles from specified datasets
        const articles = datasets.flatMap(ds => this.data[ds] || []);
        
        articles.forEach(article => {
            // Apply date filter if specified
            if (startDate && article.publish_date && article.publish_date < startDate) return;
            if (endDate && article.publish_date && article.publish_date > endDate) return;
            
            if (article.authors && article.authors.trim() !== '') {
                // Split by comma for multiple authors
                const authors = article.authors.split(',').map(a => a.trim());
                authors.forEach(author => {
                    if (author && author.length > 0) {
                        authorSet.add(author);
                    }
                });
            }
        });
        
        // Convert to array and sort
        const authors = Array.from(authorSet).sort();
        return authors.slice(0, limit);
    }

    /**
     * Get unique newspapers from specific datasets with optional date filtering
     */
    async getUniqueNewspapers(options = {}) {
        const { 
            datasets = ['opinions'], 
            limit = 500,
            startDate = null,
            endDate = null
        } = options;
        
        // Only load specific datasets
        await this.loadSpecificDatasets(datasets);
        const newspaperSet = new Set();
        
        // Get articles from specified datasets
        const articles = datasets.flatMap(ds => this.data[ds] || []);
        
        articles.forEach(article => {
            // Apply date filter if specified
            if (startDate && article.publish_date && article.publish_date < startDate) return;
            if (endDate && article.publish_date && article.publish_date > endDate) return;
            
            const newspaper = article.newspaper || article.newspaper_name;
            if (newspaper && newspaper.trim() !== '') {
                newspaperSet.add(newspaper.trim());
            }
        });
        
        // Convert to array and sort
        const newspapers = Array.from(newspaperSet).sort();
        return newspapers.slice(0, limit);
    }

    /**
     * Get detailed statistics (slower, calculates AI likelihood stats)
     */
    async getDetailedStats() {
        await this.loadAllDatasets();

        const stats = {
            total: 0,
            datasets: {},
            ai_likelihood: {
                avg_likelihood: 0,
                high_ai_count: 0
            }
        };

        let totalLikelihood = 0;
        let likelihoodCount = 0;

        for (const [type, articles] of Object.entries(this.data)) {
            if (articles && articles.length > 0) {
                // Filter out errors
                const validArticles = articles.filter(a => 
                    !a.prediction || !a.prediction.toLowerCase().includes('error')
                );
                
                stats.datasets[type] = validArticles.length;
                stats.total += validArticles.length;

                validArticles.forEach(article => {
                    const likelihood = parseFloat(article.ai_likelihood);
                    if (!isNaN(likelihood)) {
                        totalLikelihood += likelihood;
                        likelihoodCount++;
                        if (likelihood > 0.7) {
                            stats.ai_likelihood.high_ai_count++;
                        }
                    }
                });
            } else {
                stats.datasets[type] = 0;
            }
        }

        stats.ai_likelihood.avg_likelihood = likelihoodCount > 0 
            ? totalLikelihood / likelihoodCount 
            : 0;

        return stats;
    }

    /**
     * Get statistics (backward compatibility - uses basic stats for speed)
     */
    async getStats() {
        return await this.getBasicStats();
    }

    /**
     * Search and filter articles - optimized with lazy loading
     */
    async getArticles(options = {}) {
        const {
            limit = 10,
            offset = 0,
            dataset_type = null,
            search = '',
            newspaper = null,
            topic = null,
            author = null,
            prediction = null,
            start_date = null,
            end_date = null,
            ai_min = null,
            ai_max = null,
            max_ai_min = null,
            max_ai_max = null,
            sort = 'date'
        } = options;

        // Load only specific datasets if filtering by dataset_type
        let articlesToFilter;
        if (dataset_type) {
            articlesToFilter = await this.loadSpecificDatasets([dataset_type]);
        } else {
            // Check if all datasets are already loaded
            if (this.allArticles && this.allArticles.length > 0) {
                console.log('📊 Using cached allArticles for search:', this.allArticles.length);
                articlesToFilter = this.allArticles;
            } else if (this.isLoading) {
                console.log('📊 Background loading in progress, waiting...');
                // Wait for background loading to complete
                await new Promise(resolve => {
                    const checkLoading = () => {
                        if (!this.isLoading && this.allArticles && this.allArticles.length > 0) {
                            resolve();
                        } else {
                            setTimeout(checkLoading, 100);
                        }
                    };
                    checkLoading();
                });
                articlesToFilter = this.allArticles;
            } else {
                console.log('📊 Loading all datasets for search...');
                articlesToFilter = await this.loadAllDatasets();
            }
        }

        // Start with filtered articles
        let filtered = [...articlesToFilter];

        // Filter out errors and apply filters efficiently
        filtered = filtered.filter(a => {
            // Skip error articles
            if (a.prediction && a.prediction.toLowerCase().includes('error')) {
                return false;
            }
            
            // Apply dataset filter
            if (dataset_type && a.dataset_type !== dataset_type) {
                return false;
            }
            
            // Apply search filter
            if (search) {
                const searchLower = search.toLowerCase();
                const newspaperField = a.newspaper || a.newspaper_name || '';
                const articleId = a.article_id || '';
                return (a.title && a.title.toLowerCase().includes(searchLower)) ||
                       (a.text && a.text.toLowerCase().includes(searchLower)) ||
                       (a.authors && a.authors.toLowerCase().includes(searchLower)) ||
                       newspaperField.toLowerCase().includes(searchLower) ||
                       articleId.toLowerCase().includes(searchLower);
            }
            
            // Apply newspaper search filter
            if (newspaper) {
                const newspaperLower = newspaper.toLowerCase();
                const newspaperField = a.newspaper || a.newspaper_name || '';
                const articleId = a.article_id || '';
                // Also search in article_id for domain names (e.g., nytimes.com, washingtonpost.com)
                return newspaperField.toLowerCase().includes(newspaperLower) ||
                       articleId.toLowerCase().includes(newspaperLower);
            }
            
            return true;
        });

        // Apply remaining filters efficiently
        if (topic || author || prediction || start_date || end_date || 
            ai_min !== null || ai_max !== null || max_ai_min !== null || max_ai_max !== null) {
            filtered = filtered.filter(a => {
                if (topic && a.primary_topic !== topic) return false;
                if (author && (!a.authors || !a.authors.toLowerCase().includes(author.toLowerCase()))) return false;
                if (prediction && prediction.length > 0) {
                    // Handle array of predictions (from checkboxes)
                    const normalize = (val) => (val || '').toString().trim();
                    const articleLabelRaw = a.final_prediction || a.prediction || '';
                    const articleLabel = normalize(articleLabelRaw);
                    const articleLower = articleLabel.toLowerCase();
                    
                    // Convert prediction array to lowercase for comparison
                    const predLower = prediction.map(p => normalize(p).toLowerCase());
                    
                    // Check if article's prediction is in the selected list
                    if (!predLower.includes(articleLower)) {
                        return false;
                    }
                }
                if (start_date && (!a.publish_date || a.publish_date < start_date)) return false;
                if (end_date && (!a.publish_date || a.publish_date > end_date)) return false;
                if (ai_min !== null) {
                const likelihood = parseFloat(a.ai_likelihood);
                    if (isNaN(likelihood) || likelihood < ai_min) return false;
        }
        if (ai_max !== null) {
                const likelihood = parseFloat(a.ai_likelihood);
                    if (isNaN(likelihood) || likelihood > ai_max) return false;
        }
        if (max_ai_min !== null) {
                const likelihood = parseFloat(a.max_ai_likelihood);
                    if (isNaN(likelihood) || likelihood < max_ai_min) return false;
        }
        if (max_ai_max !== null) {
                const likelihood = parseFloat(a.max_ai_likelihood);
                    if (isNaN(likelihood) || likelihood > max_ai_max) return false;
                }
                return true;
            });
        }

        // Sort
        if (sort === 'date') {
            filtered.sort((a, b) => {
                const dateA = new Date(a.publish_date || 0);
                const dateB = new Date(b.publish_date || 0);
                return dateB - dateA; // Descending
            });
        } else if (sort === 'ai_likelihood') {
            filtered.sort((a, b) => {
                const likelihoodA = parseFloat(a.ai_likelihood) || 0;
                const likelihoodB = parseFloat(b.ai_likelihood) || 0;
                return likelihoodB - likelihoodA; // Descending
            });
        } else if (sort === 'title') {
            filtered.sort((a, b) => 
                (a.title || '').localeCompare(b.title || '')
            );
        }

        const total = filtered.length;
        const paginatedArticles = filtered.slice(offset, offset + limit);

        // Add text preview
        const articlesWithPreview = paginatedArticles.map(a => ({
            ...a,
            text_preview: a.text ? a.text.substring(0, 300) + '...' : ''
        }));

        return {
            articles: articlesWithPreview,
            total
        };
    }

    /**
     * Get a single article by numeric ID
     * @param {number} articleId - The article ID
     * @param {string} datasetType - Optional dataset type hint to speed up search
     */
    async getArticle(articleId, datasetType = null) {
        const id = parseInt(articleId);
        
        // If dataset type is provided, try that first
        if (datasetType) {
            console.log(`🔍 Searching for article ${id} in ${datasetType} (provided hint)...`);
            await this.loadSpecificDatasets([datasetType]);
            const articles = this.data[datasetType] || [];
            const article = articles.find(a => a.id === id);
            if (article) {
                console.log(`✅ Found article in ${datasetType}`);
                return article;
            }
            console.log(`⚠️ Article not found in ${datasetType}, searching other datasets...`);
        }
        
        // Try to find the article by loading datasets one at a time
        // Start with opinions since that's the default
        const datasetsToTry = ['opinions', 'recent_news', 'reporters']
            .filter(ds => ds !== datasetType); // Skip the one we already tried
        
        for (const dataset of datasetsToTry) {
            console.log(`🔍 Searching for article ${id} in ${dataset}...`);
            await this.loadSpecificDatasets([dataset]);
            const articles = this.data[dataset] || [];
            const article = articles.find(a => a.id === id);
            if (article) {
                console.log(`✅ Found article in ${dataset}`);
                return article;
            }
        }
        
        console.warn(`❌ Article ${id} not found in any dataset`);
        return null;
    }

    /**
     * Get all unique topics
     */
    async getTopics() {
        await this.loadAllDatasets();

        const topicCounts = {};
        
        this.allArticles
            .filter(a => !a.prediction || !a.prediction.toLowerCase().includes('error'))
            .forEach(article => {
                if (article.primary_topic) {
                    topicCounts[article.primary_topic] = 
                        (topicCounts[article.primary_topic] || 0) + 1;
                }
            });

        return Object.entries(topicCounts)
            .map(([topic, count]) => ({ primary_topic: topic, count }))
            .sort((a, b) => b.count - a.count);
    }

    /**
     * Get all unique authors
     */
    async getAuthors() {
        await this.loadAllDatasets();

        const authorCounts = {};
        
        this.allArticles
            .filter(a => !a.prediction || !a.prediction.toLowerCase().includes('error'))
            .forEach(article => {
                if (article.authors) {
                    authorCounts[article.authors] = 
                        (authorCounts[article.authors] || 0) + 1;
                }
            });

        return Object.entries(authorCounts)
            .map(([authors, count]) => ({ authors, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 100);
    }

    /**
     * Get filter options (lightweight version that doesn't load all datasets)
     */
    async getFilterOptions() {
        // Load topics from the currently loaded dataset or load a default dataset
        try {
            // If no dataset is loaded, load the opinions dataset as default
            if (!this.currentDataset) {
                await this.loadDataset('opinions');
            }
            
            // Get topics from the loaded data
            const topics = await this.getTopics();
            
            return {
                topics: topics.map(t => t.primary_topic), // Extract just the topic names
                authors: [], // Will be populated when datasets load
                predictions: ['Human', 'Mixed', 'AI'], // Standard predictions
                datasets: ['recent_news', 'opinions', 'reporters'] // Standard datasets
            };
        } catch (error) {
            console.error('Error loading filter options:', error);
            // Return empty topics on error
            return {
                topics: [],
                authors: [],
                predictions: ['Human', 'Mixed', 'AI'],
                datasets: ['recent_news', 'opinions', 'reporters']
            };
        }
    }

    /**
     * Get full filter options (loads all datasets)
     */
    async getFullFilterOptions() {
        await this.loadAllDatasets();

        const topics = await this.getTopics();
        const authors = await this.getAuthors();

        const predictions = new Set();
        const datasets = new Set();

        this.allArticles
            .filter(a => !a.prediction || !a.prediction.toLowerCase().includes('error'))
            .forEach(article => {
                // Use normalized final prediction for filters
                if (article.final_prediction) predictions.add(article.final_prediction);
                if (article.dataset_type) datasets.add(article.dataset_type);
            });

        // Force prediction ordering: Human, Mixed, AI (only include present ones)
        const orderedPreds = ['Human', 'Mixed', 'AI'].filter(p => predictions.has(p));

        return {
            topics: topics.map(t => t.primary_topic),
            authors: authors.map(a => a.authors),
            predictions: orderedPreds,
            datasets: Array.from(datasets).sort()
        };
    }

    /**
     * Get dataset statistics
     */
    async getDatasetStats(datasetType) {
        const articles = await this.loadDataset(datasetType);
        
        const validArticles = articles.filter(a => 
            !a.prediction || !a.prediction.toLowerCase().includes('error')
        );

        // Prediction distribution
        const predictionDist = {};
        validArticles.forEach(a => {
            const label = a.prediction;
            if (label) {
                predictionDist[label] = (predictionDist[label] || 0) + 1;
            }
        });

        // Time series (monthly) - with dataset-specific windowing
        const timeSeries = {};
        let articlesForTime = validArticles;
        if (datasetType === 'recent_news') {
            const start = new Date('2025-06-01');
            const end = new Date('2025-09-15');
            articlesForTime = validArticles.filter(a => {
                if (!a.publish_date) return false;
                const d = new Date(a.publish_date);
                return d >= start && d <= end;
            });
        }

        articlesForTime.forEach(a => {
            if (a.publish_date) {
                const date = new Date(a.publish_date);
                const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
                
                if (!timeSeries[month]) {
                    timeSeries[month] = { month, total: 0, ai_count: 0, mixed_count: 0 };
                }
                
                timeSeries[month].total++;
                const label = a.final_prediction || this.normalizePrediction(a.prediction);
                if (label === 'AI') timeSeries[month].ai_count++;
                if (label === 'Mixed') timeSeries[month].mixed_count++;
            }
        });

        // Topic distribution
        const topicDist = {};
        validArticles.forEach(a => {
            if (a.primary_topic) {
                topicDist[a.primary_topic] = (topicDist[a.primary_topic] || 0) + 1;
            }
        });

        // Newspaper distribution
        const newspaperDist = {};
        validArticles.forEach(a => {
            const newspaper = a.newspaper || a.newspaper_name || 'Unknown';
            if (newspaper && newspaper.trim() !== '') {
                newspaperDist[newspaper] = (newspaperDist[newspaper] || 0) + 1;
            }
        });

        return {
            dataset_type: datasetType,
            prediction_distribution: Object.entries(predictionDist)
                .map(([prediction, count]) => ({ prediction, count }))
                .sort((a, b) => b.count - a.count),
            time_series: Object.values(timeSeries)
                .sort((a, b) => a.month.localeCompare(b.month)),
            topic_distribution: Object.entries(topicDist)
                .map(([primary_topic, count]) => ({ primary_topic, count }))
                .sort((a, b) => b.count - a.count)
                .slice(0, 15),
            newspaper_distribution: Object.entries(newspaperDist)
                .map(([newspaper, count]) => ({ newspaper, count }))
                .sort((a, b) => b.count - a.count)
                .slice(0, 20)
        };
    }
}

// Create global instance
window.dataLoader = new StaticDataLoader();

// Log version for debugging
console.log('🔄 Data loader version 2025-10-20-v7 - Text truncated, cache busted');

// Auto-preload basic stats for faster initial access (using metadata first)
// Add a small delay to ensure event listeners are set up
setTimeout(() => {
    window.dataLoader.preloadForIndexPage().then(result => {
        console.log('Auto-preload completed:', result);
        // Dispatch a custom event when preloading is complete
        console.log('🚀 Dispatching statsPreloaded event...');
        window.dispatchEvent(new CustomEvent('statsPreloaded', { detail: result }));
        console.log('✅ statsPreloaded event dispatched');
        
        // Skip background progressive loading - we'll load datasets on-demand
        console.log('📊 Datasets will be loaded on-demand (no background preloading)');
    }).catch(error => {
        console.warn('Failed to auto-preload dataset stats:', error);
    });
}, 100); // Small delay to ensure event listeners are ready

// Also expose methods to manually trigger preloading
window.triggerStatsPreload = () => {
    console.log('Manually triggering stats preload...');
    return window.dataLoader.preloadForIndexPage();
};

window.triggerDatasetPreload = () => {
    console.log('Manually triggering dataset preload...');
    return window.dataLoader.preloadForDatasetPages();
};

// Manual cache clear function
window.clearAllCaches = async () => {
    console.log('🧹 Clearing all caches...');
    await window.dataLoader.clearCache();
    
    // Also clear old cache database
    try {
        const deleteReq = indexedDB.deleteDatabase('news-cache-v1');
        deleteReq.onsuccess = () => console.log('✅ Cleared old cache database');
        deleteReq.onerror = () => console.log('⚠️ Old cache database not found');
    } catch (e) {
        console.log('⚠️ Could not clear old cache:', e);
    }
    
    console.log('✅ All caches cleared. Refresh the page to reload data.');
};

// Test the AI+Mixed filter with new checkbox logic
window.testAIMixedFilter = async () => {
    console.log('🧪 Testing AI+Mixed filter with checkboxes...');
    
    // Load a small sample
    const articles = await window.dataLoader.loadSpecificDatasets(['opinions']);
    const sample = articles.slice(0, 100);
    
    console.log('Sample predictions:', [...new Set(sample.map(a => a.prediction))]);
    
    // Test the new filter logic (AI + Mixed)
    const prediction = ['AI', 'Mixed'];
    const filtered = sample.filter(a => {
        const normalize = (val) => (val || '').toString().trim();
        const articleLabelRaw = a.final_prediction || a.prediction || '';
        const articleLabel = normalize(articleLabelRaw);
        const articleLower = articleLabel.toLowerCase();
        
        // Convert prediction array to lowercase for comparison
        const predLower = prediction.map(p => normalize(p).toLowerCase());
        
        // Check if article's prediction is in the selected list
        return predLower.includes(articleLower);
    });
    
    console.log('Filtered predictions:', [...new Set(filtered.map(a => a.prediction))]);
    console.log(`Filtered ${filtered.length} out of ${sample.length} articles`);
    
    return filtered;
};

