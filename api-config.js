// API Configuration Helper
// Automatically uses HTTPS proxy when page is on HTTPS

// Your Vercel proxy URL
const VERCEL_PROXY = 'https://ainewsaudit-github-io.vercel.app/api/proxy';

// Direct HTTP API
const DIRECT_API = 'http://shawshank.cs.umass.edu:8444';

/**
 * Get the API base URL based on current protocol
 * If on HTTPS, use the Vercel proxy
 * If on HTTP, use direct connection
 */
function getApiBase() {
  if (window.location.protocol === 'https:') {
    console.log('🔒 Using HTTPS proxy:', VERCEL_PROXY);
    return VERCEL_PROXY;
  } else {
    console.log('🔓 Using direct HTTP connection:', DIRECT_API);
    return DIRECT_API;
  }
}

/**
 * Build API URL with proxy support
 * @param {string} path - API path (e.g., '/api/articles')
 * @param {object} params - Query parameters
 */
function buildApiUrl(path, params = {}) {
  const base = getApiBase();
  
  if (base === VERCEL_PROXY) {
    // Using proxy - encode the path and params
    const queryString = new URLSearchParams(params).toString();
    const fullPath = queryString ? `${path}?${queryString}` : path;
    return `${VERCEL_PROXY}?path=${encodeURIComponent(fullPath)}`;
  } else {
    // Direct connection
    const queryString = new URLSearchParams(params).toString();
    return queryString ? `${base}${path}?${queryString}` : `${base}${path}`;
  }
}

// Export for use in your pages
window.ApiConfig = {
  getApiBase,
  buildApiUrl,
  VERCEL_PROXY,
  DIRECT_API
};

