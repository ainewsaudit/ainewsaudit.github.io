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
    }

    /** Map raw prediction labels into final normalized categories */
    normalizePrediction(raw) {
        if (!raw) return null;
        const val = String(raw).trim().toLowerCase();
        const human = new Set(['human', 'unlikely ai', 'unlikely_ai']);
        const mixed = new Set(['mixed', 'possibly ai', 'possibly_ai', 'likely ai', 'likely_ai']);
        const ai = new Set(['highly likely ai', 'highly_likely_ai', 'ai']);
        if (human.has(val)) return 'Human';
        if (mixed.has(val)) return 'Mixed';
        if (ai.has(val)) return 'AI';
        return raw; // fallback to original if unknown
    }

    /**
     * Load a dataset from static JSON file
     */
    async loadDataset(datasetType) {
        if (this.data[datasetType]) {
            return this.data[datasetType];
        }

        if (this.loadPromises[datasetType]) {
            return this.loadPromises[datasetType];
        }

        const filename = `${datasetType}_data.json.gz`;
        const url = `/static_data/${filename}`;

        this.loadPromises[datasetType] = fetch(url)
            .then(response => {
                if (!response.ok) {
                    throw new Error(`Failed to load ${filename}: ${response.statusText}`);
                }
                return response.arrayBuffer();
            })
            .then(buffer => {
                // Decompress using pako (gzip)
                const uint8Array = new Uint8Array(buffer);
                let decompressed;
                try {
                    decompressed = pako.ungzip(uint8Array, { to: 'string' });
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
                
                // Normalize and annotate each article
                data.forEach(article => {
                    article.dataset_type = datasetType;

                    // Stable ID
                    if (!article.id) {
                        article.id = article.article_id;
                    }

                    // Normalize numeric fields
                    const toNum = (val) => {
                        const n = typeof val === 'number' ? val : parseFloat(val);
                        return Number.isFinite(n) ? n : null;
                    };
                    article.ai_likelihood = toNum(article.ai_likelihood);
                    article.avg_ai_likelihood = toNum(article.avg_ai_likelihood);
                    article.max_ai_likelihood = toNum(article.max_ai_likelihood);
                    article.fraction_ai_content = toNum(article.fraction_ai_content);

                    // Normalized final prediction
                    article.final_prediction = this.normalizePrediction(article.prediction || article.short_prediction);
                });
                
                this.data[datasetType] = data;
                return data;
            });

        return this.loadPromises[datasetType];
    }

    /**
     * Load all datasets
     */
    async loadAllDatasets() {
        if (this.allArticles) {
            return this.allArticles;
        }

        const [recent_news, opinions, reporters] = await Promise.all([
            this.loadDataset('recent_news'),
            this.loadDataset('opinions'),
            this.loadDataset('reporters')
        ]);

        this.allArticles = [...recent_news, ...opinions, ...reporters];
        return this.allArticles;
    }

    /**
     * Get statistics
     */
    async getStats() {
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
            if (articles) {
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
            }
        }

        stats.ai_likelihood.avg_likelihood = likelihoodCount > 0 
            ? totalLikelihood / likelihoodCount 
            : 0;

        return stats;
    }

    /**
     * Search and filter articles
     */
    async getArticles(options = {}) {
        await this.loadAllDatasets();

        const {
            limit = 10,
            offset = 0,
            dataset_type = null,
            search = '',
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

        // Start with all articles
        let filtered = [...this.allArticles];

        // Filter out errors
        filtered = filtered.filter(a => 
            !a.prediction || !a.prediction.toLowerCase().includes('error')
        );

        // Apply filters
        if (dataset_type) {
            filtered = filtered.filter(a => a.dataset_type === dataset_type);
        }

        if (search) {
            const searchLower = search.toLowerCase();
            filtered = filtered.filter(a => 
                (a.title && a.title.toLowerCase().includes(searchLower)) ||
                (a.text && a.text.toLowerCase().includes(searchLower)) ||
                (a.authors && a.authors.toLowerCase().includes(searchLower))
            );
        }

        if (topic) {
            filtered = filtered.filter(a => a.primary_topic === topic);
        }

        if (author) {
            filtered = filtered.filter(a => 
                a.authors && a.authors.toLowerCase().includes(author.toLowerCase())
            );
        }

        if (prediction) {
            filtered = filtered.filter(a => a.prediction === prediction);
        }

        if (start_date) {
            filtered = filtered.filter(a => 
                a.publish_date && a.publish_date >= start_date
            );
        }

        if (end_date) {
            filtered = filtered.filter(a => 
                a.publish_date && a.publish_date <= end_date
            );
        }

        if (ai_min !== null) {
            filtered = filtered.filter(a => {
                const likelihood = parseFloat(a.ai_likelihood);
                return !isNaN(likelihood) && likelihood >= ai_min;
            });
        }

        if (ai_max !== null) {
            filtered = filtered.filter(a => {
                const likelihood = parseFloat(a.ai_likelihood);
                return !isNaN(likelihood) && likelihood <= ai_max;
            });
        }

        if (max_ai_min !== null) {
            filtered = filtered.filter(a => {
                const likelihood = parseFloat(a.max_ai_likelihood);
                return !isNaN(likelihood) && likelihood >= max_ai_min;
            });
        }

        if (max_ai_max !== null) {
            filtered = filtered.filter(a => {
                const likelihood = parseFloat(a.max_ai_likelihood);
                return !isNaN(likelihood) && likelihood <= max_ai_max;
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
        const articles = filtered.slice(offset, offset + limit);

        // Add text preview
        const articlesWithPreview = articles.map(a => ({
            ...a,
            text_preview: a.text ? a.text.substring(0, 300) + '...' : ''
        }));

        return {
            articles: articlesWithPreview,
            total
        };
    }

    /**
     * Get a single article by ID
     */
    async getArticle(articleId) {
        await this.loadAllDatasets();

        // Search by article_id (URL)
        return this.allArticles.find(a => a.article_id === articleId);
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
     * Get filter options
     */
    async getFilterOptions() {
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
            const label = a.final_prediction || a.prediction;
            if (label) {
                const norm = this.normalizePrediction(label);
                predictionDist[norm] = (predictionDist[norm] || 0) + 1;
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
                .slice(0, 15)
        };
    }
}

// Create global instance
window.dataLoader = new StaticDataLoader();

