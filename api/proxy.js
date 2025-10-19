// HTTPS Proxy for AI News Audit API
// Allows GitHub Pages (HTTPS) to access shawshank API (HTTP)

export default async function handler(req, res) {
  // Only allow GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Get the path from query parameter
  const path = req.query.path || '';
  
  // Construct the backend URL
  const backendUrl = `http://shawshank.cs.umass.edu:8444${path}`;
  
  // Allowlist - only proxy requests to our server
  if (!backendUrl.startsWith('http://shawshank.cs.umass.edu:8444/')) {
    return res.status(403).json({ error: 'Forbidden: Invalid backend URL' });
  }

  try {
    // Forward query parameters
    const url = new URL(backendUrl);
    Object.keys(req.query).forEach(key => {
      if (key !== 'path') {
        url.searchParams.append(key, req.query[key]);
      }
    });

    console.log('Proxying request to:', url.toString());

    // Fetch from backend
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'User-Agent': 'AI-News-Audit-Proxy/1.0'
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({ 
        error: `Backend returned ${response.status}` 
      });
    }

    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    // Disable caching to ensure fresh data
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    
    // Set content type from backend
    const contentType = response.headers.get('content-type');
    if (contentType) {
      res.setHeader('Content-Type', contentType);
    }

    // Return the data
    const data = await response.json();
    return res.status(200).json(data);

  } catch (error) {
    console.error('Proxy error:', error);
    return res.status(500).json({ 
      error: 'Proxy failed', 
      message: error.message 
    });
  }
}

